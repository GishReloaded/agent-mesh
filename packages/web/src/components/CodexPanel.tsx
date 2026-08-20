import {
  type Agent,
  type CodexApprovalResponse,
  type CodexControlRequest,
  type ContextEntry,
  type Event as MeshEvent,
  type Identity,
  type Session,
} from '@agentmesh/sdk';

export interface CodexModelView {
  id: string;
  displayName: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}

export interface CodexThreadView {
  id: string;
  agentId: string;
  title: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
  primary: boolean;
  archived: boolean;
  status: string;
  activeTurnId?: string;
  error?: string;
  models: CodexModelView[];
}

export interface CodexApprovalView {
  requestId: string;
  agentId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  kind: string;
  reason?: string;
  command?: string;
  cwd?: string;
  files?: string[];
  availableDecisions: CodexApprovalResponse['decision'][];
  expiresAt: string;
}

export interface CodexPanelView {
  threads: CodexThreadView[];
  activityByThread: Map<string, MeshEvent[]>;
  pendingApprovals: CodexApprovalView[];
}

export type CodexSandbox = 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

type CodexControlInput = CodexControlRequest extends infer Request
  ? Request extends { requestId: string }
    ? Omit<Request, 'requestId'>
    : never
  : never;

/** Fold durable context and replayable events into the current Codex UI model. */
export function deriveCodexView(context: ContextEntry[], events: MeshEvent[]): CodexPanelView {
  const states = new Map<string, Record<string, unknown>>();
  const modelsByAgent = new Map<string, CodexModelView[]>();
  const activityByThread = new Map<string, MeshEvent[]>();
  const approvals = new Map<string, CodexApprovalView>();

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = asObject(event.payload);
    const agentId = asString(payload.agentId);
    const threadId = asString(payload.threadId);
    if (event.type === 'CODEX_THREAD_STATE') {
      if (threadId) states.set(threadId, payload);
      if (agentId && Array.isArray(payload.models)) {
        modelsByAgent.set(
          agentId,
          payload.models.map(asObject).flatMap((model) => {
            const id = asString(model.id);
            const displayName = asString(model.displayName);
            return id && displayName
              ? [{
                  id,
                  displayName,
                  ...(typeof model.isDefault === 'boolean' ? { isDefault: model.isDefault } : {}),
                  ...(asString(model.defaultReasoningEffort)
                    ? { defaultReasoningEffort: asString(model.defaultReasoningEffort) }
                    : {}),
                  ...(Array.isArray(model.supportedReasoningEfforts)
                    ? { supportedReasoningEfforts: model.supportedReasoningEfforts.filter(isString) }
                    : {}),
                }]
              : [];
          }),
        );
      }
    } else if (event.type === 'CODEX_ACTIVITY' && threadId) {
      const activity = activityByThread.get(threadId) ?? [];
      activity.push(event);
      activityByThread.set(threadId, activity.slice(-200));
    } else if (event.type === 'CODEX_APPROVAL_REQUEST') {
      const approval = approvalFrom(payload);
      if (approval) approvals.set(approval.requestId, approval);
    } else if (event.type === 'CODEX_APPROVAL_RESPONSE') {
      const requestId = asString(payload.requestId);
      if (requestId) approvals.delete(requestId);
    }
  }

  const threads = context
    .filter((entry) => entry.kind === 'codex_thread')
    .flatMap((entry): CodexThreadView[] => {
      const data = entry.data;
      const id = asString(data.threadId);
      const agentId = asString(data.agentId);
      if (!id || !agentId) return [];
      const state = states.get(id) ?? {};
      return [{
        id,
        agentId,
        title: asString(state.title) || asString(data.title) || entry.title,
        ...(asString(state.model) || asString(data.model) ? { model: asString(state.model) || asString(data.model) } : {}),
        ...(asString(data.reasoningEffort) ? { reasoningEffort: asString(data.reasoningEffort) } : {}),
        approvalPolicy: asApprovalPolicy(state.approvalPolicy) ?? asApprovalPolicy(data.approvalPolicy) ?? 'on-request',
        sandbox: asSandbox(state.sandbox) ?? asSandbox(data.sandbox) ?? 'workspaceWrite',
        primary: data.primary === true,
        archived: data.archived === true || state.status === 'archived',
        status: asString(state.status) || (data.archived === true ? 'archived' : 'offline'),
        ...(asString(state.activeTurnId) ? { activeTurnId: asString(state.activeTurnId) } : {}),
        ...(asString(state.error) ? { error: asString(state.error) } : {}),
        models: modelsByAgent.get(agentId) ?? [],
      }];
    })
    .sort((left, right) => Number(right.primary) - Number(left.primary) || left.title.localeCompare(right.title));

  const now = Date.now();
  const pendingApprovals = [...approvals.values()].filter(
    (approval) => Number.isNaN(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) > now,
  );
  return { threads, activityByThread, pendingApprovals };
}

/** Compact controls for the primary Codex context; the Session remains the only chat. */
export function CodexAgentSettings({
  view,
  agents,
  identity,
  session,
  disabled,
  onControl,
}: {
  view: CodexPanelView;
  agents: Agent[];
  identity: Identity | null;
  session: Session | null;
  disabled: boolean;
  onControl: (payload: CodexControlRequest) => Promise<void>;
}) {
  const candidates = agents.filter(
    (agent) => agent.provider.toLowerCase() === 'openai' || view.threads.some((thread) => thread.agentId === agent.id),
  );
  const control = (payload: CodexControlInput) => onControl({ ...payload, requestId: requestId() } as CodexControlRequest);

  if (candidates.length === 0) return null;

  return (
    <div className="codex-agent-settings-list" aria-label="Codex agent settings">
      {candidates.map((agent) => {
        const thread = view.threads.find((candidate) => candidate.agentId === agent.id && candidate.primary && !candidate.archived);
        const canControl =
          !disabled &&
          identity?.kind === 'user' &&
          agent.online &&
          (session?.ownerId === identity.userId || agent.ownerUserId === identity.userId);
        const modelLabel = thread?.models.find((model) => model.id === thread.model)?.displayName ?? thread?.model ?? agent.model;
        return (
          <details className="codex-agent-settings" key={agent.id}>
            <summary>
              <span className="codex-settings-label">Codex settings</span>
              <span>{agent.name}</span>
              <span className={`codex-status status-${thread?.status ?? (agent.online ? 'idle' : 'offline')}`}>
                {thread?.status ?? (agent.online ? 'ready' : 'offline')}
              </span>
              <span className="codex-settings-model">{modelLabel}</span>
            </summary>
            {thread ? (
              <div className="codex-settings-body">
                <div className="codex-controls">
                  <label>
                    Model
                    <select
                      value={thread.model ?? ''}
                      disabled={!canControl || thread.models.length === 0}
                      onChange={(event) => void control({ agentId: agent.id, action: 'configureThread', threadId: thread.id, model: event.target.value })}
                    >
                      {thread.model && !thread.models.some((model) => model.id === thread.model) && <option value={thread.model}>{thread.model}</option>}
                      {thread.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                    </select>
                  </label>
                  <label>
                    Sandbox
                    <select
                      value={thread.sandbox}
                      disabled={!canControl}
                      onChange={(event) => void control({ agentId: agent.id, action: 'configureThread', threadId: thread.id, sandbox: event.target.value as CodexSandbox })}
                    >
                      <option value="readOnly">read only</option>
                      <option value="workspaceWrite">workspace write</option>
                      <option value="dangerFullAccess">danger full access</option>
                    </select>
                  </label>
                  <label>
                    Approvals
                    <select
                      value={thread.approvalPolicy}
                      disabled={!canControl}
                      onChange={(event) => void control({ agentId: agent.id, action: 'configureThread', threadId: thread.id, approvalPolicy: event.target.value as CodexApprovalPolicy })}
                    >
                      <option value="untrusted">untrusted</option>
                      <option value="on-request">on request</option>
                      <option value="never">never</option>
                    </select>
                  </label>
                </div>
                <button
                  type="button"
                  className="ghost"
                  disabled={!canControl || !thread.activeTurnId}
                  onClick={() => thread.activeTurnId && void control({ agentId: agent.id, action: 'interruptTurn', threadId: thread.id, turnId: thread.activeTurnId })}
                >
                  Stop
                </button>
                {thread.error && <div className="error-banner codex-error">{thread.error}</div>}
              </div>
            ) : (
              <div className="codex-settings-empty">Mention @{agent.name} in the session to start its Codex context.</div>
            )}
          </details>
        );
      })}
    </div>
  );
}

function approvalFrom(payload: Record<string, unknown>): CodexApprovalView | null {
  const requestId = asString(payload.requestId);
  const agentId = asString(payload.agentId);
  const threadId = asString(payload.threadId);
  const expiresAt = asString(payload.expiresAt);
  if (!requestId || !agentId || !threadId || !expiresAt) return null;
  return {
    requestId,
    agentId,
    threadId,
    kind: asString(payload.kind) || 'approval',
    ...(asString(payload.turnId) ? { turnId: asString(payload.turnId) } : {}),
    ...(asString(payload.itemId) ? { itemId: asString(payload.itemId) } : {}),
    ...(asString(payload.reason) ? { reason: asString(payload.reason) } : {}),
    ...(asString(payload.command) ? { command: asString(payload.command) } : {}),
    ...(asString(payload.cwd) ? { cwd: asString(payload.cwd) } : {}),
    ...(Array.isArray(payload.files) ? { files: payload.files.filter(isString) } : {}),
    availableDecisions: Array.isArray(payload.availableDecisions) ? payload.availableDecisions.filter(isDecision) : ['decline'],
    expiresAt,
  };
}

function requestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asApprovalPolicy(value: unknown): CodexApprovalPolicy | undefined {
  return value === 'untrusted' || value === 'on-request' || value === 'never' ? value : undefined;
}

function asSandbox(value: unknown): CodexSandbox | undefined {
  return value === 'readOnly' || value === 'workspaceWrite' || value === 'dangerFullAccess' ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isDecision(value: unknown): value is CodexApprovalResponse['decision'] {
  return value === 'accept' || value === 'acceptForSession' || value === 'decline' || value === 'cancel';
}
