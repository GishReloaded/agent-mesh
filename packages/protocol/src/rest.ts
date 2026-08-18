import { z } from 'zod';
import {
  agentSchema,
  contextEntrySchema,
  contextRevisionSchema,
  inviteSchema,
  messageSchema,
  sessionMemberSchema,
  sessionSchema,
  taskSchema,
  userSchema,
} from './entities.js';
import { eventSchema, eventTypeSchema } from './events.js';
import {
  agentAutonomySchema,
  agentStatusSchema,
  capabilitiesSchema,
  contextKindSchema,
  fileRefSchema,
  idSchema,
  invitableRoleSchema,
  mentionSchema,
  seqSchema,
  sessionRoleSchema,
  taskStatusSchema,
} from './primitives.js';

/** All REST routes live under this prefix. */
export const API_PREFIX = '/api/v1';

// --- auth ------------------------------------------------------------------

export const registerRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(200),
  displayName: z.string().min(1).max(120),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  /** Seconds until `accessToken` expires. */
  expiresIn: z.number().int().positive(),
  refreshToken: z.string(),
  user: userSchema,
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

export const refreshRequestSchema = z.object({ refreshToken: z.string().min(1) });
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

// --- sessions --------------------------------------------------------------

export const createSessionRequestSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with dashes')
    .optional(),
  description: z.string().max(2000).optional(),
  projectMeta: z.record(z.string(), z.unknown()).optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const updateSessionRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  projectMeta: z.record(z.string(), z.unknown()).optional(),
  archived: z.boolean().optional(),
});
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;

/** Session row plus the caller's own role, for list views. */
export const sessionSummarySchema = sessionSchema.extend({
  role: sessionRoleSchema,
  memberCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
  onlineCount: z.number().int().nonnegative(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionDetailSchema = z.object({
  session: sessionSchema,
  role: sessionRoleSchema,
  members: z.array(sessionMemberSchema),
  agents: z.array(agentSchema),
});
export type SessionDetail = z.infer<typeof sessionDetailSchema>;

// --- invites ---------------------------------------------------------------

export const createInviteRequestSchema = z.object({
  role: invitableRoleSchema.default('member'),
  /** Lifetime in seconds. Defaults to 7 days, capped at 30. */
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24 * 30)
    .optional(),
  maxUses: z.number().int().positive().max(1000).optional(),
});
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;

export const createInviteResponseSchema = z.object({
  invite: inviteSchema,
  /** Shown exactly once — the server stores only a hash. */
  token: z.string(),
  url: z.string().optional(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

// --- members ---------------------------------------------------------------

export const updateMemberRequestSchema = z.object({ role: sessionRoleSchema });
export type UpdateMemberRequest = z.infer<typeof updateMemberRequestSchema>;

// --- agents ----------------------------------------------------------------

export const registerAgentRequestSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.string().max(80).default('custom'),
  model: z.string().max(120).default('unknown'),
  machineId: z.string().max(120).optional(),
  capabilities: capabilitiesSchema.optional(),
  autonomy: agentAutonomySchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type RegisterAgentRequest = z.infer<typeof registerAgentRequestSchema>;

export const registerAgentResponseSchema = z.object({
  agent: agentSchema,
  /** Opaque session-scoped agent token. Shown exactly once. */
  token: z.string(),
});
export type RegisterAgentResponse = z.infer<typeof registerAgentResponseSchema>;

export const updateAgentRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  capabilities: capabilitiesSchema.optional(),
  autonomy: agentAutonomySchema.optional(),
  status: agentStatusSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;

// --- messages, events ------------------------------------------------------

export const createMessageRequestSchema = z.object({
  body: z.string().min(1),
  mentions: z.array(mentionSchema).max(50).optional(),
  parentId: idSchema.nullable().optional(),
});
export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;

/**
 * Cursor pagination. History is walked backwards with `beforeSeq`; live catch-up
 * walks forwards with `sinceSeq`. Offsets are never used — the log only grows,
 * and offsets would shift under concurrent writes.
 */
export const historyQuerySchema = z.object({
  beforeSeq: z.coerce.number().int().nonnegative().optional(),
  sinceSeq: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const messagePageSchema = z.object({
  items: z.array(messageSchema),
  /** Pass as `beforeSeq` to fetch the previous page; null when at the start. */
  nextCursor: seqSchema.nullable(),
  hasMore: z.boolean(),
});
export type MessagePage = z.infer<typeof messagePageSchema>;

export const eventPageSchema = z.object({
  items: z.array(eventSchema),
  nextCursor: seqSchema.nullable(),
  hasMore: z.boolean(),
});
export type EventPage = z.infer<typeof eventPageSchema>;

export const publishEventRequestSchema = z.object({
  type: eventTypeSchema,
  payload: z.unknown(),
});
export type PublishEventRequest = z.infer<typeof publishEventRequestSchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResponseSchema = z.object({
  messages: z.array(messageSchema),
  tasks: z.array(taskSchema),
  context: z.array(contextEntrySchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

// --- tasks -----------------------------------------------------------------

export const createTaskRequestSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  status: taskStatusSchema.optional(),
  assignee: z.object({ type: z.enum(['user', 'agent']), id: idSchema }).nullable().optional(),
  relatedFiles: z.array(fileRefSchema).max(200).optional(),
  relatedCommits: z.array(z.string().max(80)).max(100).optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = createTaskRequestSchema.partial().extend({
  description: z.string().max(20_000).nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  assigneeId: idSchema.optional(),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

// --- context ---------------------------------------------------------------

export const publishContextRequestSchema = z.object({
  kind: contextKindSchema,
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  body: z.string().max(100_000).nullable().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  expectedVersion: z.number().int().positive().optional(),
});
export type PublishContextRequest = z.infer<typeof publishContextRequestSchema>;

export const contextListQuerySchema = z.object({
  kind: contextKindSchema.optional(),
  key: z.string().max(200).optional(),
});
export type ContextListQuery = z.infer<typeof contextListQuerySchema>;

export const contextEntryWithRevisionsSchema = z.object({
  entry: contextEntrySchema,
  revisions: z.array(contextRevisionSchema),
});
export type ContextEntryWithRevisions = z.infer<typeof contextEntryWithRevisionsSchema>;

// --- meta ------------------------------------------------------------------

export const versionResponseSchema = z.object({
  name: z.literal('agentmesh'),
  version: z.string(),
  protocol: z.string(),
  limits: z.record(z.string(), z.number()),
});
export type VersionResponse = z.infer<typeof versionResponseSchema>;

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().nonnegative(),
  database: z.enum(['ok', 'down']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
