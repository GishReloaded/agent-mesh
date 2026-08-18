import { z } from 'zod';

/** Every persisted object is identified by a ULID-shaped string. */
export const idSchema = z.string().min(1).max(64);
export type Id = z.infer<typeof idSchema>;

/** ISO-8601 timestamp in UTC. */
export const timestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof timestampSchema>;

/**
 * Monotonic per-session sequence number. Every entry in a session's event log
 * gets the next `seq`; clients resume by asking for everything after the last
 * one they saw. Transported as a number (safe below 2^53).
 */
export const seqSchema = z.number().int().nonnegative();
export type Seq = z.infer<typeof seqSchema>;

/**
 * Roles a participant can hold in a session.
 *
 * `agent` is deliberately not a peer of `member`: an agent is a delegate of the
 * human who registered it. It can read and contribute, but never administers
 * the session — invites, membership and deletion stay with humans.
 */
export const SessionRole = {
  Owner: 'owner',
  Member: 'member',
  Agent: 'agent',
  Viewer: 'viewer',
} as const;
export type SessionRole = (typeof SessionRole)[keyof typeof SessionRole];
export const sessionRoleSchema = z.enum(['owner', 'member', 'agent', 'viewer']);

/** Roles a human can be invited as. */
export const invitableRoleSchema = z.enum(['member', 'viewer']);
export type InvitableRole = z.infer<typeof invitableRoleSchema>;

/** What kind of participant produced an event. */
export const ActorType = {
  User: 'user',
  Agent: 'agent',
  System: 'system',
} as const;
export type ActorType = (typeof ActorType)[keyof typeof ActorType];
export const actorTypeSchema = z.enum(['user', 'agent', 'system']);

/** Denormalized author stamp carried on every event so clients can render it. */
export const actorSchema = z.object({
  type: actorTypeSchema,
  /** Null for `system` actors. */
  id: idSchema.nullable(),
  /** Display name at the time the event was produced. */
  name: z.string().max(120).nullable(),
});
export type Actor = z.infer<typeof actorSchema>;

/** Runtime state an agent reports about itself. */
export const AgentStatus = {
  Idle: 'idle',
  Working: 'working',
  Blocked: 'blocked',
  Offline: 'offline',
} as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];
export const agentStatusSchema = z.enum(['idle', 'working', 'blocked', 'offline']);

/**
 * How eagerly an agent is allowed to act on traffic it did not solicit.
 *
 * - `manual` — the agent receives events but its runtime should never act
 *   without an explicit human instruction.
 * - `semi` — the agent may act on mentions from humans; mentions from other
 *   agents are honoured only while the agent-to-agent chain is below the limit.
 * - `auto` — the agent may act on any mention addressed to it.
 *
 * The server enforces the chain limit; the autonomy level itself is advisory
 * and delivered to the agent runtime, which is what decides to burn tokens.
 */
export const AgentAutonomy = {
  Manual: 'manual',
  Semi: 'semi',
  Auto: 'auto',
} as const;
export type AgentAutonomy = (typeof AgentAutonomy)[keyof typeof AgentAutonomy];
export const agentAutonomySchema = z.enum(['manual', 'semi', 'auto']);

/**
 * Free-form capability map. Well-known keys are listed here for discoverability
 * and UI affordances; unknown boolean keys are preserved verbatim so nothing
 * about the core protocol is tied to a particular class of agent.
 */
export const WELL_KNOWN_CAPABILITIES = [
  'coding',
  'terminal',
  'git',
  'frontend',
  'backend',
  'testing',
  'review',
  'docs',
  'infra',
] as const;

export const capabilitiesSchema = z.record(z.string().min(1).max(64), z.boolean());
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** Task lifecycle. Intentionally small: this is not an issue tracker. */
export const TaskStatus = {
  Todo: 'todo',
  InProgress: 'in_progress',
  Blocked: 'blocked',
  Review: 'review',
  Done: 'done',
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];
export const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'review', 'done']);

/**
 * Kinds of structured shared context.
 *
 * Context is typed and keyed on purpose: agents must be able to fetch "the
 * current auth contract" without replaying a chat log, and a second write to
 * the same key supersedes the first instead of adding a contradiction.
 */
export const ContextKind = {
  Project: 'project',
  Architecture: 'architecture',
  ApiContract: 'api_contract',
  Decision: 'decision',
  File: 'file',
  State: 'state',
  Note: 'note',
} as const;
export type ContextKind = (typeof ContextKind)[keyof typeof ContextKind];
export const contextKindSchema = z.enum([
  'project',
  'architecture',
  'api_contract',
  'decision',
  'file',
  'state',
  'note',
]);

/**
 * A mention target inside a message. `@all` broadcasts; otherwise the mention
 * resolves to a participant or an agent by id.
 */
export const mentionSchema = z.object({
  type: z.enum(['user', 'agent', 'all']),
  id: idSchema.nullable(),
  /** The handle as typed, without the leading `@`. */
  handle: z.string().min(1).max(120),
});
export type Mention = z.infer<typeof mentionSchema>;

/**
 * Git coordinates reported by a participant.
 *
 * Note: these are self-reported and the server cannot verify them. Treat them
 * as a claim about a repository, never as a source of truth.
 */
export const gitRefSchema = z.object({
  repository: z.string().max(300).optional(),
  branch: z.string().max(300).optional(),
  commit: z.string().max(80).optional(),
  pullRequest: z.string().max(300).optional(),
  status: z.string().max(80).optional(),
});
export type GitRef = z.infer<typeof gitRefSchema>;

/**
 * Reference to a file in the participant's own workspace.
 *
 * AgentMesh stores paths and metadata only — never file contents. The project's
 * source of truth stays in the project's own repository.
 */
export const fileRefSchema = z.object({
  path: z.string().min(1).max(500),
  change: z.enum(['added', 'modified', 'deleted', 'renamed']).optional(),
  summary: z.string().max(500).optional(),
});
export type FileRef = z.infer<typeof fileRefSchema>;
