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
  approvalsReviewer: CodexApprovalsReviewer;
  sandbox: CodexSandbox;
  primary: boolean;
  archived: boolean;
  status: string;
  activeTurnId?: string;
  contextTokens?: number;
  contextWindow?: number;
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
export type CodexApprovalsReviewer = 'user' | 'auto_review';
type CodexPermissionMode = 'ask' | 'autoReview' | 'fullAccess' | 'custom';

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
        ...(asString(state.reasoningEffort) || asString(data.reasoningEffort)
          ? { reasoningEffort: asString(state.reasoningEffort) || asString(data.reasoningEffort) }
          : {}),
        approvalPolicy: asApprovalPolicy(state.approvalPolicy) ?? asApprovalPolicy(data.approvalPolicy) ?? 'on-request',
        approvalsReviewer: asApprovalsReviewer(state.approvalsReviewer) ?? asApprovalsReviewer(data.approvalsReviewer) ?? 'user',
        sandbox: asSandbox(state.sandbox) ?? asSandbox(data.sandbox) ?? 'workspaceWrite',
        primary: data.primary === true,
        archived: data.archived === true || state.status === 'archived',
        status: asString(state.status) || (data.archived === true ? 'archived' : 'offline'),
        ...(asString(state.activeTurnId) ? { activeTurnId: asString(state.activeTurnId) } : {}),
        ...(asNonnegativeNumber(state.contextTokens) !== undefined ? { contextTokens: asNonnegativeNumber(state.contextTokens) } : {}),
        ...(asPositiveNumber(state.contextWindow) !== undefined ? { contextWindow: asPositiveNumber(state.contextWindow) } : {}),
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
    (agent) => agent.online && (
      agent.provider.toLowerCase() === 'openai' || view.threads.some((thread) => thread.agentId === agent.id)
    ),
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
        const selectedModel = thread?.models.find((model) => model.id === thread.model);
        const reasoningEfforts = selectedModel?.supportedReasoningEfforts ?? [];
        const reasoningEffort = thread?.reasoningEffort ?? selectedModel?.defaultReasoningEffort ?? '';
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
                {thread.contextTokens !== undefined && thread.contextWindow !== undefined && (
                  <div className="codex-context-usage" title={`${thread.contextTokens.toLocaleString()} of ${thread.contextWindow.toLocaleString()} tokens`}>
                    <div className="codex-context-label">
                      <span>Context {contextPercent(thread)}% used</span>
                      <span>{formatTokenCount(thread.contextTokens)} / {formatTokenCount(thread.contextWindow)} tokens</span>
                    </div>
                    <div className="codex-context-meter" role="progressbar" aria-label="Codex context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercent(thread)}>
                      <span style={{ width: `${contextPercent(thread)}%` }} />
                    </div>
                  </div>
                )}
                <div className="codex-controls">
                  <label>
                    Model
                    <select
                      value={thread.model ?? ''}
                      disabled={!canControl || thread.models.length === 0}
                      onChange={(event) => {
                        const model = thread.models.find((candidate) => candidate.id === event.target.value);
                        void control({
                          agentId: agent.id,
                          action: 'configureThread',
                          threadId: thread.id,
                          model: event.target.value,
                          ...(model?.defaultReasoningEffort ? { reasoningEffort: model.defaultReasoningEffort } : {}),
                        });
                      }}
                    >
                      {thread.model && !thread.models.some((model) => model.id === thread.model) && <option value={thread.model}>{thread.model}</option>}
                      {thread.models.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}
                    </select>
                  </label>
                  <label>
                    Reasoning effort
                    <select
                      value={reasoningEffort}
                      disabled={!canControl || reasoningEfforts.length === 0}
                      onChange={(event) => void control({
                        agentId: agent.id,
                        action: 'configureThread',
                        threadId: thread.id,
                        reasoningEffort: event.target.value,
                      })}
                    >
                      {reasoningEffort && !reasoningEfforts.includes(reasoningEffort) && (
                        <option value={reasoningEffort}>{formatReasoningEffort(reasoningEffort)}</option>
                      )}
                      {reasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>{formatReasoningEffort(effort)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Permissions
                    <select
                      value={permissionMode(thread)}
                      disabled={!canControl}
                      onChange={(event) => void control({
                        agentId: agent.id,
                        action: 'configureThread',
                        threadId: thread.id,
                        ...permissionSettings(event.target.value as Exclude<CodexPermissionMode, 'custom'>),
                      })}
                    >
                      {permissionMode(thread) === 'custom' && <option value="custom">Custom</option>}
                      <option value="ask">Ask for approval</option>
                      <option value="autoReview">Approve for me</option>
                      <option value="fullAccess">Full access</option>
                    </select>
                    <span className={`codex-permissions-hint${permissionMode(thread) === 'fullAccess' ? ' danger' : ''}`}>
                      {permissionDescription(permissionMode(thread))}
                    </span>
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

function contextPercent(thread: Pick<CodexThreadView, 'contextTokens' | 'contextWindow'>): number {
  if (thread.contextTokens === undefined || thread.contextWindow === undefined) return 0;
  return Math.min(100, Math.max(0, Math.round((thread.contextTokens / thread.contextWindow) * 100)));
}

function formatTokenCount(value: number): string {
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
}

function formatReasoningEffort(effort: string): string {
  return effort.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function permissionMode(thread: Pick<CodexThreadView, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'>): CodexPermissionMode {
  if (thread.sandbox === 'dangerFullAccess' && thread.approvalPolicy === 'never') return 'fullAccess';
  if (thread.sandbox === 'workspaceWrite' && thread.approvalPolicy === 'on-request') {
    return thread.approvalsReviewer === 'auto_review' ? 'autoReview' : 'ask';
  }
  return 'custom';
}

function permissionSettings(mode: Exclude<CodexPermissionMode, 'custom'>): {
  sandbox: CodexSandbox;
  approvalPolicy: CodexApprovalPolicy;
  approvalsReviewer: CodexApprovalsReviewer;
} {
  if (mode === 'fullAccess') {
    return { sandbox: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: 'user' };
  }
  return {
    sandbox: 'workspaceWrite',
    approvalPolicy: 'on-request',
    approvalsReviewer: mode === 'autoReview' ? 'auto_review' : 'user',
  };
}

function permissionDescription(mode: CodexPermissionMode): string {
  if (mode === 'fullAccess') return 'Unrestricted files and network; Codex never asks.';
  if (mode === 'autoReview') return 'Codex reviews eligible requests; the workspace stays sandboxed.';
  if (mode === 'ask') return 'Codex asks before network access or leaving the workspace.';
  return 'Custom permission settings are active.';
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

function asNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asApprovalPolicy(value: unknown): CodexApprovalPolicy | undefined {
  return value === 'untrusted' || value === 'on-request' || value === 'never' ? value : undefined;
}

function asApprovalsReviewer(value: unknown): CodexApprovalsReviewer | undefined {
  return value === 'user' || value === 'auto_review' ? value : undefined;
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
