import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  SessionRole,
  toHandle,
  type CreateSessionRequest,
  type SessionDetail,
  type SessionMember,
  type SessionSummary,
  type UpdateSessionRequest,
} from '@agentmesh/protocol';
import { jsonb, type Db } from '../db/client.js';
import { principalActor, systemActor, type Principal, type SessionAccess } from '../auth/principal.js';
import { IdPrefix, newId } from '../ids.js';
import { toAgent, toPublicUser, toSession, toSessionMember } from '../mappers.js';
import type { ConnectionRegistry } from '../realtime/registry.js';
import type { EventLog } from './eventLog.js';

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly registry: ConnectionRegistry,
  ) {}

  async create(principal: Extract<Principal, { kind: 'user' }>, input: CreateSessionRequest) {
    const slug = await this.uniqueSlug(input.slug ?? toHandle(input.name) ?? 'session');
    const sessionId = newId(IdPrefix.Session);

    const created = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('sessions')
        .values({
          id: sessionId,
          slug,
          name: input.name,
          description: input.description ?? null,
          owner_id: principal.userId,
          project_meta: jsonb(input.projectMeta ?? {}),
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('session_members')
        .values({ session_id: sessionId, user_id: principal.userId, role: 'owner' })
        .execute();

      return toSession(row);
    });

    // Logged after creation so the first entry in every session log is the
    // session itself; clients replaying from seq 0 get a coherent story.
    await this.log.write(sessionId, async (ctx) => {
      const session = { ...created, lastSeq: 1 };
      await ctx.append(LifecycleEventType.SessionCreated, systemActor(), { session });
    });

    return { ...created, lastSeq: 1 };
  }

  async listForUser(userId: string): Promise<SessionSummary[]> {
    const rows = await this.db
      .selectFrom('sessions')
      .innerJoin('session_members', 'session_members.session_id', 'sessions.id')
      .where('session_members.user_id', '=', userId)
      .selectAll('sessions')
      .select('session_members.role as member_role')
      .orderBy('sessions.updated_at', 'desc')
      .execute();

    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);

    const memberCounts = await this.db
      .selectFrom('session_members')
      .select(['session_id'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('session_id', 'in', ids)
      .groupBy('session_id')
      .execute();

    const agentCounts = await this.db
      .selectFrom('agents')
      .select(['session_id'])
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('session_id', 'in', ids)
      .where('revoked_at', 'is', null)
      .groupBy('session_id')
      .execute();

    const memberCount = new Map(memberCounts.map((row) => [row.session_id, Number(row.count)]));
    const agentCount = new Map(agentCounts.map((row) => [row.session_id, Number(row.count)]));

    return Promise.all(
      rows.map(async (row) => {
        const [users, agents] = await Promise.all([
          this.registry.onlineUserIds(row.id),
          this.registry.onlineAgentIds(row.id),
        ]);
        return {
          ...toSession(row),
          role: row.member_role as SessionRole,
          memberCount: memberCount.get(row.id) ?? 0,
          agentCount: agentCount.get(row.id) ?? 0,
          onlineCount: users.size + agents.size,
        };
      }),
    );
  }

  async members(sessionId: string): Promise<SessionMember[]> {
    const rows = await this.db
      .selectFrom('session_members')
      .innerJoin('users', 'users.id', 'session_members.user_id')
      .where('session_members.session_id', '=', sessionId)
      .select([
        'session_members.session_id',
        'session_members.role',
        'session_members.joined_at',
        'session_members.user_id',
        'users.display_name',
        'users.avatar_color',
        'users.avatar_key',
      ])
      .orderBy('session_members.joined_at', 'asc')
      .execute();

    const online = await this.registry.onlineUserIds(sessionId);
    return rows.map((row) => toSessionMember(row, online.has(row.user_id)));
  }

  async agents(sessionId: string) {
    const rows = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();
    const online = await this.registry.onlineAgentIds(sessionId);
    return rows.map((row) => toAgent(row, online.has(row.id)));
  }

  async detail(access: SessionAccess): Promise<SessionDetail> {
    const row = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', access.sessionId)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Session not found.');

    return {
      session: toSession(row),
      role: access.role,
      members: await this.members(access.sessionId),
      agents: await this.agents(access.sessionId),
    };
  }

  async update(access: SessionAccess, input: UpdateSessionRequest) {
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.projectMeta !== undefined) patch.project_meta = jsonb(input.projectMeta);
    if (input.archived !== undefined) patch.archived_at = input.archived ? new Date() : null;

    const row = await this.db
      .updateTable('sessions')
      .set(patch as never)
      .where('id', '=', access.sessionId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Session not found.');
    const session = toSession(row);

    if (input.archived === true) {
      // The log is closed for writes once archived, so the archive notice is
      // broadcast directly instead of being appended.
      await this.registry.broadcast(access.sessionId, {
        type: 'event',
        payload: {
          event: {
            id: newId(IdPrefix.Event),
            sessionId: access.sessionId,
            seq: session.lastSeq,
            type: LifecycleEventType.SessionArchived,
            actor: access.actor,
            payload: { sessionId: access.sessionId },
            createdAt: new Date().toISOString(),
          },
        },
      });
      return session;
    }

    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.SessionUpdated, access.actor, { session });
    });
    return session;
  }

  async remove(sessionId: string): Promise<void> {
    // Tell subscribers before the row disappears; afterwards there is nothing
    // left to name in the notification.
    await this.registry.dropSession(sessionId);
    await this.db.deleteFrom('sessions').where('id', '=', sessionId).execute();
  }

  async setMemberRole(access: SessionAccess, userId: string, role: SessionRole) {
    if (role === SessionRole.Agent) {
      throw new AgentMeshError(ErrorCode.ValidationFailed, 'The agent role cannot be assigned to a person.');
    }
    const session = await this.db
      .selectFrom('sessions')
      .select('owner_id')
      .where('id', '=', access.sessionId)
      .executeTakeFirstOrThrow();

    if (session.owner_id === userId && role !== SessionRole.Owner) {
      throw new AgentMeshError(
        ErrorCode.Conflict,
        'The session owner cannot be demoted. Transfer ownership first.',
      );
    }

    const updated = await this.db
      .updateTable('session_members')
      .set({ role: role as 'owner' | 'member' | 'viewer' })
      .where('session_id', '=', access.sessionId)
      .where('user_id', '=', userId)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new AgentMeshError(ErrorCode.NotFound, 'This user is not a member of the session.');

    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.ParticipantRoleChanged, access.actor, { userId, role });
    });
  }

  /**
   * Remove a member. Their agents go with them: an agent is a delegate, and a
   * delegation cannot outlive the person who granted it.
   */
  async removeMember(access: SessionAccess, userId: string): Promise<void> {
    const session = await this.db
      .selectFrom('sessions')
      .select('owner_id')
      .where('id', '=', access.sessionId)
      .executeTakeFirstOrThrow();
    if (session.owner_id === userId) {
      throw new AgentMeshError(ErrorCode.Conflict, 'The session owner cannot be removed.');
    }

    const revokedAgents = await this.db.transaction().execute(async (trx) => {
      const deleted = await trx
        .deleteFrom('session_members')
        .where('session_id', '=', access.sessionId)
        .where('user_id', '=', userId)
        .returningAll()
        .executeTakeFirst();
      if (!deleted) throw new AgentMeshError(ErrorCode.NotFound, 'This user is not a member of the session.');

      return trx
        .updateTable('agents')
        .set({ revoked_at: new Date(), status: 'offline' })
        .where('session_id', '=', access.sessionId)
        .where('owner_user_id', '=', userId)
        .where('revoked_at', 'is', null)
        .returning(['id'])
        .execute();
    });

    await this.registry.dropUserFromSession(userId, access.sessionId);
    for (const agent of revokedAgents) {
      await this.registry.closeAgent(agent.id, 4002, 'Agent owner was removed from the session.');
    }

    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.ParticipantLeft, access.actor, {
        userId,
        removedBy: access.principal.kind === 'user' ? access.principal.userId : null,
      });
      for (const agent of revokedAgents) {
        await ctx.append(LifecycleEventType.AgentRevoked, systemActor(), {
          agentId: agent.id,
          revokedBy: access.principal.kind === 'user' ? access.principal.userId : agent.id,
        });
      }
    });
  }

  async addMember(sessionId: string, userId: string, role: 'member' | 'viewer'): Promise<boolean> {
    const existing = await this.db
      .selectFrom('session_members')
      .select('user_id')
      .where('session_id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (existing) return false;

    await this.db.insertInto('session_members').values({ session_id: sessionId, user_id: userId, role }).execute();

    const user = await this.db
      .selectFrom('users')
      .select(['id', 'display_name', 'avatar_color', 'avatar_key'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    await this.log.write(sessionId, async (ctx) => {
      await ctx.append(
        LifecycleEventType.ParticipantJoined,
        { type: 'user', id: user.id, name: user.display_name },
        {
          user: toPublicUser(user),
          role,
        },
      );
    });
    return true;
  }

  /** Leaving is self-service; owners must transfer or delete instead. */
  async leave(principal: Extract<Principal, { kind: 'user' }>, sessionId: string): Promise<void> {
    const session = await this.db
      .selectFrom('sessions')
      .select('owner_id')
      .where('id', '=', sessionId)
      .executeTakeFirstOrThrow();
    if (session.owner_id === principal.userId) {
      throw new AgentMeshError(
        ErrorCode.Conflict,
        'The owner cannot leave their own session. Delete it or transfer ownership.',
      );
    }
    await this.removeMember(
      { sessionId, role: SessionRole.Member, principal, actor: principalActor(principal) },
      principal.userId,
    );
  }

  private async uniqueSlug(base: string): Promise<string> {
    const root = (base || 'session').slice(0, 60);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = attempt === 0 ? root : `${root}-${attempt + 1}`;
      const clash = await this.db
        .selectFrom('sessions')
        .select('id')
        .where('slug', '=', candidate)
        .executeTakeFirst();
      if (!clash) return candidate;
    }
    return `${root}-${Date.now().toString(36)}`;
  }
}
