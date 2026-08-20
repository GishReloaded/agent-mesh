import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  type UpdateProfileRequest,
  type User,
} from '@agentmesh/protocol';
import type { Db } from '../db/client.js';
import { toPublicUser, toUser } from '../mappers.js';
import { prepareAvatar, type AvatarStore } from '../storage/avatars.js';
import type { EventLog } from './eventLog.js';

/**
 * A person's own account: their name, their colour, their picture.
 *
 * The wrinkle is that a profile is global while the event log is per session.
 * Changing a colour therefore has to be announced into every session the
 * person belongs to, or everyone else keeps rendering the old one until they
 * reload. That fan-out is bounded by how many rooms one person is in, which is
 * a small number by the nature of the thing.
 */
export class ProfileService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly avatars: AvatarStore,
  ) {}

  async update(userId: string, input: UpdateProfileRequest): Promise<User> {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.displayName !== undefined) patch.display_name = input.displayName.trim();
    if (input.avatarColor !== undefined) patch.avatar_color = input.avatarColor;

    const row = await this.db
      .updateTable('users')
      .set(patch as never)
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Account not found.');

    await this.announce(userId);
    return toUser(row);
  }

  async setAvatar(userId: string, body: Buffer): Promise<User> {
    const existing = await this.db
      .selectFrom('users')
      .select('avatar_key')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!existing) throw new AgentMeshError(ErrorCode.NotFound, 'Account not found.');

    const { key, contentType } = prepareAvatar(userId, body);
    await this.avatars.put(key, body, contentType);

    const row = await this.db
      .updateTable('users')
      .set({ avatar_key: key, updated_at: new Date() })
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // Only after the new image is stored and referenced: losing the old one
    // before the new one is live would leave a gap where nothing renders.
    if (existing.avatar_key) await this.avatars.delete(existing.avatar_key).catch(() => undefined);

    await this.announce(userId);
    return toUser(row);
  }

  async clearAvatar(userId: string): Promise<User> {
    // Capture the key before the update: afterwards the column is null and
    // there is nothing left to point the delete at.
    const previous = await this.db
      .selectFrom('users')
      .select('avatar_key')
      .where('id', '=', userId)
      .executeTakeFirst();

    const row = await this.db
      .updateTable('users')
      .set({ avatar_key: null, updated_at: new Date() })
      .where('id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Account not found.');
    if (previous?.avatar_key) await this.avatars.delete(previous.avatar_key).catch(() => undefined);

    await this.announce(userId);
    return toUser(row);
  }

  /** Fetch an avatar by the key fragment that appears in its URL. */
  async readAvatar(userId: string, fragment: string): Promise<{ body: Buffer; contentType: string } | null> {
    const row = await this.db
      .selectFrom('users')
      .select('avatar_key')
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row?.avatar_key) return null;

    // The stored key is authoritative; the fragment only has to agree with it.
    // Reading whatever path a caller supplies is how a store becomes a
    // directory traversal.
    if (row.avatar_key.split('/').pop() !== fragment) return null;
    return this.avatars.get(row.avatar_key);
  }

  /** Tell every session this person is in that their profile changed. */
  private async announce(userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('users')
      .select(['id', 'display_name', 'avatar_color', 'avatar_key'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!row) return;

    const sessions = await this.db
      .selectFrom('session_members')
      .innerJoin('sessions', 'sessions.id', 'session_members.session_id')
      .select('session_members.session_id')
      .where('session_members.user_id', '=', userId)
      .where('sessions.archived_at', 'is', null)
      .execute();

    const user = toPublicUser(row);
    const actor = { type: 'user' as const, id: row.id, name: row.display_name };

    for (const { session_id: sessionId } of sessions) {
      await this.log
        .write(sessionId, async (ctx) => {
          await ctx.append(LifecycleEventType.ParticipantUpdated, actor, { user });
        })
        // One archived or concurrently deleted session must not fail the
        // profile change that already succeeded.
        .catch(() => undefined);
    }
  }
}
