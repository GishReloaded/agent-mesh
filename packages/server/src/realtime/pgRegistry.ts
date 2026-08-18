import { ServerFrameType, type Actor, type Event } from '@agentmesh/protocol';
import type { Principal } from '../auth/principal.js';
import type { Db } from '../db/client.js';
import type { ConnectionHandle, ConnectionRecord, ConnectionRegistry, EventSink } from './registry.js';

/**
 * Sends a frame to one API Gateway connection. Implemented by the Lambda
 * transport; kept as a function so this file has no AWS SDK dependency and can
 * be tested without one.
 *
 * Must resolve `false` when the connection is gone (API Gateway answers 410),
 * so the registry can forget it.
 */
export type FrameSender = (connectionId: string, frame: unknown) => Promise<boolean>;

/** How long a connection may go without a frame before presence stops counting it. */
const STALE_AFTER_MS = 12 * 60 * 1000;

/**
 * Connection registry backed by PostgreSQL, for the serverless deployment.
 *
 * On Lambda nothing survives between frames: the sockets belong to API Gateway
 * and this process is created and destroyed around each message. So the same
 * facts the in-process hub keeps in memory - who is connected, what they are
 * subscribed to - are written to the database the deployment already has.
 * No second datastore is introduced for it.
 */
export class PostgresConnectionRegistry implements ConnectionRegistry, EventSink {
  constructor(
    private readonly db: Db,
    private readonly sendFrame: FrameSender,
  ) {}

  async add(connection: ConnectionHandle): Promise<void> {
    const principal = connection.principal;
    await this.db
      .insertInto('ws_connections')
      .values({
        id: connection.id,
        principal_kind: principal.kind,
        user_id: principal.kind === 'user' ? principal.userId : null,
        agent_id: principal.kind === 'agent' ? principal.agentId : null,
        agent_session_id: principal.kind === 'agent' ? principal.sessionId : null,
        agent_owner_id: principal.kind === 'agent' ? principal.ownerUserId : null,
        display_name: principal.kind === 'user' ? principal.displayName : principal.name,
        connected_at: new Date(),
        last_seen_at: new Date(),
      })
      .onConflict((oc) => oc.column('id').doUpdateSet({ last_seen_at: new Date() }))
      .execute();
  }

  async remove(connectionId: string): Promise<ConnectionRecord | null> {
    const record = await this.get(connectionId);
    // Subscriptions cascade.
    await this.db.deleteFrom('ws_connections').where('id', '=', connectionId).execute();
    return record;
  }

  async get(connectionId: string): Promise<ConnectionRecord | null> {
    const row = await this.db
      .selectFrom('ws_connections')
      .selectAll()
      .where('id', '=', connectionId)
      .executeTakeFirst();
    if (!row) return null;

    const subscriptions = await this.db
      .selectFrom('ws_subscriptions')
      .select('session_id')
      .where('connection_id', '=', connectionId)
      .execute();

    return {
      id: row.id,
      principal: toPrincipal(row),
      subscriptions: new Set(subscriptions.map((s) => s.session_id)),
    };
  }

  /** Refresh liveness. Called on every frame, which is what keeps presence honest. */
  async touch(connectionId: string): Promise<void> {
    await this.db
      .updateTable('ws_connections')
      .set({ last_seen_at: new Date() })
      .where('id', '=', connectionId)
      .execute();
  }

  async subscribe(connectionId: string, sessionId: string): Promise<void> {
    await this.db
      .insertInto('ws_subscriptions')
      .values({ connection_id: connectionId, session_id: sessionId, subscribed_at: new Date() })
      .onConflict((oc) => oc.columns(['connection_id', 'session_id']).doNothing())
      .execute();
  }

  async unsubscribe(connectionId: string, sessionId: string): Promise<void> {
    await this.db
      .deleteFrom('ws_subscriptions')
      .where('connection_id', '=', connectionId)
      .where('session_id', '=', sessionId)
      .execute();
  }

  async isSubscribed(connectionId: string, sessionId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('ws_subscriptions')
      .select('session_id')
      .where('connection_id', '=', connectionId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async broadcast(
    sessionId: string,
    frame: { type: string; payload: unknown },
    exceptConnectionId?: string,
  ): Promise<void> {
    const rows = await this.db
      .selectFrom('ws_subscriptions')
      .select('connection_id')
      .where('session_id', '=', sessionId)
      .execute();

    const targets = rows.map((row) => row.connection_id).filter((id) => id !== exceptConnectionId);
    if (targets.length === 0) return;

    const envelope = {
      v: 'agentmesh/v1',
      id: `s${Date.now().toString(36)}`,
      type: frame.type,
      ts: new Date().toISOString(),
      payload: frame.payload ?? {},
    };

    // Fan out in parallel; a connection API Gateway has already dropped is
    // removed rather than retried.
    const results = await Promise.all(
      targets.map(async (connectionId) => ({
        connectionId,
        alive: await this.sendFrame(connectionId, envelope).catch(() => false),
      })),
    );

    const dead = results.filter((result) => !result.alive).map((result) => result.connectionId);
    if (dead.length > 0) {
      await this.db.deleteFrom('ws_connections').where('id', 'in', dead).execute();
    }
  }

  async publish(event: Event): Promise<void> {
    await this.broadcast(event.sessionId, { type: ServerFrameType.Event, payload: { event } });
  }

  async onlineUserIds(sessionId: string): Promise<Set<string>> {
    const rows = await this.liveSubscribers(sessionId, 'user');
    return new Set(rows.map((row) => row.user_id).filter((id): id is string => id !== null));
  }

  async onlineAgentIds(sessionId: string): Promise<Set<string>> {
    const rows = await this.liveSubscribers(sessionId, 'agent');
    return new Set(rows.map((row) => row.agent_id).filter((id): id is string => id !== null));
  }

  async isOnline(sessionId: string, actor: Actor): Promise<boolean> {
    if (actor.id === null) return false;
    const ids = actor.type === 'agent' ? await this.onlineAgentIds(sessionId) : await this.onlineUserIds(sessionId);
    return ids.has(actor.id);
  }

  async closeAgent(agentId: string, code: number, reason: string): Promise<void> {
    const rows = await this.db
      .selectFrom('ws_connections')
      .select('id')
      .where('agent_id', '=', agentId)
      .execute();

    for (const row of rows) {
      // There is no "close with a code" over the management API, so the reason
      // is delivered as a final error frame before the connection is dropped.
      await this.sendFrame(row.id, {
        v: 'agentmesh/v1',
        id: `s${Date.now().toString(36)}`,
        type: ServerFrameType.Error,
        ts: new Date().toISOString(),
        payload: { code: 'INVALID_TOKEN', message: reason, details: { closeCode: code } },
      }).catch(() => false);
    }
    if (rows.length > 0) {
      await this.db
        .deleteFrom('ws_connections')
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
    }
  }

  async dropUserFromSession(userId: string, sessionId: string): Promise<void> {
    const rows = await this.db
      .selectFrom('ws_connections')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    if (rows.length === 0) return;

    const ids = rows.map((row) => row.id);
    await this.db
      .deleteFrom('ws_subscriptions')
      .where('connection_id', 'in', ids)
      .where('session_id', '=', sessionId)
      .execute();

    for (const id of ids) {
      await this.sendFrame(id, {
        v: 'agentmesh/v1',
        id: `s${Date.now().toString(36)}`,
        type: ServerFrameType.Unsubscribed,
        ts: new Date().toISOString(),
        payload: { sessionId },
      }).catch(() => false);
    }
  }

  async dropSession(sessionId: string): Promise<void> {
    // The session row is about to be deleted; its subscriptions cascade with it.
    await this.db.deleteFrom('ws_subscriptions').where('session_id', '=', sessionId).execute();
  }

  /** Remove connections that stopped sending frames without a $disconnect. */
  async sweepStale(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    const removed = await this.db
      .deleteFrom('ws_connections')
      .where('last_seen_at', '<', cutoff)
      .returning('id')
      .execute();
    return removed.length;
  }

  private async liveSubscribers(sessionId: string, kind: 'user' | 'agent') {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);
    return this.db
      .selectFrom('ws_subscriptions')
      .innerJoin('ws_connections', 'ws_connections.id', 'ws_subscriptions.connection_id')
      .where('ws_subscriptions.session_id', '=', sessionId)
      .where('ws_connections.principal_kind', '=', kind)
      .where('ws_connections.last_seen_at', '>=', cutoff)
      .select(['ws_connections.user_id', 'ws_connections.agent_id'])
      .execute();
  }
}

function toPrincipal(row: {
  principal_kind: 'user' | 'agent';
  user_id: string | null;
  agent_id: string | null;
  agent_session_id: string | null;
  agent_owner_id: string | null;
  display_name: string;
}): Principal {
  if (row.principal_kind === 'user') {
    return { kind: 'user', userId: row.user_id as string, displayName: row.display_name };
  }
  return {
    kind: 'agent',
    agentId: row.agent_id as string,
    sessionId: row.agent_session_id as string,
    name: row.display_name,
    ownerUserId: row.agent_owner_id as string,
  };
}
