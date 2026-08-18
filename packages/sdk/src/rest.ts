import {
  API_PREFIX,
  AgentMeshError,
  ErrorCode,
  errorResponseSchema,
  type AuthTokens,
  type Agent,
  type ContextEntry,
  type ContextListQuery,
  type ContextRevision,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type CreateMessageRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type Event as MeshEvent,
  type EventPage,
  type HistoryQuery,
  type Invite,
  type LoginRequest,
  type Message,
  type MessagePage,
  type PublishContextRequest,
  type PublishEventRequest,
  type RegisterAgentRequest,
  type RegisterAgentResponse,
  type RegisterRequest,
  type SearchResponse,
  type Session,
  type SessionDetail,
  type SessionMember,
  type SessionSummary,
  type Task,
  type TaskListQuery,
  type UpdateAgentRequest,
  type UpdateSessionRequest,
  type UpdateTaskRequest,
  type User,
  type VersionResponse,
} from '@agentmesh/protocol';

/** Pull something readable out of a fetch failure, including its cause chain. */
function describeCause(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    parts.push(code ? `${current.message} [${code}]` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(' <- ') : String(error);
}

export interface RestClientOptions {
  /** Base server URL, e.g. `http://localhost:4000`. */
  url: string;
  /** Bearer token: a user access token or an agent token. */
  token?: string;
  fetch?: typeof globalThis.fetch;
  /** Called when a request fails with 401 so callers can refresh and retry. */
  onUnauthorized?: () => Promise<string | null>;
}

/**
 * Thin, fully typed wrapper over the AgentMesh REST API.
 *
 * It deliberately has no runtime dependencies: the protocol package supplies
 * the types, `fetch` comes from the platform. That is what makes an AgentMesh
 * client implementable in any language — this file is a convenience, not a
 * requirement.
 */
export class RestClient {
  private token: string | undefined;
  private readonly base: string;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(private readonly options: RestClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  get baseUrl(): string {
    return this.base;
  }

  /** Websocket endpoint assumed to sit on this origin. */
  get websocketUrl(): string {
    return `${this.base.replace(/^http/, 'ws')}/ws`;
  }

  /**
   * Ask the server where its realtime endpoint is.
   *
   * Most deployments answer "same origin", but the serverless one terminates
   * WebSocket on a different gateway entirely. Asking costs one request at
   * startup and removes an assumption clients would otherwise bake in.
   */
  async resolveRealtimeUrl(): Promise<string> {
    try {
      const version = await this.version();
      return version.realtimeUrl ?? this.websocketUrl;
    } catch {
      return this.websocketUrl;
    }
  }

  async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, unknown>; retryOn401?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}${API_PREFIX}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      // `fetch` reports every transport failure as "fetch failed", which tells
      // the user nothing. The address being called is almost always the answer.
      throw new AgentMeshError(
        ErrorCode.Internal,
        `Could not reach the AgentMesh server at ${this.base} (${describeCause(cause)}). ` +
          'Check the URL, or sign in against the right server with: agentmesh login --url <url>',
        { cause },
      );
    }

    if (response.status === 401 && options.retryOn401 !== false && this.options.onUnauthorized) {
      const refreshed = await this.options.onUnauthorized();
      if (refreshed) {
        this.token = refreshed;
        return this.request<T>(method, path, { ...options, retryOn401: false });
      }
    }

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;

    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(payload);
      throw parsed.success
        ? AgentMeshError.fromBody(parsed.data.error)
        : new AgentMeshError(ErrorCode.Internal, `Request failed with status ${response.status}.`);
    }
    return payload as T;
  }

  // --- meta ---------------------------------------------------------------

  version(): Promise<VersionResponse> {
    return this.request('GET', '/version');
  }

  // --- auth ---------------------------------------------------------------

  register(body: RegisterRequest): Promise<AuthTokens> {
    return this.request('POST', '/auth/register', { body });
  }

  login(body: LoginRequest): Promise<AuthTokens> {
    return this.request('POST', '/auth/login', { body });
  }

  refresh(refreshToken: string): Promise<AuthTokens> {
    return this.request('POST', '/auth/refresh', { body: { refreshToken }, retryOn401: false });
  }

  logout(refreshToken: string): Promise<void> {
    return this.request('POST', '/auth/logout', { body: { refreshToken } });
  }

  me(): Promise<User> {
    return this.request('GET', '/auth/me');
  }

  // --- sessions -----------------------------------------------------------

  listSessions(): Promise<SessionSummary[]> {
    return this.request('GET', '/sessions');
  }

  createSession(body: CreateSessionRequest): Promise<Session> {
    return this.request('POST', '/sessions', { body });
  }

  getSession(sessionId: string): Promise<SessionDetail> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  updateSession(sessionId: string, body: UpdateSessionRequest): Promise<Session> {
    return this.request('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, { body });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
  }

  members(sessionId: string): Promise<SessionMember[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/members`);
  }

  removeMember(sessionId: string, userId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}/members/${userId}`);
  }

  // --- invites ------------------------------------------------------------

  createInvite(sessionId: string, body: CreateInviteRequest = { role: 'member' }): Promise<CreateInviteResponse> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/invites`, { body });
  }

  listInvites(sessionId: string): Promise<Invite[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/invites`);
  }

  revokeInvite(sessionId: string, inviteId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}/invites/${inviteId}`);
  }

  acceptInvite(token: string): Promise<SessionDetail & { alreadyMember: boolean }> {
    return this.request('POST', `/invites/${encodeURIComponent(token)}/accept`);
  }

  // --- agents -------------------------------------------------------------

  listAgents(sessionId: string): Promise<Agent[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/agents`);
  }

  registerAgent(sessionId: string, body: RegisterAgentRequest): Promise<RegisterAgentResponse> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/agents`, { body });
  }

  updateAgent(sessionId: string, agentId: string, body: UpdateAgentRequest): Promise<Agent> {
    return this.request('PATCH', `/sessions/${encodeURIComponent(sessionId)}/agents/${agentId}`, { body });
  }

  revokeAgent(sessionId: string, agentId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}/agents/${agentId}`);
  }

  // --- messages, events ---------------------------------------------------

  messages(sessionId: string, query: HistoryQuery = {}): Promise<MessagePage> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/messages`, { query });
  }

  /** Accepts plain text or the full request body. */
  sendMessage(sessionId: string, message: string | CreateMessageRequest): Promise<Message> {
    const body = typeof message === 'string' ? { body: message } : message;
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { body });
  }

  events(sessionId: string, query: HistoryQuery = {}): Promise<EventPage> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/events`, { query });
  }

  publishEvent(sessionId: string, body: PublishEventRequest): Promise<MeshEvent> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/events`, { body });
  }

  search(sessionId: string, q: string, limit?: number): Promise<SearchResponse> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/search`, { query: { q, limit } });
  }

  // --- tasks --------------------------------------------------------------

  tasks(sessionId: string, query: TaskListQuery = {}): Promise<Task[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/tasks`, { query });
  }

  createTask(sessionId: string, body: CreateTaskRequest): Promise<Task> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/tasks`, { body });
  }

  updateTask(sessionId: string, taskId: string, body: UpdateTaskRequest): Promise<Task> {
    return this.request('PATCH', `/sessions/${encodeURIComponent(sessionId)}/tasks/${taskId}`, { body });
  }

  deleteTask(sessionId: string, taskId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}/tasks/${taskId}`);
  }

  // --- shared context -----------------------------------------------------

  context(sessionId: string, query: ContextListQuery = {}): Promise<ContextEntry[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/context`, { query });
  }

  publishContext(sessionId: string, body: PublishContextRequest): Promise<ContextEntry> {
    return this.request('POST', `/sessions/${encodeURIComponent(sessionId)}/context`, { body });
  }

  contextRevisions(sessionId: string, entryId: string): Promise<ContextRevision[]> {
    return this.request('GET', `/sessions/${encodeURIComponent(sessionId)}/context/${entryId}/revisions`);
  }

  deleteContext(sessionId: string, entryId: string): Promise<void> {
    return this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}/context/${entryId}`);
  }
}
