import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  type ContextEntry,
  type ContextListQuery,
  type ContextRevision,
  type PublishContextRequest,
} from '@agentmesh/protocol';
import { jsonb, type Db } from '../db/client.js';
import type { SessionAccess } from '../auth/principal.js';
import { IdPrefix, newId } from '../ids.js';
import { toContextEntry, toContextRevision } from '../mappers.js';
import { escapeLike } from './messages.js';
import type { EventLog } from './eventLog.js';

/**
 * Shared context is the part of AgentMesh that is not a chat.
 *
 * Entries are typed and keyed: publishing `api_contract:auth.login` twice
 * produces version 2 of one entry, not two competing descriptions. That is what
 * lets an agent ask "what is the current auth contract" and get an answer,
 * instead of replaying a conversation and guessing which message still holds.
 */
export class ContextService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
  ) {}

  async list(sessionId: string, filter: ContextListQuery = {}): Promise<ContextEntry[]> {
    let query = this.db.selectFrom('context_entries').selectAll().where('session_id', '=', sessionId);
    if (filter.kind) query = query.where('kind', '=', filter.kind);
    if (filter.key) query = query.where('key', '=', filter.key);
    const rows = await query.orderBy('kind', 'asc').orderBy('key', 'asc').execute();
    return rows.map(toContextEntry);
  }

  async get(sessionId: string, entryId: string): Promise<ContextEntry> {
    const row = await this.db
      .selectFrom('context_entries')
      .selectAll()
      .where('id', '=', entryId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Context entry not found.');
    return toContextEntry(row);
  }

  async revisions(sessionId: string, entryId: string): Promise<ContextRevision[]> {
    await this.get(sessionId, entryId);
    const rows = await this.db
      .selectFrom('context_revisions')
      .selectAll()
      .where('entry_id', '=', entryId)
      .orderBy('version', 'desc')
      .execute();
    return rows.map(toContextRevision);
  }

  /**
   * Create or supersede an entry. When `expectedVersion` is supplied the write
   * fails if someone else got there first — two agents publishing the same
   * contract concurrently should collide loudly, not silently overwrite.
   */
  async publish(access: SessionAccess, input: PublishContextRequest): Promise<ContextEntry> {
    const existing = await this.db
      .selectFrom('context_entries')
      .selectAll()
      .where('session_id', '=', access.sessionId)
      .where('kind', '=', input.kind)
      .where('key', '=', input.key)
      .executeTakeFirst();

    if (input.expectedVersion !== undefined) {
      const current = existing?.version ?? 0;
      if (current !== input.expectedVersion) {
        throw new AgentMeshError(
          ErrorCode.Conflict,
          `Context entry ${input.kind}:${input.key} is at version ${current}, not ${input.expectedVersion}.`,
          { details: { currentVersion: current } },
        );
      }
    }

    return this.log.write(access.sessionId, async (ctx) => {
      let result: ContextEntry | undefined;
      const eventType = existing ? LifecycleEventType.ContextUpdated : LifecycleEventType.ContextCreated;

      await ctx.append(eventType, access.actor, async () => {
        const now = new Date();
        const data = jsonb(input.data ?? {});
        const body = input.body ?? null;

        const row = existing
          ? await ctx.trx
              .updateTable('context_entries')
              .set({
                title: input.title,
                body,
                data,
                version: existing.version + 1,
                updated_by_type: access.actor.type,
                updated_by_id: access.actor.id,
                updated_by_name: access.actor.name,
                updated_at: now,
              })
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()
          : await ctx.trx
              .insertInto('context_entries')
              .values({
                id: newId(IdPrefix.Context),
                session_id: access.sessionId,
                kind: input.kind,
                key: input.key,
                title: input.title,
                body,
                data,
                version: 1,
                created_by_type: access.actor.type,
                created_by_id: access.actor.id,
                created_by_name: access.actor.name,
                updated_by_type: access.actor.type,
                updated_by_id: access.actor.id,
                updated_by_name: access.actor.name,
              })
              .returningAll()
              .executeTakeFirstOrThrow();

        // Every version is kept: a decision that was reversed is still part of
        // the project's history, and agents are asked to justify changes.
        await ctx.trx
          .insertInto('context_revisions')
          .values({
            id: newId(IdPrefix.Revision),
            entry_id: row.id,
            version: row.version,
            title: row.title,
            body: row.body,
            data: jsonb(row.data),
            author_type: access.actor.type,
            author_id: access.actor.id,
            author_name: access.actor.name,
          })
          .execute();

        result = toContextEntry(row);
        return existing ? { entry: result, previousVersion: existing.version } : { entry: result };
      });

      return result as ContextEntry;
    });
  }

  async remove(access: SessionAccess, entryId: string): Promise<void> {
    await this.get(access.sessionId, entryId);
    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.ContextDeleted, access.actor, async () => {
        await ctx.trx
          .deleteFrom('context_entries')
          .where('id', '=', entryId)
          .where('session_id', '=', access.sessionId)
          .execute();
        return { entryId };
      });
    });
  }

  async search(sessionId: string, query: string, limit: number): Promise<ContextEntry[]> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.db
      .selectFrom('context_entries')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where((eb) =>
        eb.or([eb('title', 'ilike', pattern), eb('body', 'ilike', pattern), eb('key', 'ilike', pattern)]),
      )
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toContextEntry);
  }
}
