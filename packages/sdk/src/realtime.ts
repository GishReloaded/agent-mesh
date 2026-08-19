import {
  AgentMeshError,
  ClientFrameType,
  CloseCode,
  ErrorCode,
  PROTOCOL_VERSION,
  RECONNECT_BACKOFF,
  ServerFrameType,
  mentionsActor,
  type AgentStatus,
  type ContextEntry,
  type Event as MeshEvent,
  type Identity,
  type Message,
  type SessionSnapshot,
  type Task,
} from '@agentmesh/protocol';
import { Emitter } from './emitter.js';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface RealtimeEvents {
  state: ConnectionState;
  hello: Identity;
  subscribed: { sessionId: string; snapshot: SessionSnapshot };
  /** Every entry appended to a subscribed session's log. */
  event: MeshEvent;
  message: Message;
  /** A message addressed to this client, by mention or broadcast. */
  mention: Message;
  task: Task;
  context: ContextEntry;
  presence: { sessionId: string; actorId: string | null; actorType: string; online: boolean };
  typing: { sessionId: string; actorId: string | null; active: boolean };
  /** The client fell too far behind; refetch state for this session. */
  resync: { sessionId: string; lastSeq: number };
  error: AgentMeshError;
  close: { code: number; reason: string };
}

export interface RealtimeOptions {
  url: string;
  /**
   * The credential to present in `hello`.
   *
   * A function is resolved on every connection attempt, which is what lets a
   * browser client hand over a freshly refreshed access token after a drop.
   * `refresh` is true when the previous attempt was rejected, so the provider
   * knows a cached credential will not do. Agent tokens never expire, so a
   * plain string is right for them.
   */
  token: string | ((options: { refresh: boolean }) => string | null | Promise<string | null>);
  /** Sessions to subscribe to once connected. Agents may omit this. */
  sessions?: string[];
  /** Injectable for runtimes without a global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  clientName?: string;
  clientVersion?: string;
  /** Set false to disable automatic reconnection. */
  autoReconnect?: boolean;
}

interface Pending {
  resolve: (value: { seq?: number; resourceId?: string }) => void;
  reject: (error: AgentMeshError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const ACK_TIMEOUT_MS = 15_000;

/**
 * Realtime half of the SDK: one socket, many session subscriptions,
 * reconnection with resume.
 *
 * The client tracks the highest `seq` it has applied per session. On
 * reconnect it re-subscribes with that cursor and the server replays the gap,
 * so a dropped connection costs nothing but latency. If the gap is too large
 * the server answers `resync` and the application refetches — losing events
 * silently is not one of the options.
 */
export class RealtimeClient {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  private readonly cursors = new Map<string, number>();
  private readonly subscriptions = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private reconnectAttempt = 0;
  /** Guards against looping on a credential the server keeps rejecting. */
  private unauthorizedRetries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private frameCounter = 0;
  private identity: Identity | null = null;

  readonly events = new Emitter<RealtimeEvents>();

  constructor(private readonly options: RealtimeOptions) {
    for (const sessionId of options.sessions ?? []) this.subscriptions.add(sessionId);
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get self(): Identity | null {
    return this.identity;
  }

  /** Highest sequence number applied for a session. */
  cursor(sessionId: string): number | undefined {
    return this.cursors.get(sessionId);
  }

  on = this.events.on.bind(this.events);
  once = this.events.once.bind(this.events);
  off = this.events.off.bind(this.events);

  async connect(): Promise<Identity> {
    this.closedByUser = false;
    return new Promise<Identity>((resolve, reject) => {
      const offHello = this.events.once('hello', (identity) => {
        offError();
        resolve(identity);
      });
      const offError = this.events.once('error', (error) => {
        offHello();
        reject(error);
      });
      void this.open();
    });
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.setState('closed');
    this.socket?.close(CloseCode.Normal, 'client closed');
    this.socket = null;
  }

  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    if (this.state === 'connected') {
      this.send(ClientFrameType.Subscribe, {
        sessionId,
        ...(this.cursors.has(sessionId) ? { sinceSeq: this.cursors.get(sessionId) } : {}),
      });
    }
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    if (this.state === 'connected') this.send(ClientFrameType.Unsubscribe, { sessionId });
  }

  sendMessage(sessionId: string, body: string, options: { parentId?: string } = {}) {
    return this.request(ClientFrameType.MessageSend, {
      sessionId,
      body,
      ...(options.parentId ? { parentId: options.parentId } : {}),
    });
  }

  createTask(sessionId: string, input: Record<string, unknown>) {
    return this.request(ClientFrameType.TaskCreate, { sessionId, ...input });
  }

  updateTask(sessionId: string, taskId: string, input: Record<string, unknown>) {
    return this.request(ClientFrameType.TaskUpdate, { sessionId, taskId, ...input });
  }

  publishContext(sessionId: string, input: Record<string, unknown>) {
    return this.request(ClientFrameType.ContextPublish, { sessionId, ...input });
  }

  publishEvent(sessionId: string, type: string, payload: unknown) {
    return this.request(ClientFrameType.EventPublish, { sessionId, type, payload });
  }

  setStatus(sessionId: string, status: AgentStatus, note?: string) {
    return this.request(ClientFrameType.AgentStatus, { sessionId, status, ...(note ? { note } : {}) });
  }

  setTyping(sessionId: string, active: boolean): void {
    if (this.state === 'connected') this.send(ClientFrameType.Typing, { sessionId, active });
  }

  // -------------------------------------------------------------------------

  private async open(): Promise<void> {
    const Impl = this.options.WebSocketImpl ?? globalThis.WebSocket;
    if (!Impl) {
      this.events.emit(
        'error',
        new AgentMeshError(ErrorCode.Internal, 'No WebSocket implementation available in this runtime.'),
      );
      return;
    }

    // Resolved before connecting, so a reconnect after a long drop presents a
    // current credential rather than the one that expired while we were away.
    let token: string | null;
    try {
      token =
        typeof this.options.token === 'function'
          ? await this.options.token({ refresh: this.unauthorizedRetries > 0 })
          : this.options.token;
    } catch {
      token = null;
    }
    if (!token) {
      this.setState('closed');
      this.events.emit('error', new AgentMeshError(ErrorCode.Unauthorized, 'No credential available to connect.'));
      return;
    }
    if (this.closedByUser) return;

    this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const socket = new Impl(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      // The token goes in the first frame rather than the URL so it never
      // appears in a proxy log or a browser history entry.
      this.send(ClientFrameType.Hello, {
        token,
        client: {
          name: this.options.clientName ?? 'agentmesh-sdk',
          version: this.options.clientVersion ?? '0.1.0',
        },
      });
    };

    socket.onmessage = (message: MessageEvent) => {
      this.handleFrame(typeof message.data === 'string' ? message.data : String(message.data));
    };

    socket.onerror = () => {
      // `onclose` always follows; the error event carries nothing useful.
    };

    socket.onclose = (event: CloseEvent) => {
      this.socket = null;
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new AgentMeshError(ErrorCode.Internal, 'Connection closed before acknowledgement.'));
      }
      this.pending.clear();
      this.events.emit('close', { code: event.code, reason: event.reason });

      if (this.closedByUser || !(this.options.autoReconnect ?? true)) {
        this.setState('closed');
        return;
      }
      if (event.code === CloseCode.Unauthorized || event.code === CloseCode.TokenRevoked) {
        // An expired access token looks exactly like a bad one from here. When
        // the caller can produce a fresh credential, it is worth one more
        // attempt; when that also fails, the credential really is rejected and
        // retrying would just hammer the server.
        if (typeof this.options.token === 'function' && this.unauthorizedRetries === 0) {
          this.unauthorizedRetries += 1;
          this.scheduleReconnect();
          return;
        }
        this.setState('closed');
        this.events.emit(
          'error',
          new AgentMeshError(ErrorCode.Unauthorized, event.reason || 'Connection rejected by server.'),
        );
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    const { initialMs, maxMs, factor, jitter } = RECONNECT_BACKOFF;
    const base = Math.min(maxMs, initialMs * factor ** this.reconnectAttempt);
    const delay = base * (1 - jitter + Math.random() * jitter * 2);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.open(), delay);
  }

  private handleFrame(raw: string): void {
    let frame: { type?: string; id?: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;

    switch (frame.type) {
      case ServerFrameType.HelloOk: {
        this.reconnectAttempt = 0;
        this.unauthorizedRetries = 0;
        this.setState('connected');
        this.identity = payload.identity as Identity;
        this.events.emit('hello', this.identity);
        for (const sessionId of this.subscriptions) {
          const sinceSeq = this.cursors.get(sessionId);
          this.send(ClientFrameType.Subscribe, {
            sessionId,
            ...(sinceSeq !== undefined ? { sinceSeq } : {}),
          });
        }
        return;
      }

      case ServerFrameType.Subscribed: {
        const sessionId = payload.sessionId as string;
        const snapshot = payload.snapshot as SessionSnapshot;
        this.subscriptions.add(sessionId);
        this.cursors.set(sessionId, Math.max(this.cursors.get(sessionId) ?? 0, snapshot.lastSeq));
        this.events.emit('subscribed', { sessionId, snapshot });
        for (const event of (payload.replayed as MeshEvent[]) ?? []) this.applyEvent(event);
        return;
      }

      case ServerFrameType.Event: {
        this.applyEvent(payload.event as MeshEvent);
        return;
      }

      case ServerFrameType.Ack: {
        const ref = payload.ref as string;
        const pending = this.pending.get(ref);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(ref);
          pending.resolve({ seq: payload.seq as number, resourceId: payload.resourceId as string });
        }
        return;
      }

      case ServerFrameType.Error: {
        const error = AgentMeshError.fromBody({
          code: String(payload.code ?? ErrorCode.Internal),
          message: String(payload.message ?? 'Unknown error.'),
          details: payload.details,
          ...(payload.ref ? { ref: String(payload.ref) } : {}),
        });
        const ref = payload.ref as string | undefined;
        if (ref && this.pending.has(ref)) {
          const pending = this.pending.get(ref);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(ref);
            pending.reject(error);
          }
          return;
        }
        this.events.emit('error', error);
        return;
      }

      case ServerFrameType.Presence: {
        const actor = payload.actor as { id: string | null; type: string };
        this.events.emit('presence', {
          sessionId: payload.sessionId as string,
          actorId: actor?.id ?? null,
          actorType: actor?.type ?? 'user',
          online: Boolean(payload.online),
        });
        return;
      }

      case ServerFrameType.Typing: {
        const actor = payload.actor as { id: string | null };
        this.events.emit('typing', {
          sessionId: payload.sessionId as string,
          actorId: actor?.id ?? null,
          active: Boolean(payload.active),
        });
        return;
      }

      case ServerFrameType.Resync: {
        const sessionId = payload.sessionId as string;
        this.cursors.delete(sessionId);
        this.events.emit('resync', { sessionId, lastSeq: payload.lastSeq as number });
        return;
      }

      default:
        return;
    }
  }

  private applyEvent(event: MeshEvent | undefined): void {
    if (!event) return;
    this.cursors.set(event.sessionId, Math.max(this.cursors.get(event.sessionId) ?? 0, event.seq));
    this.events.emit('event', event);

    const payload = event.payload as Record<string, unknown> | undefined;
    switch (event.type) {
      case 'message.created': {
        const message = payload?.message as Message | undefined;
        if (!message) return;
        this.events.emit('message', message);
        if (this.isAddressedToMe(message)) this.events.emit('mention', message);
        return;
      }
      case 'task.created':
      case 'task.updated': {
        const task = payload?.task as Task | undefined;
        if (task) this.events.emit('task', task);
        return;
      }
      case 'context.created':
      case 'context.updated': {
        const entry = payload?.entry as ContextEntry | undefined;
        if (entry) this.events.emit('context', entry);
        return;
      }
      default:
        return;
    }
  }

  /** True when a message mentions this client, and it did not send it itself. */
  private isAddressedToMe(message: Message): boolean {
    const identity = this.identity;
    if (!identity) return false;
    const me =
      identity.kind === 'agent'
        ? { type: 'agent' as const, id: identity.agentId }
        : { type: 'user' as const, id: identity.userId };
    if (message.author.type === me.type && message.author.id === me.id) return false;
    return mentionsActor(message.mentions, me);
  }

  private nextFrameId(): string {
    this.frameCounter += 1;
    return `c${Date.now().toString(36)}-${this.frameCounter.toString(36)}`;
  }

  private send(type: string, payload: unknown, id = this.nextFrameId()): string {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new AgentMeshError(ErrorCode.Internal, 'Not connected.');
    }
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, ts: new Date().toISOString(), payload }));
    return id;
  }

  /** Send a frame and wait for its `ack`, or the matching `error`. */
  private request(type: string, payload: unknown): Promise<{ seq?: number; resourceId?: string }> {
    return new Promise((resolve, reject) => {
      const id = this.nextFrameId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentMeshError(ErrorCode.Internal, `Timed out waiting for acknowledgement of ${type}.`));
      }, ACK_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(type, payload, id);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as AgentMeshError);
      }
    });
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit('state', state);
  }
}
