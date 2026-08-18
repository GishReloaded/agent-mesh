import {
  AgentMeshError,
  ErrorCode,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type Invite,
} from '@agentmesh/protocol';
import type { Db } from '../db/client.js';
import type { SessionAccess } from '../auth/principal.js';
import { TokenPrefix, createOpaqueToken, hashToken } from '../auth/tokens.js';
import { IdPrefix, newId } from '../ids.js';
import { toInvite } from '../mappers.js';
import type { SessionService } from './sessions.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export class InviteService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly publicUrl: string,
  ) {}

  async create(access: SessionAccess, input: CreateInviteRequest): Promise<CreateInviteResponse> {
    if (access.principal.kind !== 'user') {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Agents cannot create invites.');
    }
    const { token, hash } = createOpaqueToken(TokenPrefix.Invite);
    const ttl = input.expiresIn ?? DEFAULT_TTL_SECONDS;

    const row = await this.db
      .insertInto('invites')
      .values({
        id: newId(IdPrefix.Invite),
        session_id: access.sessionId,
        token_hash: hash,
        role: input.role ?? 'member',
        created_by: access.principal.userId,
        expires_at: new Date(Date.now() + ttl * 1000),
        max_uses: input.maxUses ?? 1,
        uses: 0,
        revoked_at: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      invite: toInvite(row),
      token,
      url: `${this.publicUrl}/invite/${token}`,
    };
  }

  async list(sessionId: string): Promise<Invite[]> {
    const rows = await this.db
      .selectFrom('invites')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toInvite);
  }

  async revoke(sessionId: string, inviteId: string): Promise<void> {
    const result = await this.db
      .updateTable('invites')
      .set({ revoked_at: new Date() })
      .where('id', '=', inviteId)
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!result) throw new AgentMeshError(ErrorCode.NotFound, 'Invite not found.');
  }

  /**
   * Redeem an invite. The use counter is incremented conditionally in SQL, so
   * two people redeeming the last use of the same link cannot both win.
   */
  async accept(token: string, userId: string): Promise<{ sessionId: string; alreadyMember: boolean }> {
    const hash = hashToken(token);
    const invite = await this.db
      .selectFrom('invites')
      .selectAll()
      .where('token_hash', '=', hash)
      .executeTakeFirst();

    if (!invite) throw new AgentMeshError(ErrorCode.InvalidToken, 'This invite link is not valid.');
    if (invite.revoked_at !== null) {
      throw new AgentMeshError(ErrorCode.InvalidToken, 'This invite has been revoked.');
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      throw new AgentMeshError(ErrorCode.TokenExpired, 'This invite has expired.');
    }

    const existingRole = await this.db
      .selectFrom('session_members')
      .select('role')
      .where('session_id', '=', invite.session_id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (existingRole) return { sessionId: invite.session_id, alreadyMember: true };

    const claimed = await this.db
      .updateTable('invites')
      .set((eb) => ({ uses: eb('uses', '+', 1) }))
      .where('id', '=', invite.id)
      .where('revoked_at', 'is', null)
      .where((eb) => eb('uses', '<', eb.ref('max_uses')))
      .returning('id')
      .executeTakeFirst();
    if (!claimed) {
      throw new AgentMeshError(ErrorCode.InvalidToken, 'This invite has already been used.');
    }

    await this.sessions.addMember(invite.session_id, userId, invite.role);
    return { sessionId: invite.session_id, alreadyMember: false };
  }
}
