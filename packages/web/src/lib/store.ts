import {
  RealtimeClient,
  type Agent,
  type ConnectionState,
  type ContextEntry,
  type Event as MeshEvent,
  type Identity,
  type Message,
  type Session,
  type SessionMember,
  type Task,
} from '@agentmesh/sdk';
import { api, ensureAccessToken, refreshAccessToken } from './auth.js';

export interface SessionView {
  session: Session | null;
  members: SessionMember[];
  agents: Agent[];
  messages: Message[];
  events: MeshEvent[];
  tasks: Task[];
  context: ContextEntry[];
  hasMoreMessages: boolean;
  loading: boolean;
}

export interface MeshState {
  connection: ConnectionState;
  identity: Identity | null;
  activeSessionId: string | null;
  view: SessionView;
  /** Unread message counts for sessions the user is not currently looking at. */
  unread: Record<string, number>;
  typing: { id: string; name: string }[];
  error: string | null;
}

const EMPTY_VIEW: SessionView = {
  session: null,
  members: [],
  agents: [],
  messages: [],
  events: [],
  tasks: [],
  context: [],
  hasMoreMessages: false,
  loading: true,
};

/**
 * A single realtime connection shared by the whole app.
 *
 * The store applies server events to local state rather than refetching, which
 * is what makes the UI feel live; the only refetches are the initial load and
 * an explicit `resync` when the server says the client fell too far behind.
 */
class MeshStore {
  private state: MeshState = {
    connection: 'idle',
    identity: null,
    activeSessionId: null,
    view: EMPTY_VIEW,
    unread: {},
    typing: [],
    error: null,
  };

  private listeners = new Set<() => void>();
  private client: RealtimeClient | null = null;
  private connecting: Promise<void> | null = null;
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MeshState => this.state;

  private set(patch: Partial<MeshState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private setView(patch: Partial<SessionView>): void {
    this.set({ view: { ...this.state.view, ...patch } });
  }

  /**
   * Open the shared realtime connection, once.
   *
   * The guard has to cover the whole async body, not just its first line: this
   * is called from the app shell and again when a session page mounts, and both
   * callers await a token and a version lookup before `this.client` is set. A
   * plain `if (this.client) return` lets both through and leaves two sockets
   * open per person - double the fan-out, double the billed messages, and an
   * orphan that nothing ever unsubscribes.
   */
  async connect(): Promise<void> {
    if (this.client) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.openConnection().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openConnection(): Promise<void> {
    const token = await ensureAccessToken();
    if (!token) return;

    // The realtime endpoint is not always this origin - on the serverless
    // deployment it is a separate gateway - so ask rather than assume.
    const client = new RealtimeClient({
      url: await api().resolveRealtimeUrl(),
      // Resolved per attempt: a socket that drops after the access token has
      // expired must reconnect with a new one, not the one it started with.
      token: ({ refresh }) => (refresh ? refreshAccessToken() : ensureAccessToken()),
      clientName: 'agentmesh-web',
    });
    this.client = client;

    client.on('state', (connection) => this.set({ connection }));
    client.on('hello', (identity) => this.set({ identity }));
    client.on('error', (error) => this.set({ error: error.message }));
    client.on('event', (event) => this.applyEvent(event));
    client.on('presence', ({ sessionId, actorId, actorType, online }) => {
      if (sessionId !== this.state.activeSessionId || !actorId) return;
      this.setView({
        members: this.state.view.members.map((member) =>
          member.user.id === actorId && actorType === 'user' ? { ...member, online } : member,
        ),
        agents: this.state.view.agents.map((agent) =>
          agent.id === actorId && actorType === 'agent'
            ? { ...agent, online, status: online ? agent.status : 'offline' }
            : agent,
        ),
      });
    });
    client.on('typing', ({ sessionId, actorId, active }) => {
      if (sessionId !== this.state.activeSessionId || !actorId) return;
      this.trackTyping(actorId, active);
    });
    client.on('resync', ({ sessionId }) => {
      if (sessionId === this.state.activeSessionId) void this.loadSession(sessionId);
    });
    client.on('subscribed', ({ sessionId, snapshot }) => {
      if (sessionId !== this.state.activeSessionId) return;
      this.setView({
        session: snapshot.session,
        members: snapshot.members,
        agents: snapshot.agents,
      });
    });

    await client.connect().catch((error: Error) => this.set({ error: error.message }));
  }

  disconnect(): void {
    this.client?.close();
    this.client = null;
    this.state = { ...this.state, connection: 'closed', identity: null };
  }

  get realtime(): RealtimeClient | null {
    return this.client;
  }

  /** Open a session: subscribe for live updates and load its current state. */
  async openSession(sessionId: string): Promise<void> {
    if (this.state.activeSessionId === sessionId) return;
    const previous = this.state.activeSessionId;
    if (previous && this.client) this.client.unsubscribe(previous);

    this.set({
      activeSessionId: sessionId,
      view: { ...EMPTY_VIEW, loading: true },
      unread: { ...this.state.unread, [sessionId]: 0 },
    });

    await this.connect();
    this.client?.subscribe(sessionId);
    await this.loadSession(sessionId);
  }

  closeSession(): void {
    const sessionId = this.state.activeSessionId;
    if (sessionId && this.client) this.client.unsubscribe(sessionId);
    this.set({ activeSessionId: null, view: EMPTY_VIEW });
  }

  private async loadSession(sessionId: string): Promise<void> {
    try {
      const rest = api();
      const [detail, messages, eventPage, tasks, context] = await Promise.all([
        rest.getSession(sessionId),
        rest.messages(sessionId, { limit: 50 }),
        rest.events(sessionId, { limit: 200 }),
        rest.tasks(sessionId),
        rest.context(sessionId),
      ]);
      this.setView({
        session: detail.session,
        members: detail.members,
        agents: detail.agents,
        messages: messages.items,
        events: eventPage.items.filter((event) => event.type === event.type.toUpperCase()),
        hasMoreMessages: messages.hasMore,
        tasks,
        context,
        loading: false,
      });
    } catch (error) {
      this.set({ error: (error as Error).message });
      this.setView({ loading: false });
    }
  }

  async loadOlderMessages(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    const oldest = this.state.view.messages[0];
    if (!sessionId || !oldest) return;
    const page = await api().messages(sessionId, { beforeSeq: oldest.seq, limit: 50 });
    this.setView({
      messages: [...page.items, ...this.state.view.messages],
      hasMoreMessages: page.hasMore,
    });
  }

  private applyEvent(event: MeshEvent): void {
    if (event.sessionId !== this.state.activeSessionId) {
      if (event.type === 'message.created') {
        const count = (this.state.unread[event.sessionId] ?? 0) + 1;
        this.set({ unread: { ...this.state.unread, [event.sessionId]: count } });
      }
      return;
    }

    const view = this.state.view;
    const payload = event.payload as Record<string, unknown>;

    switch (event.type) {
      case 'message.created': {
        const message = payload.message as Message;
        if (view.messages.some((existing) => existing.id === message.id)) return;
        this.setView({ messages: [...view.messages, message] });
        return;
      }
      case 'task.created': {
        this.setView({ tasks: [payload.task as Task, ...view.tasks] });
        return;
      }
      case 'task.updated': {
        const task = payload.task as Task;
        this.setView({ tasks: view.tasks.map((item) => (item.id === task.id ? task : item)) });
        return;
      }
      case 'task.deleted': {
        const taskId = payload.taskId as string;
        this.setView({ tasks: view.tasks.filter((item) => item.id !== taskId) });
        return;
      }
      case 'context.created':
      case 'context.updated': {
        const entry = payload.entry as ContextEntry;
        const exists = view.context.some((item) => item.id === entry.id);
        this.setView({
          context: exists ? view.context.map((item) => (item.id === entry.id ? entry : item)) : [entry, ...view.context],
        });
        return;
      }
      case 'context.deleted': {
        const entryId = payload.entryId as string;
        this.setView({ context: view.context.filter((item) => item.id !== entryId) });
        return;
      }
      case 'agent.registered': {
        this.setView({ agents: [...view.agents, payload.agent as Agent] });
        return;
      }
      case 'agent.status_changed': {
        const agentId = payload.agentId as string;
        const status = payload.status as Agent['status'];
        this.setView({
          agents: view.agents.map((agent) => (agent.id === agentId ? { ...agent, status } : agent)),
        });
        return;
      }
      case 'agent.revoked': {
        const agentId = payload.agentId as string;
        this.setView({ agents: view.agents.filter((agent) => agent.id !== agentId) });
        return;
      }
      case 'participant.joined': {
        void this.refreshMembers();
        return;
      }
      case 'participant.left': {
        const userId = payload.userId as string;
        this.setView({ members: view.members.filter((member) => member.user.id !== userId) });
        return;
      }
      case 'session.updated': {
        this.setView({ session: payload.session as Session });
        return;
      }
      default: {
        // Development events are shown in the activity feed as-is.
        this.setView({ events: [...view.events.slice(-200), event] });
      }
    }
  }

  private async refreshMembers(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (!sessionId) return;
    const members = await api().members(sessionId);
    this.setView({ members });
  }

  private trackTyping(actorId: string, active: boolean): void {
    const existing = this.typingTimers.get(actorId);
    if (existing) clearTimeout(existing);

    const name =
      this.state.view.members.find((member) => member.user.id === actorId)?.user.displayName ??
      this.state.view.agents.find((agent) => agent.id === actorId)?.name ??
      'someone';

    if (!active) {
      this.set({ typing: this.state.typing.filter((entry) => entry.id !== actorId) });
      return;
    }

    if (!this.state.typing.some((entry) => entry.id === actorId)) {
      this.set({ typing: [...this.state.typing, { id: actorId, name }] });
    }
    this.typingTimers.set(
      actorId,
      setTimeout(() => {
        this.set({ typing: this.state.typing.filter((entry) => entry.id !== actorId) });
        this.typingTimers.delete(actorId);
      }, 4000),
    );
  }

  clearError(): void {
    this.set({ error: null });
  }
}

export const store = new MeshStore();
