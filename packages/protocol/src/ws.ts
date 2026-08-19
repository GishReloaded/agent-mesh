import { z } from 'zod';
import { agentSchema, sessionMemberSchema, sessionSchema, taskSchema } from './entities.js';
import { errorBodySchema } from './errors.js';
import { eventSchema, eventTypeSchema } from './events.js';
import {
  actorSchema,
  agentStatusSchema,
  contextKindSchema,
  fileRefSchema,
  idSchema,
  mentionSchema,
  seqSchema,
  taskStatusSchema,
  timestampSchema,
} from './primitives.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * Every websocket frame shares one envelope:
 *
 * ```json
 * { "v": "agentmesh/v1", "id": "01J...", "type": "message.send", "ts": "...", "payload": {} }
 * ```
 *
 * `id` is chosen by the sender and is echoed back in `ack` / `error` frames, so
 * a client can correlate a response with its request and deduplicate retries
 * after a reconnect.
 */
export const frameEnvelopeSchema = z.object({
  v: z.string(),
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(64),
  ts: timestampSchema.optional(),
  payload: z.unknown(),
});
export type FrameEnvelope = z.infer<typeof frameEnvelopeSchema>;

function frame<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({
    v: z.string(),
    id: z.string().min(1).max(64),
    type: z.literal(type),
    ts: timestampSchema.optional(),
    payload,
  });
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export const ClientFrameType = {
  Hello: 'hello',
  Subscribe: 'subscribe',
  Unsubscribe: 'unsubscribe',
  Ping: 'ping',
  MessageSend: 'message.send',
  TaskCreate: 'task.create',
  TaskUpdate: 'task.update',
  ContextPublish: 'context.publish',
  EventPublish: 'event.publish',
  AgentStatus: 'agent.status',
  Typing: 'typing',
} as const;
export type ClientFrameType = (typeof ClientFrameType)[keyof typeof ClientFrameType];

export const helloPayloadSchema = z.object({
  /**
   * Access token. Humans send their JWT access token; agents send the opaque
   * session-scoped agent token issued at registration.
   *
   * The token travels in the first frame rather than in the URL so it never
   * lands in proxy or server access logs.
   */
  token: z.string().min(1).max(4096),
  client: z
    .object({
      /** Free-form client label, e.g. "agentmesh-cli/0.1.0" or "web". */
      name: z.string().max(120).optional(),
      version: z.string().max(40).optional(),
    })
    .optional(),
});

export const subscribePayloadSchema = z.object({
  sessionId: idSchema,
  /**
   * Last sequence number the client already applied. The server replays
   * everything after it, or answers with `resync` when the gap is too large.
   */
  sinceSeq: seqSchema.optional(),
});

export const messageSendPayloadSchema = z.object({
  sessionId: idSchema,
  body: z.string().min(1),
  mentions: z.array(mentionSchema).max(50).optional(),
  parentId: idSchema.nullable().optional(),
});

export const taskCreatePayloadSchema = z.object({
  sessionId: idSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  status: taskStatusSchema.optional(),
  assignee: z.object({ type: z.enum(['user', 'agent']), id: idSchema }).nullable().optional(),
  relatedFiles: z.array(fileRefSchema).max(200).optional(),
  relatedCommits: z.array(z.string().max(80)).max(100).optional(),
});

export const taskUpdatePayloadSchema = z.object({
  sessionId: idSchema,
  taskId: idSchema,
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).nullable().optional(),
  status: taskStatusSchema.optional(),
  assignee: z.object({ type: z.enum(['user', 'agent']), id: idSchema }).nullable().optional(),
  relatedFiles: z.array(fileRefSchema).max(200).optional(),
  relatedCommits: z.array(z.string().max(80)).max(100).optional(),
});

export const contextPublishPayloadSchema = z.object({
  sessionId: idSchema,
  kind: contextKindSchema,
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  body: z.string().max(100_000).nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /**
   * Optimistic concurrency: when set, the write is rejected unless the stored
   * entry is still at this version.
   */
  expectedVersion: z.number().int().positive().optional(),
});

export const eventPublishPayloadSchema = z.object({
  sessionId: idSchema,
  type: eventTypeSchema,
  payload: z.unknown(),
});

export const agentStatusPayloadSchema = z.object({
  sessionId: idSchema,
  status: agentStatusSchema,
  note: z.string().max(500).optional(),
});

export const typingPayloadSchema = z.object({
  sessionId: idSchema,
  active: z.boolean(),
});

export const clientFrameSchema = z.discriminatedUnion('type', [
  frame(ClientFrameType.Hello, helloPayloadSchema),
  frame(ClientFrameType.Subscribe, subscribePayloadSchema),
  frame(ClientFrameType.Unsubscribe, z.object({ sessionId: idSchema })),
  frame(ClientFrameType.Ping, z.object({}).optional()),
  frame(ClientFrameType.MessageSend, messageSendPayloadSchema),
  frame(ClientFrameType.TaskCreate, taskCreatePayloadSchema),
  frame(ClientFrameType.TaskUpdate, taskUpdatePayloadSchema),
  frame(ClientFrameType.ContextPublish, contextPublishPayloadSchema),
  frame(ClientFrameType.EventPublish, eventPublishPayloadSchema),
  frame(ClientFrameType.AgentStatus, agentStatusPayloadSchema),
  frame(ClientFrameType.Typing, typingPayloadSchema),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export const ServerFrameType = {
  HelloOk: 'hello.ok',
  Subscribed: 'subscribed',
  Unsubscribed: 'unsubscribed',
  Event: 'event',
  Ack: 'ack',
  Error: 'error',
  Pong: 'pong',
  Presence: 'presence',
  Typing: 'typing',
  Resync: 'resync',
} as const;
export type ServerFrameType = (typeof ServerFrameType)[keyof typeof ServerFrameType];

/** Who the server decided the connection is. */
export const identitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: idSchema,
    displayName: z.string(),
  }),
  z.object({
    kind: z.literal('agent'),
    agentId: idSchema,
    sessionId: idSchema,
    name: z.string(),
  }),
]);
export type Identity = z.infer<typeof identitySchema>;

export const helloOkPayloadSchema = z.object({
  protocol: z.string(),
  serverVersion: z.string(),
  heartbeatIntervalMs: z.number().int().positive(),
  identity: identitySchema,
});

/**
 * Everything a client needs to render a session without replaying its history:
 * the session row, live membership, agents, open tasks and the current cursor.
 */
export const sessionSnapshotSchema = z.object({
  session: sessionSchema,
  members: z.array(sessionMemberSchema),
  agents: z.array(agentSchema),
  openTasks: z.array(taskSchema),
  lastSeq: seqSchema,
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const subscribedPayloadSchema = z.object({
  sessionId: idSchema,
  snapshot: sessionSnapshotSchema,
  /** Events replayed because the client asked to resume from `sinceSeq`. */
  replayed: z.array(eventSchema),
});

export const ackPayloadSchema = z.object({
  /** `id` of the client frame being acknowledged. */
  ref: z.string(),
  seq: seqSchema.optional(),
  /** Id of the object the request created, when it created one. */
  resourceId: idSchema.optional(),
});

export const presencePayloadSchema = z.object({
  sessionId: idSchema,
  actor: actorSchema,
  online: z.boolean(),
});

export const serverFrameSchema = z.discriminatedUnion('type', [
  frame(ServerFrameType.HelloOk, helloOkPayloadSchema),
  frame(ServerFrameType.Subscribed, subscribedPayloadSchema),
  frame(ServerFrameType.Unsubscribed, z.object({ sessionId: idSchema })),
  frame(ServerFrameType.Event, z.object({ event: eventSchema })),
  frame(ServerFrameType.Ack, ackPayloadSchema),
  frame(ServerFrameType.Error, errorBodySchema),
  frame(ServerFrameType.Pong, z.object({}).optional()),
  frame(ServerFrameType.Presence, presencePayloadSchema),
  frame(ServerFrameType.Typing, z.object({ sessionId: idSchema, actor: actorSchema, active: z.boolean() })),
  frame(
    ServerFrameType.Resync,
    z.object({ sessionId: idSchema, lastSeq: seqSchema, reason: z.string().max(200).optional() }),
  ),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

/** Build a frame envelope with the current protocol version and timestamp. */
export function makeFrame<T extends string>(
  type: T,
  payload: unknown,
  id: string,
): { v: string; id: string; type: T; ts: string; payload: unknown } {
  return { v: PROTOCOL_VERSION, id, type, ts: new Date().toISOString(), payload };
}

/**
 * Heartbeat cadences.
 *
 * `intervalMs` / `timeoutMs` govern the server-driven ping on deployments that
 * own their sockets.
 *
 * `clientIntervalMs` is the client's own keep-alive, and it is not optional:
 * where the socket belongs to a gateway rather than to the server - API Gateway
 * closes a WebSocket after ten minutes without traffic - nothing else proves a
 * quiet connection is still alive. Four minutes clears that limit with room to
 * spare while staying cheap on per-message billing.
 */
export const HEARTBEAT = {
  intervalMs: 20_000,
  timeoutMs: 60_000,
  clientIntervalMs: 240_000,
} as const;

/** Reconnect backoff the reference clients implement. */
export const RECONNECT_BACKOFF = {
  initialMs: 500,
  maxMs: 15_000,
  factor: 2,
  jitter: 0.25,
} as const;

/** Websocket close codes AgentMesh assigns meaning to. */
export const CloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
  TooLarge: 1009,
  /** Authentication failed or was never presented. */
  Unauthorized: 4001,
  /** Token expired or was revoked while connected. */
  TokenRevoked: 4002,
  /** Protocol version not supported. */
  UnsupportedVersion: 4003,
  /** Heartbeat deadline missed. */
  HeartbeatTimeout: 4004,
  /** Too many frames. */
  RateLimited: 4029,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
