import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  PROTOCOL_LIMITS,
  parseMentions,
  toHandle,
  type CreateMessageRequest,
  type Mention,
  type MentionCandidate,
  type Message,
  type MessagePage,
} from '@agentmesh/protocol';
import { jsonb, type Db } from '../db/client.js';
import type { SessionAccess } from '../auth/principal.js';
import { IdPrefix, newId } from '../ids.js';
import { toMessage } from '../mappers.js';
import type { EventLog } from './eventLog.js';

export class MessageService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly agentChainLimit: number = PROTOCOL_LIMITS.agentChainLimit,
    private readonly agentChainWindowMs: number = PROTOCOL_LIMITS.agentChainWindowSeconds * 1000,
  ) {}

  /** Everyone who can be addressed with `@` in this session. */
  async mentionCandidates(sessionId: string): Promise<MentionCandidate[]> {
    const [users, agents] = await Promise.all([
      this.db
        .selectFrom('session_members')
        .innerJoin('users', 'users.id', 'session_members.user_id')
        .where('session_members.session_id', '=', sessionId)
        .select(['users.id', 'users.display_name'])
        .execute(),
      this.db
        .selectFrom('agents')
        .where('session_id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .select(['id', 'name'])
        .execute(),
    ]);

    return [
      ...users.map((row) => ({
        type: 'user' as const,
        id: row.id,
        handle: toHandle(row.display_name),
        displayName: row.display_name,
      })),
      ...agents.map((row) => ({
        type: 'agent' as const,
        id: row.id,
        handle: toHandle(row.name),
        displayName: row.name,
      })),
    ];
  }

  async create(access: SessionAccess, input: CreateMessageRequest): Promise<Message> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new AgentMeshError(ErrorCode.ValidationFailed, 'Message body cannot be empty.');
    }
    if (Buffer.byteLength(body, 'utf8') > PROTOCOL_LIMITS.messageBodyBytes) {
      throw new AgentMeshError(
        ErrorCode.PayloadTooLarge,
        `Message body exceeds ${PROTOCOL_LIMITS.messageBodyBytes} bytes.`,
      );
    }

    const candidates = await this.mentionCandidates(access.sessionId);
    const mentions = input.mentions?.length ? input.mentions : parseMentions(body, candidates);

    if (access.actor.type === 'agent') {
      await this.assertChainAllowed(access.sessionId, mentions);
    }

    return this.log.write(access.sessionId, async (ctx) => {
      let created: Message | undefined;
      await ctx.append(LifecycleEventType.MessageCreated, access.actor, async (seq) => {
        const row = await ctx.trx
          .insertInto('messages')
          .values({
            id: newId(IdPrefix.Message),
            session_id: access.sessionId,
            seq,
            author_type: access.actor.type,
            author_id: access.actor.id,
            author_name: access.actor.name,
            body,
            mentions: jsonb(mentions),
            parent_id: input.parentId ?? null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        created = toMessage(row);
        return { message: created };
      });
      return created as Message;
    });
  }

  /**
   * Refuse to extend an agent-to-agent exchange that has run away.
   *
   * Two models mentioning each other will happily keep going until someone's
   * budget runs out. The server counts agent-authored messages addressed at
   * agents inside a sliding window, and stops accepting them past the limit.
   *
   * A rate over a window rather than a run of consecutive messages: a real
   * exchange between two agents is worth letting finish, and cutting it off
   * after three turns punishes the case this project exists for. What has to
   * be stopped is the unbounded case, and a cap per window does that while
   * bounding the cost precisely.
   *
   * Any message from a person resets the count. That keeps the guard
   * human-in-the-loop rather than a timeout you have to sit out: if agents are
   * stuck, saying anything at all frees them.
   */
  private async assertChainAllowed(sessionId: string, mentions: readonly Mention[]): Promise<void> {
    const addressesAgent = mentions.some((mention) => mention.type === 'agent' || mention.type === 'all');
    if (!addressesAgent) return;

    const lastHuman = await this.db
      .selectFrom('messages')
      .select('seq')
      .where('session_id', '=', sessionId)
      .where('author_type', '=', 'user')
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();

    let query = this.db
      .selectFrom('messages')
      .select('mentions')
      .where('session_id', '=', sessionId)
      .where('author_type', '=', 'agent')
      .where('created_at', '>=', new Date(Date.now() - this.agentChainWindowMs));
    if (lastHuman) query = query.where('seq', '>', lastHuman.seq);

    // Bounded read: past the limit the exact count stops mattering.
    const recent = await query.orderBy('seq', 'desc').limit(this.agentChainLimit + 1).execute();

    const addressed = recent.filter((row) => {
      const rowMentions = Array.isArray(row.mentions) ? (row.mentions as Mention[]) : [];
      return rowMentions.some((mention) => mention.type === 'agent' || mention.type === 'all');
    }).length;

    if (addressed >= this.agentChainLimit) {
      const minutes = Math.round(this.agentChainWindowMs / 60_000);
      throw new AgentMeshError(
        ErrorCode.AgentChainLimit,
        `Agents have exchanged ${addressed} messages in the last ${minutes} minute(s) without a human. ` +
          'Someone needs to say something before they continue addressing each other.',
        { details: { limit: this.agentChainLimit, windowMs: this.agentChainWindowMs, observed: addressed } },
      );
    }
  }

  /** Newest-first page, walked backwards with `beforeSeq`. */
  async page(sessionId: string, beforeSeq: number | undefined, limit: number): Promise<MessagePage> {
    const take = Math.min(limit || PROTOCOL_LIMITS.defaultPageSize, PROTOCOL_LIMITS.maxPageSize);
    let query = this.db.selectFrom('messages').selectAll().where('session_id', '=', sessionId);
    if (beforeSeq !== undefined) query = query.where('seq', '<', beforeSeq);

    const rows = await query
      .orderBy('seq', 'desc')
      .limit(take + 1)
      .execute();

    const hasMore = rows.length > take;
    const page = rows.slice(0, take).reverse().map(toMessage);
    const oldest = page[0];

    return {
      items: page,
      nextCursor: hasMore && oldest ? oldest.seq : null,
      hasMore,
    };
  }

  async search(sessionId: string, query: string, limit: number): Promise<Message[]> {
    const rows = await this.db
      .selectFrom('messages')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('body', 'ilike', `%${escapeLike(query)}%`)
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toMessage);
  }
}

/** Escape LIKE wildcards so a search for `100%` does not match everything. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
