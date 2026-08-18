import {
  AgentMeshError,
  ClientFrameType,
  ErrorCode,
  HEARTBEAT,
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
import { principalActor, type Principal, type SessionAccess } from '../auth/principal.js';
import type { Services } from '../container.js';
import { resolveToken } from '../http/auth.js';
import { SERVER_VERSION } from '../version.js';
import type { ConnectionHandle } from './registry.js';

/** How far behind a client may be before a full refetch beats a replay. */
export const MAX_REPLAY_EVENTS = 500;

/**
 * Everything a client can ask for over the realtime channel, written once and
 * driven by two transports: a websocket this process owns, and API Gateway
 * events on Lambda. Keeping it here is what stops the two deployments drifting
 * into subtly different protocols.
 */

export function parseFrame(raw: string): { frame?: ClientFrame; error?: AgentMeshError; id: string } {
  let json: unknown;
  let id = 'unknown';
  try {
    json = JSON.parse(raw);
  } catch {
    return { error: new AgentMeshError(ErrorCode.MalformedFrame, 'Frame is not valid JSON.'), id };
  }

  if (typeof (json as { id?: unknown }).id === 'string') id = (json as { id: string }).id;

  const version = (json as { v?: unknown }).v;
  if (typeof version !== 'string' || !isSupportedProtocolVersion(version)) {
    return {
      error: new AgentMeshError(
        ErrorCode.ProtocolVersionUnsupported,
        `This server speaks ${PROTOCOL_VERSION}. Received: ${String(version)}.`,
      ),
      id,
    };
  }

  const parsed = clientFrameSchema.safeParse(json);
  if (!parsed.success) {
    return {
      error: new AgentMeshError(ErrorCode.MalformedFrame, 'Frame does not match the protocol schema.', {
        details: parsed.error.issues.slice(0, 5),
      }),
      id,
    };
  }
  return { frame: parsed.data, id };
}

export async function authenticate(services: Services, token: string): Promise<Principal> {
  return resolveToken(services, token);
}

export function identityOf(principal: Principal): Identity {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId, displayName: principal.displayName }
    : { kind: 'agent', agentId: principal.agentId, sessionId: principal.sessionId, name: principal.name };
}

export function helloOkPayload(principal: Principal) {
  return {
    protocol: PROTOCOL_VERSION,
    serverVersion: SERVER_VERSION,
    heartbeatIntervalMs: HEARTBEAT.intervalMs,
    identity: identityOf(principal),
  };
}

/**
 * Subscribe a connection to a session: check access, send the snapshot, replay
 * anything missed, and announce presence if this is the participant's first
 * live connection.
 */
export async function subscribeToSession(
  services: Services,
  connection: ConnectionHandle,
  sessionId: string,
  sinceSeq: number | undefined,
  ref?: string,
): Promise<void> {
  const access = await services.access.require(connection.principal, sessionId);
  const wasOnline = await services.registry.isOnline(sessionId, access.actor);

  await services.registry.subscribe(connection.id, sessionId);
  connection.subscriptions.add(sessionId);

  const [session, members, agents, openTasks] = await Promise.all([
    services.access.loadSession(sessionId),
    services.sessions.members(sessionId),
    services.sessions.agents(sessionId),
    services.tasks.listOpen(sessionId),
  ]);

  const snapshot: SessionSnapshot = { session, members, agents, openTasks, lastSeq: session.lastSeq };

  // Resume where the client left off. Past a certain gap, replaying the log is
  // slower than refetching current state, so ask the client to resync.
  let replayed: Event[] = [];
  if (sinceSeq !== undefined) {
    if (session.lastSeq - sinceSeq > MAX_REPLAY_EVENTS) {
      await connection.send(
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

  await connection.send({ type: ServerFrameType.Subscribed, payload: { sessionId, snapshot, replayed } }, ref);

  if (!wasOnline) {
    if (connection.principal.kind === 'agent') {
      await services.agents.markPresence(
        sessionId,
        { id: connection.principal.agentId, name: connection.principal.name },
        true,
      );
    }
    await services.registry.broadcast(sessionId, {
      type: ServerFrameType.Presence,
      payload: { sessionId, actor: access.actor, online: true },
    });
  }
}

/** Announce that a participant went offline, unless another connection keeps them on. */
export async function announcePresenceLeft(
  services: Services,
  principal: Principal,
  sessionId: string,
): Promise<void> {
  const actor = principalActor(principal);
  if (await services.registry.isOnline(sessionId, actor)) return;

  if (principal.kind === 'agent') {
    await services.agents.markPresence(
      sessionId,
      { id: principal.agentId, name: principal.name },
      false,
      'connection closed',
    );
  }
  await services.registry.broadcast(sessionId, {
    type: ServerFrameType.Presence,
    payload: { sessionId, actor, online: false },
  });
}

/**
 * Realtime writes require an active subscription. Without that rule a client
 * could write into a session it is not watching and never see the result - a
 * reliable source of "my message vanished" bug reports.
 */
async function requireSubscribed(
  services: Services,
  connection: ConnectionHandle,
  sessionId: string,
  permission?: Permission,
): Promise<SessionAccess> {
  const subscribed =
    connection.subscriptions.has(sessionId) ||
    (await services.registry.isSubscribed(connection.id, sessionId));
  if (!subscribed) {
    throw new AgentMeshError(ErrorCode.NotSubscribed, 'Subscribe to the session before writing to it.');
  }
  const access = await services.access.require(connection.principal, sessionId);
  if (permission) services.access.requirePermission(access, permission);
  return access;
}

/** Handle every frame except `hello`, which each transport establishes itself. */
export async function dispatchCommand(
  services: Services,
  connection: ConnectionHandle,
  frame: ClientFrame,
): Promise<void> {
  const principal = connection.principal;
  const ack = (payload: Record<string, unknown>) =>
    connection.send({ type: ServerFrameType.Ack, payload: { ref: frame.id, ...payload } }, frame.id);

  switch (frame.type) {
    case ClientFrameType.Hello:
      throw new AgentMeshError(ErrorCode.Conflict, 'Already authenticated.');

    case ClientFrameType.Ping:
      await connection.send({ type: ServerFrameType.Pong }, frame.id);
      return;

    case ClientFrameType.Subscribe:
      await subscribeToSession(
        services,
        connection,
        frame.payload.sessionId,
        frame.payload.sinceSeq,
        frame.id,
      );
      return;

    case ClientFrameType.Unsubscribe: {
      const sessionId = frame.payload.sessionId;
      await services.registry.unsubscribe(connection.id, sessionId);
      connection.subscriptions.delete(sessionId);
      await connection.send({ type: ServerFrameType.Unsubscribed, payload: { sessionId } }, frame.id);
      await announcePresenceLeft(services, principal, sessionId);
      return;
    }

    case ClientFrameType.MessageSend: {
      const access = await requireSubscribed(
        services,
        connection,
        frame.payload.sessionId,
        Permission.WriteMessage,
      );
      const message = await services.messages.create(access, {
        body: frame.payload.body,
        ...(frame.payload.mentions ? { mentions: frame.payload.mentions } : {}),
        ...(frame.payload.parentId !== undefined ? { parentId: frame.payload.parentId } : {}),
      });
      await ack({ seq: message.seq, resourceId: message.id });
      return;
    }

    case ClientFrameType.TaskCreate: {
      const access = await requireSubscribed(
        services,
        connection,
        frame.payload.sessionId,
        Permission.ManageTask,
      );
      const { sessionId: _ignored, ...input } = frame.payload;
      const task = await services.tasks.create(access, input);
      await ack({ resourceId: task.id });
      return;
    }

    case ClientFrameType.TaskUpdate: {
      const access = await requireSubscribed(
        services,
        connection,
        frame.payload.sessionId,
        Permission.ManageTask,
      );
      const { sessionId: _ignored, taskId, ...input } = frame.payload;
      const task = await services.tasks.update(access, taskId, input);
      await ack({ resourceId: task.id });
      return;
    }

    case ClientFrameType.ContextPublish: {
      const access = await requireSubscribed(
        services,
        connection,
        frame.payload.sessionId,
        Permission.WriteContext,
      );
      const { sessionId: _ignored, ...input } = frame.payload;
      const entry = await services.context.publish(access, input);
      await ack({ resourceId: entry.id });
      return;
    }

    case ClientFrameType.EventPublish: {
      const access = await requireSubscribed(
        services,
        connection,
        frame.payload.sessionId,
        Permission.PublishEvent,
      );
      const event = await services.devEvents.publish(access, frame.payload.type, frame.payload.payload);
      await ack({ seq: event.seq, resourceId: event.id });
      return;
    }

    case ClientFrameType.AgentStatus: {
      if (principal.kind !== 'agent') {
        throw new AgentMeshError(ErrorCode.Forbidden, 'Only agents report their own status.');
      }
      const access = await requireSubscribed(services, connection, frame.payload.sessionId);
      await services.agents.reportStatus(access, principal.agentId, frame.payload.status, frame.payload.note);
      await ack({});
      return;
    }

    case ClientFrameType.Typing: {
      const sessionId = frame.payload.sessionId;
      const subscribed =
        connection.subscriptions.has(sessionId) ||
        (await services.registry.isSubscribed(connection.id, sessionId));
      if (!subscribed) return;
      // Typing indicators are ephemeral by design: never logged, never stored.
      await services.registry.broadcast(
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
      throw new AgentMeshError(ErrorCode.MalformedFrame, 'Unsupported frame type.');
  }
}
