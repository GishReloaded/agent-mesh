import { AgentMeshError, ErrorCode, type Actor, type Event } from '@agentmesh/protocol';
import { sql, type Transaction } from 'kysely';
import { jsonb, type Db } from '../db/client.js';
import type { Database } from '../db/types.js';
import { IdPrefix, newId } from '../ids.js';
import { toEvent } from '../mappers.js';

/**
 * Anything that wants to hear about committed events. The realtime hub is the
 * only implementation today; a Redis-backed fan-out would slot in here when a
 * deployment outgrows a single process.
 */
export interface EventSink {
  publish(event: Event): void;
}

/**
 * Payload of an event, or a factory that receives the sequence number the
 * event is about to get. The factory form exists because projections carry
 * their own `seq` — a message's position in the log is part of the message —
 * so they have to be written after the number is allocated but inside the same
 * transaction.
 */
export type EventPayload = Record<string, unknown>;
export type PayloadOrFactory =
  | EventPayload
  | ((seq: number, eventId: string) => EventPayload | Promise<EventPayload>);

export interface WriteContext {
  trx: Transaction<Database>;
  sessionId: string;
  /** Append an entry to the session log and return it with its assigned seq. */
  append(type: string, actor: Actor, payload: PayloadOrFactory): Promise<Event>;
}

/**
 * Every mutation in a session goes through here.
 *
 * `write` opens one transaction, hands the caller an `append` that allocates
 * sequence numbers, and only after the commit succeeds does it hand the events
 * to the sink. That ordering is deliberate: subscribers must never observe an
 * event that a rollback later erased.
 */
export class EventLog {
  constructor(
    private readonly db: Db,
    private readonly sink: EventSink,
  ) {}

  async write<T>(sessionId: string, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
    const pending: Event[] = [];

    const result = await this.db.transaction().execute(async (trx) => {
      const ctx: WriteContext = {
        trx,
        sessionId,
        append: async (type, actor, payload) => {
          const seq = await nextSeq(trx, sessionId);
          const eventId = newId(IdPrefix.Event);
          const resolved = typeof payload === 'function' ? await payload(seq, eventId) : payload;
          const row = await trx
            .insertInto('events')
            .values({
              id: eventId,
              session_id: sessionId,
              seq,
              type,
              actor_type: actor.type,
              actor_id: actor.id,
              actor_name: actor.name,
              payload: jsonb(resolved ?? {}),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          const event = toEvent(row);
          pending.push(event);
          return event;
        },
      };
      return fn(ctx);
    });

    for (const event of pending) this.sink.publish(event);
    return result;
  }

  /** Read a slice of the log, oldest first, for resume and history views. */
  async since(sessionId: string, sinceSeq: number, limit: number): Promise<Event[]> {
    const rows = await this.db
      .selectFrom('events')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('seq', '>', sinceSeq)
      .orderBy('seq', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toEvent);
  }

  /** Read backwards from `beforeSeq` for infinite scroll. Returns oldest first. */
  async before(sessionId: string, beforeSeq: number | undefined, limit: number): Promise<Event[]> {
    let query = this.db.selectFrom('events').selectAll().where('session_id', '=', sessionId);
    if (beforeSeq !== undefined) query = query.where('seq', '<', beforeSeq);
    const rows = await query.orderBy('seq', 'desc').limit(limit).execute();
    return rows.reverse().map(toEvent);
  }
}

/**
 * Allocate the next sequence number for a session.
 *
 * The `UPDATE ... RETURNING` takes a row lock on the session for the rest of
 * the transaction, so concurrent writers queue up instead of racing. Sessions
 * are the unit of contention, and a session is a handful of humans and agents —
 * serialising their writes costs nothing and buys a gap-free total order.
 */
async function nextSeq(trx: Transaction<Database>, sessionId: string): Promise<number> {
  const row = await trx
    .updateTable('sessions')
    .set({ last_seq: sql<number>`last_seq + 1`, updated_at: sql<Date>`now()` })
    .where('id', '=', sessionId)
    .where('archived_at', 'is', null)
    .returning('last_seq')
    .executeTakeFirst();

  if (!row) {
    const exists = await trx
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .executeTakeFirst();
    throw exists
      ? new AgentMeshError(ErrorCode.SessionArchived, 'This session is archived and accepts no new activity.')
      : new AgentMeshError(ErrorCode.NotFound, 'Session not found.');
  }
  return Number(row.last_seq);
}
