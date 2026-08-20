import { createHash } from 'node:crypto';
import {
  ContextKind,
  DevEventType,
  type CodexApprovalResponse,
  type CodexControlRequest,
  type ContextEntry,
} from '@agentmesh/protocol';
import {
  CodexAppServer,
  sanitizeCodexNotification,
  type CodexAppServerOptions,
  type CodexApprovalDecision,
  type CodexApprovalPolicy,
  type CodexModel,
  type CodexSandbox,
  type CodexThread,
  type CodexTurn,
  type RpcNotification,
  type RpcServerRequest,
  type SanitizedCodexActivity,
} from './codex-app-server.js';

export interface CodexMesh {
  readonly sessionId: string;
  readonly identity: { kind: string; agentId?: string; name?: string } | null;
  publishEvent(type: string, payload: Record<string, unknown>): Promise<unknown>;
  publishContext(input: Record<string, unknown>): Promise<unknown>;
  getContext(kind?: typeof ContextKind.CodexThread): Promise<ContextEntry[]>;
  setStatus(status: 'idle' | 'working' | 'blocked' | 'offline', note?: string): Promise<unknown>;
  sendMessage(body: string, options?: { parentId?: string }): Promise<unknown>;
}

export interface CodexBridgeServer {
  listModels(): Promise<CodexModel[]>;
  startThread(input: {
    cwd: string;
    model?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandbox;
  }): Promise<CodexThread>;
  resumeThread(threadId: string): Promise<CodexThread>;
  startTurn(input: {
    threadId: string;
    prompt: string;
    cwd: string;
    model?: string;
    effort?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandbox;
  }): Promise<CodexTurn>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  archiveThread(threadId: string): Promise<unknown>;
  respondToApproval(requestId: number | string, decision: CodexApprovalDecision): void;
  respondToRequest(requestId: number | string, result: unknown): void;
  close(): void;
}

export interface CodexBridgeHandlers {
  onNotification: (message: RpcNotification) => void;
  onServerRequest: (message: RpcServerRequest) => void;
  onExit: (error: Error) => void;
}

interface ThreadRecord {
  id: string;
  title: string;
  model?: string;
  reasoningEffort?: string;
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
  primary: boolean;
  archived: boolean;
}

interface PendingTurn {
  answer: string;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
  rpcId: number | string;
  threadId: string;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexBridgeOptions {
  mesh: CodexMesh;
  workspace: string;
  command?: string;
  timeoutMs?: number;
  approvalTimeoutMs?: number;
  allowDangerFullAccess?: boolean;
  createServer?: (handlers: CodexBridgeHandlers) => Promise<CodexBridgeServer>;
}

/** Connects one AgentMesh agent to one local Codex app-server process. */
export class CodexBridge {
  private server: CodexBridgeServer | null = null;
  private starting: Promise<CodexBridgeServer> | null = null;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly loadedThreads = new Set<string>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly handledControlRequests = new Set<string>();
  private readonly handledApprovalResponses = new Set<string>();
  private models: CodexModel[] = [];
  private primaryThreadId: string | null = null;
  private stopped = false;

  constructor(private readonly options: CodexBridgeOptions) {}

  async start(): Promise<void> {
    await this.restoreThreads();
    await this.ensureServer();
  }

  async runMention(prompt: string): Promise<string> {
    const thread = this.primaryThreadId
      ? await this.ensureThreadLoaded(this.primaryThreadId)
      : await this.createThread({ primary: true });
    return this.runThread(thread.id, prompt, {});
  }

  async handleControl(control: CodexControlRequest): Promise<void> {
    if (!this.isTarget(control.agentId) || remember(this.handledControlRequests, control.requestId)) return;
    try {
      this.assertSandboxAllowed('sandbox' in control ? control.sandbox : undefined);
      switch (control.action) {
        case 'createThread':
          await this.createThread({
            primary: false,
            title: control.title,
            model: control.model,
            reasoningEffort: control.reasoningEffort,
            approvalPolicy: control.approvalPolicy,
            sandbox: control.sandbox,
          });
          return;
        case 'startTurn':
          void this.runThread(control.threadId, control.prompt, control)
            .then((answer) => this.options.mesh.sendMessage(answer))
            .catch((error: Error) => this.publishFailure(control.threadId, error));
          return;
        case 'interruptTurn':
          await (await this.ensureServer()).interruptTurn(control.threadId, control.turnId);
          return;
        case 'archiveThread':
          await (await this.ensureServer()).archiveThread(control.threadId);
          await this.markArchived(control.threadId);
          return;
        case 'setModel': {
          const thread = this.threads.get(control.threadId);
          if (!thread) throw new Error('Codex thread is not registered in this AgentMesh session.');
          thread.model = control.model;
          thread.reasoningEffort = control.reasoningEffort;
          await this.persistThread(thread);
          await this.publishState(thread, 'idle');
          return;
        }
        case 'configureThread': {
          const thread = this.threads.get(control.threadId);
          if (!thread) throw new Error('Codex thread is not registered in this AgentMesh session.');
          if (control.model !== undefined) thread.model = control.model;
          if (control.reasoningEffort !== undefined) thread.reasoningEffort = control.reasoningEffort;
          if (control.approvalPolicy !== undefined) thread.approvalPolicy = control.approvalPolicy;
          if (control.sandbox !== undefined) thread.sandbox = control.sandbox;
          await this.persistThread(thread);
          await this.publishState(thread, 'idle');
          return;
        }
      }
    } catch (error) {
      await this.publishFailure('threadId' in control ? control.threadId : undefined, error as Error);
    }
  }

  handleApproval(response: CodexApprovalResponse): void {
    if (!this.isTarget(response.agentId) || remember(this.handledApprovalResponses, response.requestId)) return;
    const pending = this.pendingApprovals.get(response.requestId);
    if (!pending || pending.threadId !== response.threadId) return;
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(response.requestId);
    this.server?.respondToApproval(pending.rpcId, response.decision);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const approval of this.pendingApprovals.values()) {
      clearTimeout(approval.timer);
      this.server?.respondToApproval(approval.rpcId, 'decline');
    }
    this.pendingApprovals.clear();
    this.server?.close();
    this.server = null;
    await this.publishState(undefined, 'offline').catch(() => undefined);
  }

  private async ensureServer(): Promise<CodexBridgeServer> {
    if (this.server) return this.server;
    if (this.starting) return this.starting;
    if (this.stopped) throw new Error('Codex bridge has stopped.');

    const handlers: CodexBridgeHandlers = {
      onNotification: (message) => this.onNotification(message),
      onServerRequest: (message) => this.onServerRequest(message),
      onExit: (error) => this.onExit(error),
    };
    const create = this.options.createServer ?? ((callbacks) => this.createDefaultServer(callbacks));
    this.starting = create(handlers)
      .then(async (server) => {
        this.server = server;
        this.models = await server.listModels();
        await this.publishState(this.primaryThreadId ? this.threads.get(this.primaryThreadId) : undefined, 'idle');
        return server;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private createDefaultServer(handlers: CodexBridgeHandlers): Promise<CodexAppServer> {
    const options: CodexAppServerOptions = {
      cwd: this.options.workspace,
      ...(this.options.command ? { command: this.options.command } : {}),
      ...handlers,
    };
    return CodexAppServer.start(options);
  }

  private async createThread(input: {
    primary: boolean;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandbox?: CodexSandbox;
  }): Promise<ThreadRecord> {
    this.assertSandboxAllowed(input.sandbox);
    const server = await this.ensureServer();
    const selectedModel = input.model ?? this.models.find((model) => model.isDefault)?.id ?? this.models[0]?.id;
    const remote = await server.startThread({
      cwd: this.options.workspace,
      ...(selectedModel ? { model: selectedModel } : {}),
      approvalPolicy: input.approvalPolicy ?? 'on-request',
      sandbox: input.sandbox ?? 'workspaceWrite',
    });
    const thread: ThreadRecord = {
      id: remote.id,
      title: input.title?.trim() || remote.name || remote.preview || `Codex ${this.threads.size + 1}`,
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      approvalPolicy: input.approvalPolicy ?? 'on-request',
      sandbox: input.sandbox ?? 'workspaceWrite',
      primary: input.primary,
      archived: false,
    };
    this.threads.set(thread.id, thread);
    this.loadedThreads.add(thread.id);
    if (thread.primary) this.primaryThreadId = thread.id;
    await this.persistThread(thread);
    await this.publishState(thread, 'idle');
    return thread;
  }

  private async ensureThreadLoaded(threadId: string): Promise<ThreadRecord> {
    const thread = this.threads.get(threadId);
    if (!thread || thread.archived) throw new Error('Codex thread is not active in this AgentMesh session.');
    if (!this.loadedThreads.has(threadId)) {
      await (await this.ensureServer()).resumeThread(threadId);
      this.loadedThreads.add(threadId);
    }
    return thread;
  }

  private async runThread(
    threadId: string,
    prompt: string,
    options: {
      model?: string;
      reasoningEffort?: string;
      approvalPolicy?: CodexApprovalPolicy;
      sandbox?: CodexSandbox;
    },
  ): Promise<string> {
    this.assertSandboxAllowed(options.sandbox);
    const thread = await this.ensureThreadLoaded(threadId);
    const server = await this.ensureServer();
    const turn = await server.startTurn({
      threadId,
      prompt,
      cwd: this.options.workspace,
      model: options.model ?? thread.model,
      effort: options.reasoningEffort ?? thread.reasoningEffort,
      approvalPolicy: options.approvalPolicy ?? thread.approvalPolicy,
      sandbox: options.sandbox ?? thread.sandbox,
    });
    await this.options.mesh.setStatus('working', `Codex thread ${thread.title}`);
    await this.publishState(thread, 'working', turn.id);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurns.delete(turn.id);
        void server.interruptTurn(threadId, turn.id).catch(() => undefined);
        reject(new Error('Codex turn timed out.'));
      }, this.options.timeoutMs ?? 10 * 60_000);
      this.pendingTurns.set(turn.id, { answer: '', resolve, reject, timer });
    });
  }

  private onNotification(message: RpcNotification): void {
    // App Server emits token-sized deltas. Persist the authoritative completed
    // reasoning/file item instead of turning each delta into a database write.
    if (message.method === 'item/reasoning/summaryTextDelta' || message.method === 'turn/diff/updated') return;
    const safe = sanitizeCodexNotification(message.method, message.params);
    if (!safe) return;
    const pending = safe.turnId ? this.pendingTurns.get(safe.turnId) : undefined;
    if (safe.kind === 'message' && pending && safe.summary) pending.answer = safe.summary;
    void this.publishActivity(safe);

    if (message.method === 'turn/completed' && safe.turnId && pending) {
      clearTimeout(pending.timer);
      this.pendingTurns.delete(safe.turnId);
      const status = safe.status ?? 'completed';
      if (status === 'completed') pending.resolve(pending.answer || 'Codex completed the turn without a text response.');
      else pending.reject(new Error(`Codex turn ended with status ${status}.`));
      const thread = this.threads.get(safe.threadId);
      void this.publishState(thread, status === 'completed' ? 'idle' : 'failed').catch(() => undefined);
      void this.options.mesh.setStatus(status === 'completed' ? 'idle' : 'blocked').catch(() => undefined);
    }
  }

  private onServerRequest(request: RpcServerRequest): void {
    if (request.method === 'item/permissions/requestApproval') {
      this.server?.respondToRequest(request.id, { permissions: {} });
      return;
    }
    if (request.method === 'mcpServer/elicitation/request') {
      this.server?.respondToRequest(request.id, { action: 'decline', content: null });
      return;
    }
    if (
      request.method !== 'item/commandExecution/requestApproval' &&
      request.method !== 'item/fileChange/requestApproval'
    ) {
      this.server?.respondToRequest(request.id, {});
      return;
    }
    const params = asObject(request.params);
    const threadId = asString(params.threadId);
    if (!threadId || !this.threads.has(threadId)) {
      this.server?.respondToApproval(request.id, 'decline');
      return;
    }
    const requestId = `codex-${String(request.id)}`;
    const timeoutMs = this.options.approvalTimeoutMs ?? 2 * 60_000;
    const timer = setTimeout(() => {
      this.pendingApprovals.delete(requestId);
      this.server?.respondToApproval(request.id, 'decline');
    }, timeoutMs);
    this.pendingApprovals.set(requestId, { rpcId: request.id, threadId, timer });
    const kind = request.method.includes('commandExecution')
      ? 'command'
      : request.method.includes('fileChange')
        ? 'fileChange'
        : 'fileChange';
    void this.options.mesh.publishEvent(DevEventType.CodexApprovalRequest, {
      requestId,
      agentId: this.agentId(),
      threadId,
      ...(asString(params.turnId) ? { turnId: asString(params.turnId) } : {}),
      ...(asString(params.itemId) ? { itemId: asString(params.itemId) } : {}),
      kind,
      ...(asString(params.reason) ? { reason: truncate(asString(params.reason), 2000) } : {}),
      ...(asString(params.command) ? { command: truncate(asString(params.command), 4000) } : {}),
      ...(asString(params.cwd) ? { cwd: truncate(asString(params.cwd), 1000) } : {}),
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
      expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
    });
    void this.publishState(this.threads.get(threadId), 'waitingForApproval', asString(params.turnId));
  }

  private onExit(error: Error): void {
    if (this.stopped) return;
    this.server = null;
    this.loadedThreads.clear();
    for (const pending of this.pendingTurns.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingTurns.clear();
    void this.publishState(undefined, 'offline', undefined, error.message).catch(() => undefined);
  }

  private async restoreThreads(): Promise<void> {
    const entries = await this.options.mesh.getContext(ContextKind.CodexThread).catch(() => [] as ContextEntry[]);
    const workspaceKey = this.workspaceKey();
    for (const entry of entries) {
      const data = entry.data;
      if (data.agentId !== this.agentId() || data.workspaceKey !== workspaceKey || typeof data.threadId !== 'string') continue;
      const thread: ThreadRecord = {
        id: data.threadId,
        title: typeof data.title === 'string' ? data.title : entry.title,
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
        ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
        approvalPolicy: isApprovalPolicy(data.approvalPolicy) ? data.approvalPolicy : 'on-request',
        sandbox: isSandbox(data.sandbox) ? data.sandbox : 'workspaceWrite',
        primary: data.primary === true,
        archived: data.archived === true,
      };
      this.threads.set(thread.id, thread);
      if (thread.primary && !thread.archived) this.primaryThreadId = thread.id;
    }
  }

  private persistThread(thread: ThreadRecord): Promise<unknown> {
    return this.options.mesh.publishContext({
      kind: ContextKind.CodexThread,
      key: `codex:${this.agentId()}:${thread.id}`.slice(0, 200),
      title: thread.title,
      data: {
        agentId: this.agentId(),
        threadId: thread.id,
        workspaceKey: this.workspaceKey(),
        title: thread.title,
        model: thread.model ?? '',
        reasoningEffort: thread.reasoningEffort ?? '',
        approvalPolicy: thread.approvalPolicy,
        sandbox: thread.sandbox,
        primary: thread.primary,
        archived: thread.archived,
      },
    });
  }

  private async markArchived(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    thread.archived = true;
    if (this.primaryThreadId === threadId) this.primaryThreadId = null;
    await this.persistThread(thread);
    await this.publishState(thread, 'archived');
  }

  private publishActivity(activity: SanitizedCodexActivity): Promise<unknown> {
    return this.options.mesh.publishEvent(DevEventType.CodexActivity, {
      agentId: this.agentId(),
      ...activity,
    });
  }

  private publishState(
    thread: ThreadRecord | undefined,
    status: 'offline' | 'idle' | 'working' | 'waitingForApproval' | 'failed' | 'archived',
    activeTurnId?: string,
    error?: string,
  ): Promise<unknown> {
    return this.options.mesh.publishEvent(DevEventType.CodexThreadState, {
      agentId: this.agentId(),
      ...(thread ? {
        threadId: thread.id,
        title: thread.title,
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        approvalPolicy: thread.approvalPolicy,
        sandbox: thread.sandbox,
        primary: thread.primary,
      } : {}),
      status,
      ...(activeTurnId ? { activeTurnId } : {}),
      ...(error ? { error: truncate(error, 2000) } : {}),
      models: this.models.slice(0, 100).map((model) => ({
        id: model.id,
        displayName: model.displayName,
        ...(model.isDefault !== undefined ? { isDefault: model.isDefault } : {}),
        ...(model.defaultReasoningEffort ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
        ...(model.supportedReasoningEfforts
          ? { supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort) }
          : {}),
      })),
    });
  }

  private publishFailure(threadId: string | undefined, error: Error): Promise<unknown> {
    return this.publishState(threadId ? this.threads.get(threadId) : undefined, 'failed', undefined, error.message);
  }

  private assertSandboxAllowed(sandbox: CodexSandbox | undefined): void {
    if (sandbox === 'dangerFullAccess' && !this.options.allowDangerFullAccess) {
      throw new Error('danger-full-access is disabled by the local runner; restart it with the explicit opt-in flag.');
    }
  }

  private isTarget(agentId: string): boolean {
    return agentId === this.agentId();
  }

  private agentId(): string {
    const identity = this.options.mesh.identity;
    if (identity?.kind !== 'agent' || !identity.agentId) throw new Error('Codex bridge requires an agent identity.');
    return identity.agentId;
  }

  private workspaceKey(): string {
    return createHash('sha256').update(this.options.workspace.toLowerCase()).digest('hex').slice(0, 24);
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isApprovalPolicy(value: unknown): value is CodexApprovalPolicy {
  return value === 'untrusted' || value === 'on-request' || value === 'never';
}

function isSandbox(value: unknown): value is CodexSandbox {
  return value === 'readOnly' || value === 'workspaceWrite' || value === 'dangerFullAccess';
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function remember(seen: Set<string>, requestId: string): boolean {
  if (seen.has(requestId)) return true;
  seen.add(requestId);
  if (seen.size > 1000) {
    const oldest = seen.values().next().value as string | undefined;
    if (oldest) seen.delete(oldest);
  }
  return false;
}
