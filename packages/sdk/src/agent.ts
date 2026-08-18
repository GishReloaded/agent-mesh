import {
  DevEventType,
  type Agent,
  type AgentStatus,
  type ContextEntry,
  type ContextKind,
  type FileRef,
  type GitRef,
  type Identity,
  type Message,
  type SessionMember,
  type SessionSnapshot,
  type Task,
  type TaskStatus,
} from '@agentmesh/protocol';
import { RealtimeClient, type RealtimeEvents } from './realtime.js';
import { RestClient } from './rest.js';

export interface ConnectOptions {
  /** Server base URL, e.g. `http://localhost:4000`. */
  url: string;
  /** Agent token issued by `agentmesh agent register`, or a user access token. */
  token: string;
  /** Required when connecting with a user token; agent tokens carry their session. */
  sessionId?: string;
  clientName?: string;
  clientVersion?: string;
  WebSocketImpl?: typeof WebSocket;
  autoReconnect?: boolean;
}

/**
 * The interface an agent runtime talks to.
 *
 * Nothing here knows about models, prompts or providers — an AgentMesh agent is
 * whatever calls these methods. A shell script, a CI job and a frontier model
 * are all first-class participants.
 */
export class AgentMeshSession {
  private snapshot: SessionSnapshot | null = null;

  constructor(
    readonly rest: RestClient,
    readonly realtime: RealtimeClient,
    readonly sessionId: string,
  ) {}

  get identity(): Identity | null {
    return this.realtime.self;
  }

  /** Live session snapshot: participants, agents and open tasks. */
  get state(): SessionSnapshot | null {
    return this.snapshot;
  }

  get participants(): SessionMember[] {
    return this.snapshot?.members ?? [];
  }

  get agents(): Agent[] {
    return this.snapshot?.agents ?? [];
  }

  on<K extends keyof RealtimeEvents>(event: K, handler: (payload: RealtimeEvents[K]) => void): () => void {
    return this.realtime.on(event, handler);
  }

  /** Fires only for messages addressed to this participant (or `@all`). */
  onMention(handler: (message: Message) => void): () => void {
    return this.realtime.on('mention', handler);
  }

  // --- writing ------------------------------------------------------------

  async sendMessage(body: string, options: { parentId?: string } = {}): Promise<void> {
    await this.realtime.sendMessage(this.sessionId, body, options);
  }

  /** Reply to a message, addressing its author by mention. */
  async reply(message: Message, body: string): Promise<void> {
    const handle = message.author.name ? `@${slug(message.author.name)} ` : '';
    await this.realtime.sendMessage(this.sessionId, `${handle}${body}`, { parentId: message.id });
  }

  async sendTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    assignee?: { type: 'user' | 'agent'; id: string } | null;
    relatedFiles?: FileRef[];
    relatedCommits?: string[];
  }): Promise<string | undefined> {
    const ack = await this.realtime.createTask(this.sessionId, input);
    return ack.resourceId;
  }

  async updateTask(taskId: string, input: Record<string, unknown>): Promise<void> {
    await this.realtime.updateTask(this.sessionId, taskId, input);
  }

  /**
   * Publish or supersede a structured context entry. This is how an agent tells
   * the session something durable — a contract, a decision, a piece of state —
   * as opposed to saying it in chat where it scrolls away.
   */
  async publishContext(input: {
    kind: ContextKind;
    key: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    expectedVersion?: number;
  }): Promise<void> {
    await this.realtime.publishContext(this.sessionId, input);
  }

  async publishEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.realtime.publishEvent(this.sessionId, type, payload);
  }

  async setStatus(status: AgentStatus, note?: string): Promise<void> {
    await this.realtime.setStatus(this.sessionId, status, note);
  }

  /** Ask the session for help and mark this agent blocked. */
  async requestHelp(question: string, options: { audience?: string[]; taskId?: string } = {}): Promise<void> {
    await this.publishEvent(DevEventType.HelpRequested, {
      question,
      ...(options.audience ? { audience: options.audience } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
    });
    const mentions = (options.audience ?? ['all']).map((name) => `@${slug(name)}`).join(' ');
    await this.realtime.sendMessage(this.sessionId, `${mentions} ${question}`);
  }

  /** Report an API contract and record it in shared context in one step. */
  async publishApiContract(input: {
    service: string;
    method: string;
    endpoint: string;
    request?: Record<string, unknown>;
    response?: Record<string, unknown>;
    commit?: string;
    status?: string;
    note?: string;
  }): Promise<void> {
    const key = `${input.service}.${input.method.toLowerCase()}${input.endpoint}`;
    const existing = await this.rest
      .context(this.sessionId, { kind: 'api_contract', key })
      .catch(() => [] as ContextEntry[]);

    await this.publishContext({
      kind: 'api_contract',
      key,
      title: `${input.method.toUpperCase()} ${input.endpoint}`,
      ...(input.note ? { body: input.note } : {}),
      data: {
        service: input.service,
        method: input.method.toUpperCase(),
        endpoint: input.endpoint,
        request: input.request ?? {},
        response: input.response ?? {},
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    });

    await this.publishEvent(
      existing.length > 0 ? DevEventType.ApiContractUpdated : DevEventType.ApiContractCreated,
      {
        service: input.service,
        method: input.method.toUpperCase(),
        endpoint: input.endpoint,
        request: input.request ?? {},
        response: input.response ?? {},
        contextKey: key,
        ...(input.commit ? { commit: input.commit } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
    );
  }

  /** Report a commit. Self-reported: the server does not read your repository. */
  async reportCommit(git: GitRef, options: { message?: string; files?: FileRef[] } = {}): Promise<void> {
    await this.publishEvent(DevEventType.GitCommitCreated, {
      git,
      ...(options.message ? { message: options.message } : {}),
      ...(options.files ? { files: options.files } : {}),
    });
  }

  // --- reading ------------------------------------------------------------

  /**
   * The structured context of the session. This is what an agent should read
   * before working, instead of replaying the whole message history.
   */
  getContext(kind?: ContextKind): Promise<ContextEntry[]> {
    return this.rest.context(this.sessionId, kind ? { kind } : {});
  }

  getTasks(status?: TaskStatus): Promise<Task[]> {
    return this.rest.tasks(this.sessionId, status ? { status } : {});
  }

  getMessages(beforeSeq?: number, limit = 50) {
    return this.rest.messages(this.sessionId, { ...(beforeSeq ? { beforeSeq } : {}), limit });
  }

  /** Agents whose capability map matches every requested capability. */
  findAgents(capabilities: string[]): Agent[] {
    return this.agents.filter((agent) => capabilities.every((capability) => agent.capabilities[capability]));
  }

  close(): void {
    this.realtime.close();
  }

  /** @internal */
  setSnapshot(snapshot: SessionSnapshot): void {
    this.snapshot = snapshot;
  }
}

/**
 * Connect to an AgentMesh session.
 *
 * ```ts
 * const mesh = await connect({ url, token: process.env.AGENTMESH_TOKEN! });
 * mesh.onMention(async (message) => {
 *   await mesh.sendMessage(`Working on it.`);
 * });
 * ```
 */
export async function connect(options: ConnectOptions): Promise<AgentMeshSession> {
  const rest = new RestClient({ url: options.url, token: options.token });
  const realtime = new RealtimeClient({
    url: rest.websocketUrl,
    token: options.token,
    ...(options.sessionId ? { sessions: [options.sessionId] } : {}),
    ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
    ...(options.clientName ? { clientName: options.clientName } : {}),
    ...(options.clientVersion ? { clientVersion: options.clientVersion } : {}),
    ...(options.autoReconnect !== undefined ? { autoReconnect: options.autoReconnect } : {}),
  });

  const identity = await realtime.connect();
  const sessionId =
    options.sessionId ?? (identity.kind === 'agent' ? identity.sessionId : undefined);
  if (!sessionId) {
    realtime.close();
    throw new Error('sessionId is required when connecting with a user token.');
  }

  const session = new AgentMeshSession(rest, realtime, sessionId);
  realtime.on('subscribed', ({ sessionId: id, snapshot }) => {
    if (id === sessionId) session.setSnapshot(snapshot);
  });

  // An agent token auto-subscribes server-side; a user token must ask.
  if (identity.kind !== 'agent') realtime.subscribe(sessionId);

  await new Promise<void>((resolve) => {
    if (session.state) {
      resolve();
      return;
    }
    const off = realtime.on('subscribed', ({ sessionId: id }) => {
      if (id !== sessionId) return;
      off();
      resolve();
    });
  });

  return session;
}

function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
