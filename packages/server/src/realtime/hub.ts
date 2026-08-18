import { ServerFrameType, type Actor, type Event } from '@agentmesh/protocol';
import type { ConnectionHandle, ConnectionRecord, ConnectionRegistry, EventSink } from './registry.js';

/**
 * In-process connection registry, used when AgentMesh runs as a normal server.
 *
 * Everything lives in memory because everything is in one process: the sockets
 * are held here, so presence is simply "is there an open connection". The cost
 * is that this is per-process, which is why the rest of the server talks to it
 * through `ConnectionRegistry` - the Lambda deployment swaps in a
 * database-backed implementation without touching a service.
 */
export class Hub implements ConnectionRegistry, EventSink {
  private readonly connections = new Map<string, ConnectionHandle>();
  private readonly bySession = new Map<string, Set<ConnectionHandle>>();

  async add(connection: ConnectionHandle): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  async remove(connectionId: string): Promise<ConnectionRecord | null> {
    const connection = this.connections.get(connectionId);
    if (!connection) return null;
    for (const sessionId of connection.subscriptions) {
      const set = this.bySession.get(sessionId);
      set?.delete(connection);
      if (set && set.size === 0) this.bySession.delete(sessionId);
    }
    this.connections.delete(connectionId);
    return connection;
  }

  async get(connectionId: string): Promise<ConnectionRecord | null> {
    return this.connections.get(connectionId) ?? null;
  }

  async subscribe(connectionId: string, sessionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.subscriptions.add(sessionId);
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(connection);
  }

  async unsubscribe(connectionId: string, sessionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.subscriptions.delete(sessionId);
    const set = this.bySession.get(sessionId);
    set?.delete(connection);
    if (set && set.size === 0) this.bySession.delete(sessionId);
  }

  async isSubscribed(connectionId: string, sessionId: string): Promise<boolean> {
    return this.connections.get(connectionId)?.subscriptions.has(sessionId) ?? false;
  }

  async broadcast(
    sessionId: string,
    frame: { type: string; payload: unknown },
    exceptConnectionId?: string,
  ): Promise<void> {
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.id === exceptConnectionId) continue;
      await connection.send(frame);
    }
  }

  async publish(event: Event): Promise<void> {
    await this.broadcast(event.sessionId, { type: ServerFrameType.Event, payload: { event } });
  }

  async onlineUserIds(sessionId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.principal.kind === 'user') ids.add(connection.principal.userId);
    }
    return ids;
  }

  async onlineAgentIds(sessionId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.principal.kind === 'agent') ids.add(connection.principal.agentId);
    }
    return ids;
  }

  async isOnline(sessionId: string, actor: Actor): Promise<boolean> {
    if (actor.id === null) return false;
    const ids = actor.type === 'agent' ? await this.onlineAgentIds(sessionId) : await this.onlineUserIds(sessionId);
    return ids.has(actor.id);
  }

  async closeAgent(agentId: string, code: number, reason: string): Promise<void> {
    for (const connection of this.connections.values()) {
      if (connection.principal.kind === 'agent' && connection.principal.agentId === agentId) {
        await connection.close(code, reason);
      }
    }
  }

  async dropUserFromSession(userId: string, sessionId: string): Promise<void> {
    for (const connection of [...(this.bySession.get(sessionId) ?? [])]) {
      if (connection.principal.kind === 'user' && connection.principal.userId === userId) {
        await this.unsubscribe(connection.id, sessionId);
        await connection.send({ type: ServerFrameType.Unsubscribed, payload: { sessionId } });
      }
    }
  }

  async dropSession(sessionId: string): Promise<void> {
    for (const connection of [...(this.bySession.get(sessionId) ?? [])]) {
      await connection.send({ type: ServerFrameType.Unsubscribed, payload: { sessionId } });
      await this.unsubscribe(connection.id, sessionId);
    }
  }

  /** Live handles for a session. Only meaningful for the in-process transport. */
  handles(sessionId: string): ConnectionHandle[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
