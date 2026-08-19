import {
  ApiGatewayManagementApiClient,
  DeleteConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  AgentMeshError,
  ClientFrameType,
  ErrorCode,
  PROTOCOL_VERSION,
  ServerFrameType,
} from '@agentmesh/protocol';
import type { Principal } from '../auth/principal.js';
import {
  announcePresenceLeft,
  authenticate,
  dispatchCommand,
  helloOkPayload,
  parseFrame,
  subscribeToSession,
} from '../realtime/commands.js';
import type { ConnectionHandle } from '../realtime/registry.js';
import { registry, services, setFrameSender } from './runtime.js';

interface WebSocketEvent {
  requestContext: {
    connectionId: string;
    routeKey: string;
    domainName: string;
    stage: string;
  };
  body?: string;
}

/**
 * Realtime handler for the serverless deployment.
 *
 * API Gateway owns the socket; this function is created and destroyed around
 * every frame. So the two things the in-process gateway keeps in memory - who
 * is connected and what they subscribe to - are read from PostgreSQL instead,
 * and sending a frame is an HTTP call to the management API rather than a
 * method on a socket. The frame handling itself is the same code as the
 * self-hosted server: see `realtime/commands.ts`.
 */
export const handler = async (event: WebSocketEvent): Promise<{ statusCode: number; body?: string }> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  // The management endpoint is normally derived from the event, but a custom
  // domain on the WebSocket API changes it, so allow it to be set explicitly.
  const endpoint = process.env.REALTIME_MANAGEMENT_ENDPOINT ?? `https://${domainName}/${stage}`;

  const client = new ApiGatewayManagementApiClient({ endpoint });

  setFrameSender(endpoint, async (target, frame) => {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: target,
          Data: Buffer.from(JSON.stringify(frame), 'utf8'),
        }),
      );
      return true;
    } catch (error) {
      // 410 Gone means the client disappeared without a $disconnect. The
      // caller drops the record; anything else is a real failure to log.
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status !== 410) console.error('PostToConnection failed', status, (error as Error).message);
      return false;
    }
  });

  const send = async (frame: { type: string; payload?: unknown }, id?: string) => {
    await postFrame(client, connectionId, {
      v: PROTOCOL_VERSION,
      id: id ?? `s${Date.now().toString(36)}`,
      type: frame.type,
      ts: new Date().toISOString(),
      payload: frame.payload ?? {},
    });
  };

  try {
    switch (routeKey) {
      case '$connect':
        // $disconnect is not guaranteed to arrive, so rows outlive their
        // sockets and show people as present who left. Sweeping here costs one
        // indexed DELETE at the only moment that is already slow anyway, and
        // avoids a scheduled Lambda that would bill for doing nothing.
        await registry()
          .sweepStale()
          .catch(() => 0);

        // Authentication happens in the first `hello` frame, not here: API
        // Gateway would only give us query strings and headers, and a token in
        // a query string ends up in access logs.
        return { statusCode: 200 };

      case '$disconnect':
        await handleDisconnect(connectionId);
        return { statusCode: 200 };

      default:
        await handleFrame(connectionId, event.body ?? '', send, client);
        return { statusCode: 200 };
    }
  } catch (error) {
    console.error('websocket handler failed', error);
    // Answering 200 keeps API Gateway from closing an otherwise healthy
    // connection; the client already received an error frame.
    return { statusCode: 200 };
  }
};

async function handleFrame(
  connectionId: string,
  body: string,
  send: ConnectionHandle['send'],
  client: ApiGatewayManagementApiClient,
): Promise<void> {
  const svc = services();
  const { frame, error, id } = parseFrame(body);

  if (error || !frame) {
    await send(
      { type: ServerFrameType.Error, payload: { ...(error ?? new AgentMeshError(ErrorCode.MalformedFrame, 'Bad frame')).toBody(), ref: id } },
      id,
    );
    return;
  }

  if (frame.type === ClientFrameType.Hello) {
    let principal: Principal;
    try {
      principal = await authenticate(svc, frame.payload.token);
    } catch (caught) {
      const failure =
        caught instanceof AgentMeshError
          ? caught
          : new AgentMeshError(ErrorCode.Unauthorized, 'Authentication failed.');
      await send({ type: ServerFrameType.Error, payload: { ...failure.toBody(), ref: frame.id } }, frame.id);
      await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId })).catch(() => undefined);
      return;
    }

    const connection = makeHandle(connectionId, principal, new Set(), send, client);
    await svc.registry.add(connection);
    await send({ type: ServerFrameType.HelloOk, payload: helloOkPayload(principal) }, frame.id);

    // An agent token names its session, so subscribe it straight away.
    if (principal.kind === 'agent') {
      await subscribeToSession(svc, connection, principal.sessionId, undefined);
    }
    return;
  }

  const record = await svc.registry.get(connectionId);
  if (!record) {
    await send(
      {
        type: ServerFrameType.Error,
        payload: { code: ErrorCode.Unauthorized, message: 'Send a hello frame first.', ref: frame.id },
      },
      frame.id,
    );
    return;
  }

  // Liveness: $disconnect is not guaranteed to arrive, so presence is based on
  // when a connection was last heard from.
  await registry().touch(connectionId);

  const connection = makeHandle(connectionId, record.principal, record.subscriptions, send, client);
  try {
    await dispatchCommand(svc, connection, frame);
  } catch (caught) {
    const failure =
      caught instanceof AgentMeshError ? caught : new AgentMeshError(ErrorCode.Internal, 'Internal server error.');
    if (!(caught instanceof AgentMeshError)) console.error('command failed', caught);
    await send({ type: ServerFrameType.Error, payload: { ...failure.toBody(), ref: frame.id } }, frame.id);
  }
}

async function handleDisconnect(connectionId: string): Promise<void> {
  const svc = services();
  const record = await svc.registry.remove(connectionId);
  if (!record) return;

  for (const sessionId of record.subscriptions) {
    await announcePresenceLeft(svc, record.principal, sessionId);
  }
}

function makeHandle(
  connectionId: string,
  principal: Principal,
  subscriptions: Set<string>,
  send: ConnectionHandle['send'],
  client: ApiGatewayManagementApiClient,
): ConnectionHandle {
  return {
    id: connectionId,
    principal,
    subscriptions,
    send,
    close: async () => {
      await client.send(new DeleteConnectionCommand({ ConnectionId: connectionId })).catch(() => undefined);
    },
  };
}

async function postFrame(
  client: ApiGatewayManagementApiClient,
  connectionId: string,
  frame: unknown,
): Promise<void> {
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(frame), 'utf8'),
      }),
    );
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 410) {
      await services().registry.remove(connectionId);
      return;
    }
    throw error;
  }
}
