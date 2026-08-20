import { z } from 'zod';
import {
  agentSchema,
  contextEntrySchema,
  messageSchema,
  publicUserSchema,
  sessionSchema,
  taskSchema,
} from './entities.js';
import {
  actorSchema,
  agentStatusSchema,
  fileRefSchema,
  gitRefSchema,
  idSchema,
  seqSchema,
  sessionRoleSchema,
  timestampSchema,
} from './primitives.js';

/**
 * AgentMesh has one append-only log per session. Chat messages, task changes,
 * context updates and development events are all entries in that log, ordered
 * by `seq`. Two naming conventions live in the same namespace, and the casing
 * tells you which is which:
 *
 * - `lower.dotted` — lifecycle events. Produced by the server to describe what
 *   happened to session state. Clients apply them to their local model.
 * - `UPPER_SNAKE` — development events. Published by participants to describe
 *   what happened in the software project itself. The server stores and routes
 *   them but never interprets their meaning.
 */

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

export const LifecycleEventType = {
  SessionCreated: 'session.created',
  SessionUpdated: 'session.updated',
  SessionArchived: 'session.archived',

  ParticipantJoined: 'participant.joined',
  ParticipantLeft: 'participant.left',
  ParticipantRoleChanged: 'participant.role_changed',

  AgentRegistered: 'agent.registered',
  AgentConnected: 'agent.connected',
  AgentDisconnected: 'agent.disconnected',
  AgentStatusChanged: 'agent.status_changed',
  AgentRevoked: 'agent.revoked',

  MessageCreated: 'message.created',

  TaskCreated: 'task.created',
  TaskUpdated: 'task.updated',
  TaskDeleted: 'task.deleted',

  ContextCreated: 'context.created',
  ContextUpdated: 'context.updated',
  ContextDeleted: 'context.deleted',
} as const;

export type LifecycleEventType = (typeof LifecycleEventType)[keyof typeof LifecycleEventType];

export const LIFECYCLE_EVENT_TYPES = Object.values(LifecycleEventType) as LifecycleEventType[];

export const lifecyclePayloadSchemas = {
  'session.created': z.object({ session: sessionSchema }),
  'session.updated': z.object({ session: sessionSchema }),
  'session.archived': z.object({ sessionId: idSchema }),

  'participant.joined': z.object({ user: publicUserSchema, role: sessionRoleSchema }),
  'participant.left': z.object({ userId: idSchema, removedBy: idSchema.nullable() }),
  'participant.role_changed': z.object({ userId: idSchema, role: sessionRoleSchema }),

  'agent.registered': z.object({ agent: agentSchema }),
  'agent.connected': z.object({ agentId: idSchema, name: z.string() }),
  'agent.disconnected': z.object({ agentId: idSchema, name: z.string(), reason: z.string().optional() }),
  'agent.status_changed': z.object({
    agentId: idSchema,
    status: agentStatusSchema,
    note: z.string().max(500).optional(),
  }),
  'agent.revoked': z.object({ agentId: idSchema, revokedBy: idSchema }),

  'message.created': z.object({ message: messageSchema }),

  'task.created': z.object({ task: taskSchema }),
  'task.updated': z.object({ task: taskSchema, changed: z.array(z.string()) }),
  'task.deleted': z.object({ taskId: idSchema }),

  'context.created': z.object({ entry: contextEntrySchema }),
  'context.updated': z.object({ entry: contextEntrySchema, previousVersion: z.number().int() }),
  'context.deleted': z.object({ entryId: idSchema }),
} as const satisfies Record<LifecycleEventType, z.ZodTypeAny>;

// ---------------------------------------------------------------------------
// Development events
// ---------------------------------------------------------------------------

export const DevEventType = {
  ApiContractCreated: 'API_CONTRACT_CREATED',
  ApiContractUpdated: 'API_CONTRACT_UPDATED',
  CodeChanged: 'CODE_CHANGED',
  GitCommitCreated: 'GIT_COMMIT_CREATED',
  BuildFailed: 'BUILD_FAILED',
  BuildSucceeded: 'BUILD_SUCCEEDED',
  TestFailed: 'TEST_FAILED',
  TestPassed: 'TEST_PASSED',
  DecisionCreated: 'DECISION_CREATED',
  AgentProgress: 'AGENT_PROGRESS',
  AgentBlocked: 'AGENT_BLOCKED',
  AgentUnblocked: 'AGENT_UNBLOCKED',
  AgentHandoff: 'AGENT_HANDOFF',
  HelpRequested: 'HELP_REQUESTED',
  CodexControlRequest: 'CODEX_CONTROL_REQUEST',
  CodexThreadState: 'CODEX_THREAD_STATE',
  CodexActivity: 'CODEX_ACTIVITY',
  CodexApprovalRequest: 'CODEX_APPROVAL_REQUEST',
  CodexApprovalResponse: 'CODEX_APPROVAL_RESPONSE',
} as const;

export type DevEventType = (typeof DevEventType)[keyof typeof DevEventType];

export const DEV_EVENT_TYPES = Object.values(DevEventType) as DevEventType[];

/**
 * Extension namespace. Anyone may publish `X_*` events without coordinating a
 * protocol change; their payload is passed through untouched.
 */
export const CUSTOM_EVENT_TYPE_PATTERN = /^X_[A-Z0-9_]{1,60}$/;

const apiContractPayload = z.object({
  /** Logical service the endpoint belongs to, e.g. "auth". */
  service: z.string().max(120),
  method: z.string().max(12),
  endpoint: z.string().max(300),
  request: z.record(z.string(), z.unknown()).optional(),
  response: z.record(z.string(), z.unknown()).optional(),
  /** Optional pointer to the context entry holding the full contract. */
  contextKey: z.string().max(200).optional(),
  commit: z.string().max(80).optional(),
  status: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
});

const buildPayload = z.object({
  pipeline: z.string().max(120).optional(),
  target: z.string().max(200).optional(),
  git: gitRefSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Truncated log excerpt. Never send full build logs through the session. */
  output: z.string().max(8000).optional(),
});

const testPayload = z.object({
  suite: z.string().max(200).optional(),
  passed: z.number().int().nonnegative().optional(),
  failed: z.number().int().nonnegative().optional(),
  skipped: z.number().int().nonnegative().optional(),
  git: gitRefSchema.optional(),
  output: z.string().max(8000).optional(),
});

const codexRequestIdSchema = z.string().min(1).max(120);
const codexExternalIdSchema = z.string().min(1).max(200);
const codexModelSchema = z.string().min(1).max(120);
const codexApprovalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
const codexApprovalsReviewerSchema = z.enum(['user', 'auto_review']);
const codexSandboxSchema = z.enum(['readOnly', 'workspaceWrite', 'dangerFullAccess']);
const codexModelOptionSchema = z
  .object({
    id: codexModelSchema,
    displayName: z.string().min(1).max(160),
    isDefault: z.boolean().optional(),
    defaultReasoningEffort: z.string().max(40).optional(),
    supportedReasoningEfforts: z.array(z.string().max(40)).max(20).optional(),
  })
  .strict();

const codexControlCommon = {
  requestId: codexRequestIdSchema,
  agentId: idSchema,
};

const codexControlPayload = z.discriminatedUnion('action', [
  z
    .object({
      ...codexControlCommon,
      action: z.literal('createThread'),
      title: z.string().max(300).optional(),
      model: codexModelSchema.optional(),
      reasoningEffort: z.string().max(40).optional(),
      approvalPolicy: codexApprovalPolicySchema.optional(),
      approvalsReviewer: codexApprovalsReviewerSchema.optional(),
      sandbox: codexSandboxSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...codexControlCommon,
      action: z.literal('startTurn'),
      threadId: codexExternalIdSchema,
      prompt: z.string().min(1).max(100_000),
      model: codexModelSchema.optional(),
      reasoningEffort: z.string().max(40).optional(),
      approvalPolicy: codexApprovalPolicySchema.optional(),
      approvalsReviewer: codexApprovalsReviewerSchema.optional(),
      sandbox: codexSandboxSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...codexControlCommon,
      action: z.literal('interruptTurn'),
      threadId: codexExternalIdSchema,
      turnId: codexExternalIdSchema,
    })
    .strict(),
  z
    .object({
      ...codexControlCommon,
      action: z.literal('archiveThread'),
      threadId: codexExternalIdSchema,
    })
    .strict(),
  z
    .object({
      ...codexControlCommon,
      action: z.literal('setModel'),
      threadId: codexExternalIdSchema,
      model: codexModelSchema,
      reasoningEffort: z.string().max(40).optional(),
    })
    .strict(),
  z
    .object({
      ...codexControlCommon,
      action: z.literal('configureThread'),
      threadId: codexExternalIdSchema,
      model: codexModelSchema.optional(),
      reasoningEffort: z.string().max(40).optional(),
      approvalPolicy: codexApprovalPolicySchema.optional(),
      approvalsReviewer: codexApprovalsReviewerSchema.optional(),
      sandbox: codexSandboxSchema.optional(),
    })
    .strict(),
]);

export const devPayloadSchemas = {
  API_CONTRACT_CREATED: apiContractPayload,
  API_CONTRACT_UPDATED: apiContractPayload,
  CODE_CHANGED: z.object({
    files: z.array(fileRefSchema).max(200),
    git: gitRefSchema.optional(),
    summary: z.string().max(2000).optional(),
  }),
  GIT_COMMIT_CREATED: z.object({
    git: gitRefSchema,
    message: z.string().max(2000).optional(),
    files: z.array(fileRefSchema).max(500).optional(),
  }),
  BUILD_FAILED: buildPayload,
  BUILD_SUCCEEDED: buildPayload,
  TEST_FAILED: testPayload,
  TEST_PASSED: testPayload,
  DECISION_CREATED: z.object({
    title: z.string().max(300),
    /** Pointer to the `decision` context entry carrying the full text. */
    contextKey: z.string().max(200).optional(),
    summary: z.string().max(4000).optional(),
  }),
  /**
   * A step an agent took while working, published as it happens.
   *
   * Deliberately a summary, never content: a tool name and what it was pointed
   * at, not what it read or wrote. The server has no business holding the
   * contents of someone's workspace, and a session is not a place to stream a
   * model's entire working memory.
   */
  AGENT_PROGRESS: z.object({
    /** Monotonic within one task, so a client can order and deduplicate. */
    step: z.number().int().nonnegative(),
    kind: z.enum(['thinking', 'tool', 'text', 'status']),
    /** Tool name, for `kind: "tool"`. */
    tool: z.string().max(80).optional(),
    /** Short summary - a path, a command, a first line. Never full output. */
    detail: z.string().max(300).optional(),
  }),
  AGENT_BLOCKED: z.object({
    reason: z.string().max(2000),
    needs: z.string().max(2000).optional(),
    taskId: idSchema.optional(),
  }),
  AGENT_UNBLOCKED: z.object({ taskId: idSchema.optional(), note: z.string().max(2000).optional() }),
  AGENT_HANDOFF: z.object({
    toAgentId: idSchema.optional(),
    /** Capability filter when no specific agent is named. */
    requiredCapabilities: z.array(z.string().max(64)).max(20).optional(),
    taskId: idSchema.optional(),
    summary: z.string().max(4000),
  }),
  HELP_REQUESTED: z.object({
    question: z.string().max(4000),
    /** Who the request is directed at; empty means anyone in the session. */
    audience: z.array(z.string().max(120)).max(20).optional(),
    taskId: idSchema.optional(),
  }),
  CODEX_CONTROL_REQUEST: codexControlPayload,
  CODEX_THREAD_STATE: z
    .object({
      agentId: idSchema,
      threadId: codexExternalIdSchema.optional(),
      title: z.string().max(300).optional(),
      model: codexModelSchema.optional(),
      reasoningEffort: z.string().max(40).optional(),
      approvalPolicy: codexApprovalPolicySchema.optional(),
      approvalsReviewer: codexApprovalsReviewerSchema.optional(),
      sandbox: codexSandboxSchema.optional(),
      status: z.enum(['offline', 'idle', 'working', 'waitingForApproval', 'failed', 'archived']),
      activeTurnId: codexExternalIdSchema.optional(),
      primary: z.boolean().optional(),
      contextTokens: z.number().int().nonnegative().max(10_000_000).optional(),
      contextWindow: z.number().int().positive().max(10_000_000).optional(),
      error: z.string().max(2000).optional(),
      models: z.array(codexModelOptionSchema).max(100).optional(),
    })
    .strict(),
  CODEX_ACTIVITY: z
    .object({
      agentId: idSchema,
      threadId: codexExternalIdSchema,
      turnId: codexExternalIdSchema.optional(),
      itemId: codexExternalIdSchema.optional(),
      kind: z.enum(['reasoningSummary', 'command', 'mcpTool', 'fileChange', 'turnSummary', 'contextCompaction', 'message', 'status', 'error']),
      status: z.string().max(40).optional(),
      summary: z.string().max(4000).optional(),
      tool: z.string().max(160).optional(),
      command: z.string().max(4000).optional(),
      cwd: z.string().max(1000).optional(),
      output: z.string().max(16_000).optional(),
      exitCode: z.number().int().optional(),
      durationMs: z.number().nonnegative().max(86_400_000).optional(),
      files: z.array(z.string().max(1000)).max(200).optional(),
      diff: z.string().max(16_000).optional(),
      additions: z.number().int().nonnegative().max(1_000_000).optional(),
      deletions: z.number().int().nonnegative().max(1_000_000).optional(),
      fileStats: z.array(z.object({
        path: z.string().max(1000),
        additions: z.number().int().nonnegative().max(1_000_000),
        deletions: z.number().int().nonnegative().max(1_000_000),
      }).strict()).max(200).optional(),
    })
    .strict(),
  CODEX_APPROVAL_REQUEST: z
    .object({
      requestId: codexRequestIdSchema,
      agentId: idSchema,
      threadId: codexExternalIdSchema,
      turnId: codexExternalIdSchema.optional(),
      itemId: codexExternalIdSchema.optional(),
      kind: z.enum(['command', 'fileChange', 'permissions', 'mcp']),
      reason: z.string().max(2000).optional(),
      command: z.string().max(4000).optional(),
      cwd: z.string().max(1000).optional(),
      files: z.array(z.string().max(1000)).max(200).optional(),
      availableDecisions: z.array(z.enum(['accept', 'acceptForSession', 'decline', 'cancel'])).max(4),
      expiresAt: timestampSchema,
    })
    .strict(),
  CODEX_APPROVAL_RESPONSE: z
    .object({
      requestId: codexRequestIdSchema,
      agentId: idSchema,
      threadId: codexExternalIdSchema,
      decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
    })
    .strict(),
} as const satisfies Record<DevEventType, z.ZodTypeAny>;

export type CodexControlRequest = z.infer<typeof devPayloadSchemas.CODEX_CONTROL_REQUEST>;
export type CodexThreadState = z.infer<typeof devPayloadSchemas.CODEX_THREAD_STATE>;
export type CodexActivity = z.infer<typeof devPayloadSchemas.CODEX_ACTIVITY>;
export type CodexApprovalRequest = z.infer<typeof devPayloadSchemas.CODEX_APPROVAL_REQUEST>;
export type CodexApprovalResponse = z.infer<typeof devPayloadSchemas.CODEX_APPROVAL_RESPONSE>;

// ---------------------------------------------------------------------------
// Event record
// ---------------------------------------------------------------------------

export const eventTypeSchema = z.string().min(1).max(80);

export function isLifecycleEventType(type: string): type is LifecycleEventType {
  return (LIFECYCLE_EVENT_TYPES as string[]).includes(type);
}

export function isDevEventType(type: string): type is DevEventType {
  return (DEV_EVENT_TYPES as string[]).includes(type);
}

export function isCustomEventType(type: string): boolean {
  return CUSTOM_EVENT_TYPE_PATTERN.test(type);
}

/** Types a participant is allowed to publish directly. */
export function isPublishableEventType(type: string): boolean {
  return isDevEventType(type) || isCustomEventType(type);
}

/**
 * Validate an event payload against its type. Custom `X_*` events accept any
 * JSON object; unknown types are rejected.
 */
export function parseEventPayload(type: string, payload: unknown): unknown {
  if (isLifecycleEventType(type)) {
    return lifecyclePayloadSchemas[type].parse(payload);
  }
  if (isDevEventType(type)) {
    return devPayloadSchemas[type].parse(payload);
  }
  if (isCustomEventType(type)) {
    return z.record(z.string(), z.unknown()).parse(payload);
  }
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: ['type'],
      message: `Unknown event type: ${type}`,
    },
  ]);
}

export const eventSchema = z.object({
  id: idSchema,
  sessionId: idSchema,
  seq: seqSchema,
  type: eventTypeSchema,
  actor: actorSchema,
  payload: z.unknown(),
  createdAt: timestampSchema,
});
export type Event = z.infer<typeof eventSchema>;

/** Narrowed event record for a known lifecycle type. */
export type LifecycleEvent<T extends LifecycleEventType = LifecycleEventType> = Omit<Event, 'type' | 'payload'> & {
  type: T;
  payload: z.infer<(typeof lifecyclePayloadSchemas)[T]>;
};

/** Narrowed event record for a known development type. */
export type DevEvent<T extends DevEventType = DevEventType> = Omit<Event, 'type' | 'payload'> & {
  type: T;
  payload: z.infer<(typeof devPayloadSchemas)[T]>;
};
