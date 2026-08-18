import type { Actor, Event } from '@agentmesh/protocol';
import type { Principal } from '../auth/principal.js';
import type { EventSink } from '../services/eventLog.js';

export interface HubConnection {
  id: string;
  principal: Principal;
  /** Sessions this connection currently receives events for. */
  subscriptions: Set<string>;
  send(frame: unknown): void;
  close(code: number, reason: string): void;
}

/**
 * In-process registry of live connections and the fan-out path for committed
 * events.
 *
 * Presence is derived from this registry rather than stored: a row saying "Bob
 * is online" is a lie the moment a process dies, whereas an open socket is
 * evidence. The cost is that presence is per-process — the point at which
 * AgentMesh runs more than one process is the point at which this class grows a
 * Redis-backed sibling, which is why everything else talks to it through
 * `EventSink`.
 */
export class Hub implements EventSink {
  private readonly connections = new Map<string, HubConnection>();
  private readonly bySession = new Map<string, Set<HubConnection>>();

  add(connection: HubConnection): void {
    this.connections.set(connection.id, connection);
  }

  remove(connectionId: string): HubConnection | undefined {
    const connection = this.connections.get(connectionId);
    if (!connection) return undefined;
    for (const sessionId of connection.subscriptions) {
      this.bySession.get(sessionId)?.delete(connection);
      if (this.bySession.get(sessionId)?.size === 0) this.bySession.delete(sessionId);
    }
    this.connections.delete(connectionId);
    return connection;
  }

  subscribe(connection: HubConnection, sessionId: string): void {
    connection.subscriptions.add(sessionId);
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(connection);
  }

  unsubscribe(connection: HubConnection, sessionId: string): void {
    connection.subscriptions.delete(sessionId);
    const set = this.bySession.get(sessionId);
    set?.delete(connection);
    if (set && set.size === 0) this.bySession.delete(sessionId);
  }

  subscribers(sessionId: string): HubConnection[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  publish(event: Event): void {
    this.broadcast(event.sessionId, { type: 'event', payload: { event } });
  }

  /** Send an already-built frame body to every subscriber of a session. */
  broadcast(sessionId: string, frame: { type: string; payload: unknown }, exceptConnectionId?: string): void {
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.id === exceptConnectionId) continue;
      connection.send(frame);
    }
  }

  /** Ids of users with at least one live subscription to the session. */
  onlineUserIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.principal.kind === 'user') ids.add(connection.principal.userId);
    }
    return ids;
  }

  onlineAgentIds(sessionId: string): Set<string> {
    const ids = new Set<string>();
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.principal.kind === 'agent') ids.add(connection.principal.agentId);
    }
    return ids;
  }

  /** True when the actor still has another live connection to the session. */
  isOnline(sessionId: string, actor: Actor): boolean {
    if (actor.id === null) return false;
    const ids = actor.type === 'agent' ? this.onlineAgentIds(sessionId) : this.onlineUserIds(sessionId);
    return ids.has(actor.id);
  }

  /** Force-close every connection belonging to a principal, e.g. after revocation. */
  closeAgent(agentId: string, code: number, reason: string): void {
    for (const connection of this.connections.values()) {
      if (connection.principal.kind === 'agent' && connection.principal.agentId === agentId) {
        connection.close(code, reason);
      }
    }
  }

  closeUserSessionSubscriptions(userId: string, sessionId: string): void {
    for (const connection of this.bySession.get(sessionId) ?? []) {
      if (connection.principal.kind === 'user' && connection.principal.userId === userId) {
        this.unsubscribe(connection, sessionId);
        connection.send({ type: 'unsubscribed', payload: { sessionId } });
      }
    }
  }

  get connectionCount(): number {
    return this.connections.size;
  }
}
