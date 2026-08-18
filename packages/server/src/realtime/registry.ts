import type { Actor, Event } from '@agentmesh/protocol';
import type { Principal } from '../auth/principal.js';

/**
 * A live client connection, as far as the rest of the server is concerned.
 *
 * The interface exists because AgentMesh runs in two very different shapes. On
 * a normal server a connection is an open socket this process owns, and
 * sending is a method call. On Lambda the socket belongs to API Gateway, this
 * process is gone between frames, and sending is an HTTP request against the
 * management API. Everything above this line is written once for both.
 */
export interface ConnectionRecord {
  id: string;
  principal: Principal;
  /** Sessions this connection currently receives events for. */
  subscriptions: Set<string>;
}

export interface ConnectionHandle extends ConnectionRecord {
  send(frame: { type: string; payload?: unknown }, id?: string): Promise<void> | void;
  close(code: number, reason: string): Promise<void> | void;
}

/**
 * Where live connections and their subscriptions are kept.
 *
 * Presence is derived from this registry rather than stored as a flag: a row
 * saying someone is online becomes a lie the moment their process dies, while
 * a connection record that is cleaned up on disconnect is evidence.
 */
export interface ConnectionRegistry {
  add(connection: ConnectionHandle): Promise<void>;
  remove(connectionId: string): Promise<ConnectionRecord | null>;
  get(connectionId: string): Promise<ConnectionRecord | null>;

  subscribe(connectionId: string, sessionId: string): Promise<void>;
  unsubscribe(connectionId: string, sessionId: string): Promise<void>;
  isSubscribed(connectionId: string, sessionId: string): Promise<boolean>;

  /** Deliver an already-built frame to every subscriber of a session. */
  broadcast(
    sessionId: string,
    frame: { type: string; payload: unknown },
    exceptConnectionId?: string,
  ): Promise<void>;

  onlineUserIds(sessionId: string): Promise<Set<string>>;
  onlineAgentIds(sessionId: string): Promise<Set<string>>;
  isOnline(sessionId: string, actor: Actor): Promise<boolean>;

  /** Force-close every connection belonging to an agent, e.g. after revocation. */
  closeAgent(agentId: string, code: number, reason: string): Promise<void>;
  /** Drop a user's subscription to one session, e.g. when they are removed. */
  dropUserFromSession(userId: string, sessionId: string): Promise<void>;
  /** Unsubscribe everyone from a session that is going away. */
  dropSession(sessionId: string): Promise<void>;
}

/**
 * Anything that wants to hear about committed events. Implemented by the
 * in-process registry on a normal server, and by the API Gateway management
 * client on Lambda.
 */
export interface EventSink {
  publish(event: Event): Promise<void>;
}
