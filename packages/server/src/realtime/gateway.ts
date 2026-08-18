import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  AgentMeshError,
  CloseCode,
  ClientFrameType,
  ErrorCode,
  HEARTBEAT,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  Permission,
  ServerFrameType,
  clientFrameSchema,
  isSupportedProtocolVersion,
  type ClientFrame,
  type Event,
  type Identity,
  type SessionSnapshot,
} from '@agentmesh/protocol';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import { principalActor, type Principal, type SessionAccess } from '../auth/principal.js';
import type { Services } from '../container.js';
import { resolveToken } from '../http/auth.js';
import { IdPrefix, newId } from '../ids.js';
import { SERVER_VERSION } from '../version.js';
import type { HubConnection } from './hub.js';

/** How far behind a client may be before a full refetch beats a replay. */
const MAX_REPLAY_EVENTS = 500;

/** A connection that never says `hello` is dropped. */
const HELLO_TIMEOUT_MS = 10_000;

class Connection implements HubConnection {
  readonly id = newId(IdPrefix.Frame);
  readonly subscriptions = new Set<string>();
  principal!: Principal;
  authenticated = false;
  alive = true;

  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    readonly socket: WebSocket,
    private readonly framesPerSecond: number,
  ) {
    this.tokens = framesPerSecond;
  }

  /** Token bucket: a steady `framesPerSecond` with a one-second burst. */
  takeToken(): boolean {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.lastRefill = now;
    this.tokens = Math.min(this.framesPerSecond * 2, this.tokens + elapsed * this.framesPerSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  send(frame: { type: string; payload?: unknown }, id?: string): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        id: id ?? newId(IdPrefix.Frame),
        type: frame.type,
        ts: new Date().toISOString(),
        payload: frame.payload ?? {},
      }),
    );
  }

  sendError(error: AgentMeshError, ref?: string): void {
    this.send({ type: ServerFrameType.Error, payload: { ...error.toBody(), ...(ref ? { ref } : {}) } });
  }

  close(code: number, reason: string): void {
    try {
      this.socket.close(code, reason.slice(0, 120));
    } catch {
      this.socket.terminate();
    }
  }
}

export interface Gateway {
  close(): Promise<void>;
}

/**
 * The realtime half of AgentMesh.
 *
 * One websocket carries any number of session subscriptions, which is what lets
 * the web client keep unread counts for every session without opening a socket
 * per session. Agents subscribe to exactly one — the session their token was
 * minted for.
 */
export function attachGateway(server: Server, services: Services, log: FastifyBaseLogger): Gateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: PROTOCOL_LIMITS.frameBytes });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const connection = new Connection(socket, services.config.rateLimit.wsFramesPerSecond);
    connectionsBySocket.set(socket, connection);

    // Authentication happens in the first frame, not in the URL: query strings
    // end up in proxy logs, browser history and error reports.
    const helloTimer = setTimeout(() => {
      if (!connection.authenticated) {
        connection.sendError(new AgentMeshError(ErrorCode.Unauthorized, 'No hello frame received.'));
        connection.close(CloseCode.Unauthorized, 'hello timeout');
      }
    }, HELLO_TIMEOUT_MS);

    socket.on('pong', () => {
      connection.alive = true;
    });

    socket.on('message', (raw: Buffer | string) => {
      void handleMessage(connection, raw, services, log).catch((error: unknown) => {
        log.error({ err: error }, 'websocket frame handling failed');
      });
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      void handleClose(connection, services, log);
    });

    socket.on('error', (error: Error) => {
      log.debug({ err: error, remote: request.socket.remoteAddress }, 'websocket error');
    });
  });

  // Liveness: a socket that misses a ping/pong round trip is gone, whatever TCP
  // believes. Presence in AgentMesh is only as honest as this loop.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const connection = connectionsBySocket.get(socket);
      if (!connection) {
        socket.terminate();
        continue;
      }
      if (!connection.alive) {
        connection.close(CloseCode.HeartbeatTimeout, 'heartbeat timeout');
        continue;
      }
      connection.alive = false;
      try {
        socket.ping();
      } catch {
        connection.close(CloseCode.HeartbeatTimeout, 'ping failed');
      }
    }
  }, HEARTBEAT.intervalMs);
  heartbeat.unref?.();

  return {
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of wss.clients) socket.close(CloseCode.GoingAway, 'server shutting down');
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

const connectionsBySocket = new WeakMap<WebSocket, Connection>();

async function handleMessage(
  connection: Connection,
  raw: Buffer | string,
  services: Services,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!connection.takeToken()) {
    connection.sendError(new AgentMeshError(ErrorCode.RateLimited, 'Too many frames.'));
    connection.close(CloseCode.RateLimited, 'rate limited');
    return;
  }

  let parsed: ClientFrame;
  let frameId = 'unknown';
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const json: unknown = JSON.parse(text);
    frameId = typeof (json as { id?: unknown }).id === 'string' ? (json as { id: string }).id : 'unknown';

    const version = (json as { v?: unknown }).v;
    if (typeof version !== 'string' || !isSupportedProtocolVersion(version)) {
      connection.sendError(
        new AgentMeshError(
          ErrorCode.ProtocolVersionUnsupported,
          `This server speaks ${PROTOCOL_VERSION}. Received: ${String(version)}.`,
        ),
        frameId,
      );
      connection.close(CloseCode.UnsupportedVersion, 'unsupported protocol version');
      return;
    }

    parsed = clientFrameSchema.parse(json);
  } catch (error) {
    connection.sendError(
      new AgentMeshError(ErrorCode.MalformedFrame, 'Frame could not be parsed.', {
        details: error instanceof Error ? error.message : undefined,
      }),
      frameId,
    );
    return;
  }

  try {
    if (parsed.type === ClientFrameType.Hello) {
      await handleHello(connection, parsed, services, log);
      return;
    }
    if (!connection.authenticated) {
      throw new AgentMeshError(ErrorCode.Unauthorized, 'Send a hello frame first.');
    }
    await dispatch(connection, parsed, services);
  } catch (error) {
    if (error instanceof AgentMeshError) {
      connection.sendError(error, parsed.id);
    } else {
      log.error({ err: error }, 'websocket command failed');
      connection.sendError(new AgentMeshError(ErrorCode.Internal, 'Internal server error.'), parsed.id);
    }
  }
}

async function handleHello(
  connection: Connection,
  frame: Extract<ClientFrame, { type: 'hello' }>,
  services: Services,
  log: FastifyBaseLogger,
): Promise<void> {
  if (connection.authenticated) {
    connection.sendError(new AgentMeshError(ErrorCode.Conflict, 'Already authenticated.'), frame.id);
    return;
  }

  let principal: Principal;
  try {
    principal = await resolveToken(services, frame.payload.token);
  } catch (error) {
    const failure =
      error instanceof AgentMeshError
        ? error
        : new AgentMeshError(ErrorCode.Unauthorized, 'Authentication failed.');
    connection.sendError(failure, frame.id);
    connection.close(CloseCode.Unauthorized, failure.code);
    return;
  }

  connection.principal = principal;
  connection.authenticated = true;
  services.hub.add(connection);

  const identity: Identity =
    principal.kind === 'user'
      ? { kind: 'user', userId: principal.userId, displayName: principal.displayName }
      : { kind: 'agent', agentId: principal.agentId, sessionId: principal.sessionId, name: principal.name };

  connection.send(
    {
      type: ServerFrameType.HelloOk,
      payload: {
        protocol: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
        heartbeatIntervalMs: HEARTBEAT.intervalMs,
        identity,
      },
    },
    frame.id,
  );

  // An agent token names its session, so there is nothing to choose: subscribe
  // it immediately and let the session see it come online.
  if (principal.kind === 'agent') {
    try {
      await subscribe(connection, principal.sessionId, undefined, services);
    } catch (error) {
      log.warn({ err: error }, 'agent auto-subscribe failed');
    }
  }
}

async function dispatch(connection: Connection, frame: ClientFrame, services: Services): Promise<void> {
  const principal = connection.principal;

  switch (frame.type) {
    case ClientFrameType.Ping: {
      connection.send({ type: ServerFrameType.Pong }, frame.id);
      return;
    }

    case ClientFrameType.Subscribe: {
      await subscribe(connection, frame.payload.sessionId, frame.payload.sinceSeq, services, frame.id);
      return;
    }

    case ClientFrameType.Unsubscribe: {
      const sessionId = frame.payload.sessionId;
      services.hub.unsubscribe(connection, sessionId);
      connection.send({ type: ServerFrameType.Unsubscribed, payload: { sessionId } }, frame.id);
      await announcePresence(connection, sessionId, services);
      return;
    }

    case ClientFrameType.MessageSend: {
      const access = await requireSubscribed(connection, frame.payload.sessionId, services, Permission.WriteMessage);
      const message = await services.messages.create(access, {
        body: frame.payload.body,
        ...(frame.payload.mentions ? { mentions: frame.payload.mentions } : {}),
        ...(frame.payload.parentId !== undefined ? { parentId: frame.payload.parentId } : {}),
      });
      connection.send(
        { type: ServerFrameType.Ack, payload: { ref: frame.id, seq: message.seq, resourceId: message.id } },
        frame.id,
      );
      return;
    }

    case ClientFrameType.TaskCreate: {
      const access = await requireSubscribed(connection, frame.payload.sessionId, services, Permission.ManageTask);
      const { sessionId: _ignored, ...input } = frame.payload;
      const task = await services.tasks.create(access, input);
      connection.send(
        { type: ServerFrameType.Ack, payload: { ref: frame.id, resourceId: task.id } },
        frame.id,
      );
      return;
    }

    case ClientFrameType.TaskUpdate: {
      const access = await requireSubscribed(connection, frame.payload.sessionId, services, Permission.ManageTask);
      const { sessionId: _ignored, taskId, ...input } = frame.payload;
      const task = await services.tasks.update(access, taskId, input);
      connection.send(
        { type: ServerFrameType.Ack, payload: { ref: frame.id, resourceId: task.id } },
        frame.id,
      );
      return;
    }

    case ClientFrameType.ContextPublish: {
      const access = await requireSubscribed(connection, frame.payload.sessionId, services, Permission.WriteContext);
      const { sessionId: _ignored, ...input } = frame.payload;
      const entry = await services.context.publish(access, input);
      connection.send(
        { type: ServerFrameType.Ack, payload: { ref: frame.id, resourceId: entry.id } },
        frame.id,
      );
      return;
    }

    case ClientFrameType.EventPublish: {
      const access = await requireSubscribed(connection, frame.payload.sessionId, services, Permission.PublishEvent);
      const event = await services.devEvents.publish(access, frame.payload.type, frame.payload.payload);
      connection.send(
        { type: ServerFrameType.Ack, payload: { ref: frame.id, seq: event.seq, resourceId: event.id } },
        frame.id,
      );
      return;
    }

    case ClientFrameType.AgentStatus: {
      if (principal.kind !== 'agent') {
        throw new AgentMeshError(ErrorCode.Forbidden, 'Only agents report their own status.');
      }
      const access = await requireSubscribed(connection, frame.payload.sessionId, services);
      await services.agents.reportStatus(
        access,
        principal.agentId,
        frame.payload.status,
        frame.payload.note,
      );
      connection.send({ type: ServerFrameType.Ack, payload: { ref: frame.id } }, frame.id);
      return;
    }

    case ClientFrameType.Typing: {
      const sessionId = frame.payload.sessionId;
      if (!connection.subscriptions.has(sessionId)) return;
      // Typing indicators are ephemeral by design: never logged, never stored.
      services.hub.broadcast(
        sessionId,
        {
          type: ServerFrameType.Typing,
          payload: { sessionId, actor: principalActor(principal), active: frame.payload.active },
        },
        connection.id,
      );
      return;
    }

    default:
      throw new AgentMeshError(ErrorCode.MalformedFrame, `Unsupported frame type.`);
  }
}

async function subscribe(
  connection: Connection,
  sessionId: string,
  sinceSeq: number | undefined,
  services: Services,
  ref?: string,
): Promise<void> {
  const access = await services.access.require(connection.principal, sessionId);
  const wasOnline = services.hub.isOnline(sessionId, access.actor);
  services.hub.subscribe(connection, sessionId);

  const [session, members, agents, openTasks] = await Promise.all([
    services.access.loadSession(sessionId),
    services.sessions.members(sessionId),
    services.sessions.agents(sessionId),
    services.tasks.listOpen(sessionId),
  ]);

  const snapshot: SessionSnapshot = { session, members, agents, openTasks, lastSeq: session.lastSeq };

  // Resume where the client left off. Past a certain gap, replaying the log is
  // slower than refetching the current state, so ask the client to resync.
  let replayed: Event[] = [];
  if (sinceSeq !== undefined) {
    if (session.lastSeq - sinceSeq > MAX_REPLAY_EVENTS) {
      connection.send(
        {
          type: ServerFrameType.Resync,
          payload: { sessionId, lastSeq: session.lastSeq, reason: 'too far behind' },
        },
        ref,
      );
    } else {
      replayed = await services.log.since(sessionId, sinceSeq, MAX_REPLAY_EVENTS);
    }
  }

  connection.send({ type: ServerFrameType.Subscribed, payload: { sessionId, snapshot, replayed } }, ref);

  if (!wasOnline) {
    if (connection.principal.kind === 'agent') {
      await services.agents.markPresence(
        sessionId,
        { id: connection.principal.agentId, name: connection.principal.name },
        true,
      );
    }
    services.hub.broadcast(sessionId, {
      type: ServerFrameType.Presence,
      payload: { sessionId, actor: access.actor, online: true },
    });
  }
}

/**
 * Realtime writes require an active subscription. Without that rule a client
 * could write into a session it is not watching and never see the result —
 * a reliable source of "my message vanished" bug reports.
 */
async function requireSubscribed(
  connection: Connection,
  sessionId: string,
  services: Services,
  permission?: Permission,
): Promise<SessionAccess> {
  if (!connection.subscriptions.has(sessionId)) {
    throw new AgentMeshError(ErrorCode.NotSubscribed, 'Subscribe to the session before writing to it.');
  }
  const access = await services.access.require(connection.principal, sessionId);
  if (permission) services.access.requirePermission(access, permission);
  return access;
}

async function handleClose(connection: Connection, services: Services, log: FastifyBaseLogger): Promise<void> {
  if (!connection.authenticated) return;
  const sessions = [...connection.subscriptions];
  services.hub.remove(connection.id);

  for (const sessionId of sessions) {
    try {
      await announcePresence(connection, sessionId, services);
    } catch (error) {
      log.warn({ err: error, sessionId }, 'failed to announce disconnect');
    }
  }
}

/** Announce that a participant went offline, unless another socket keeps them on. */
async function announcePresence(connection: Connection, sessionId: string, services: Services): Promise<void> {
  const actor = principalActor(connection.principal);
  if (services.hub.isOnline(sessionId, actor)) return;

  if (connection.principal.kind === 'agent') {
    await services.agents.markPresence(
      sessionId,
      { id: connection.principal.agentId, name: connection.principal.name },
      false,
      'connection closed',
    );
  }
  services.hub.broadcast(sessionId, {
    type: ServerFrameType.Presence,
    payload: { sessionId, actor, online: false },
  });
}
