import { z } from 'zod';
import {
  actorSchema,
  agentAutonomySchema,
  agentStatusSchema,
  capabilitiesSchema,
  contextKindSchema,
  fileRefSchema,
  gitRefSchema,
  idSchema,
  mentionSchema,
  seqSchema,
  sessionRoleSchema,
  taskStatusSchema,
  timestampSchema,
} from './primitives.js';

export const userSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  avatarColor: z.string().max(16),
  createdAt: timestampSchema,
});
export type User = z.infer<typeof userSchema>;

/** A user as seen by other participants — no email, no account details. */
export const publicUserSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1).max(120),
  avatarColor: z.string().max(16),
});
export type PublicUser = z.infer<typeof publicUserSchema>;

export const sessionSchema = z.object({
  id: idSchema,
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  ownerId: idSchema,
  /** Free-form project metadata: repository url, workspace roots, stack, etc. */
  projectMeta: z.record(z.string(), z.unknown()),
  lastSeq: seqSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionMemberSchema = z.object({
  sessionId: idSchema,
  user: publicUserSchema,
  role: sessionRoleSchema,
  joinedAt: timestampSchema,
  /** Presence, derived from live connections rather than stored. */
  online: z.boolean(),
});
export type SessionMember = z.infer<typeof sessionMemberSchema>;

export const agentSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  name: z.string().min(1).max(120),
  /** Free-form provider label, e.g. "openai", "anthropic", "local", "ci". */
  provider: z.string().max(80),
  /** Free-form model label. The server never interprets it. */
  model: z.string().max(120),
  /** Stable identifier of the machine the agent runs on. */
  machineId: z.string().max(120).nullable(),
  /** Assigned at registration, never changes. See AVATAR_COLORS. */
  avatarColor: z.string().max(16),
  capabilities: capabilitiesSchema,
  status: agentStatusSchema,
  autonomy: agentAutonomySchema,
  online: z.boolean(),
  /** The human this agent acts on behalf of. */
  ownerUserId: idSchema,
  metadata: z.record(z.string(), z.unknown()),
  lastSeenAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Agent = z.infer<typeof agentSchema>;

export const messageSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  seq: seqSchema,
  author: actorSchema,
  body: z.string(),
  mentions: z.array(mentionSchema),
  parentId: idSchema.nullable(),
  createdAt: timestampSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const taskSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).nullable(),
  status: taskStatusSchema,
  creator: actorSchema,
  /** Whoever the task is assigned to — a human or an agent, or nobody. */
  assignee: actorSchema.nullable(),
  relatedFiles: z.array(fileRefSchema),
  relatedCommits: z.array(z.string().max(80)),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const contextEntrySchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  kind: contextKindSchema,
  /** Stable key, unique per (session, kind). Re-publishing supersedes. */
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  /** Human-readable body, markdown by convention. */
  body: z.string().max(100_000).nullable(),
  /** Machine-readable payload: request/response shapes, decision fields, etc. */
  data: z.record(z.string(), z.unknown()),
  version: z.number().int().positive(),
  createdBy: actorSchema,
  updatedBy: actorSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ContextEntry = z.infer<typeof contextEntrySchema>;

export const contextRevisionSchema = z.object({
  id: idSchema,
  entryId: idSchema,
  version: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  data: z.record(z.string(), z.unknown()),
  author: actorSchema,
  createdAt: timestampSchema,
});
export type ContextRevision = z.infer<typeof contextRevisionSchema>;

export const inviteSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  role: sessionRoleSchema,
  createdBy: idSchema,
  expiresAt: timestampSchema,
  maxUses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type Invite = z.infer<typeof inviteSchema>;

/** Git state last reported for a session, folded from `GIT_COMMIT_CREATED`. */
export const gitStateSchema = z.object({
  ref: gitRefSchema,
  files: z.array(fileRefSchema),
  reportedBy: actorSchema,
  reportedAt: timestampSchema,
});
export type GitState = z.infer<typeof gitStateSchema>;
