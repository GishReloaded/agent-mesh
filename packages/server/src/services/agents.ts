import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  canDisconnectAgent,
  type Agent,
  type AgentStatus,
  type RegisterAgentRequest,
  type UpdateAgentRequest,
} from '@agentmesh/protocol';
import { jsonb, type Db } from '../db/client.js';
import type { Principal, SessionAccess } from '../auth/principal.js';
import { TokenPrefix, createOpaqueToken, hashToken } from '../auth/tokens.js';
import { CloseCode } from '@agentmesh/protocol';
import { IdPrefix, newId } from '../ids.js';
import { toAgent } from '../mappers.js';
import type { ConnectionRegistry } from '../realtime/registry.js';
import type { EventLog } from './eventLog.js';

export class AgentService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly registry: ConnectionRegistry,
  ) {}

  async register(
    access: SessionAccess,
    input: RegisterAgentRequest,
  ): Promise<{ agent: Agent; token: string }> {
    if (access.principal.kind !== 'user') {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Agents cannot register other agents.');
    }

    const clash = await this.db
      .selectFrom('agents')
      .select('id')
      .where('session_id', '=', access.sessionId)
      .where('name', '=', input.name)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (clash) {
      throw new AgentMeshError(
        ErrorCode.Conflict,
        `An agent named "${input.name}" is already registered in this session.`,
      );
    }

    const { token, hash } = createOpaqueToken(TokenPrefix.Agent);
    const row = await this.db
      .insertInto('agents')
      .values({
        id: newId(IdPrefix.Agent),
        session_id: access.sessionId,
        name: input.name,
        provider: input.provider ?? 'custom',
        model: input.model ?? 'unknown',
        machine_id: input.machineId ?? null,
        capabilities: jsonb(input.capabilities ?? {}),
        metadata: jsonb(input.metadata ?? {}),
        autonomy: input.autonomy ?? 'semi',
        status: 'offline',
        token_hash: hash,
        owner_user_id: access.principal.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const agent = toAgent(row, false);
    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.AgentRegistered, access.actor, { agent });
    });

    return { agent, token };
  }

  async list(sessionId: string): Promise<Agent[]> {
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

  async get(sessionId: string, agentId: string): Promise<Agent> {
    const row = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Agent not found.');
    return toAgent(row, (await this.registry.onlineAgentIds(sessionId)).has(agentId));
  }

  /** Look up a live agent by its opaque token. Revoked agents never resolve. */
  async findByToken(token: string): Promise<Principal | null> {
    const row = await this.db
      .selectFrom('agents')
      .select(['id', 'session_id', 'name', 'owner_user_id'])
      .where('token_hash', '=', hashToken(token))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    return {
      kind: 'agent',
      agentId: row.id,
      sessionId: row.session_id,
      name: row.name,
      ownerUserId: row.owner_user_id,
    };
  }

  async update(access: SessionAccess, agentId: string, input: UpdateAgentRequest): Promise<Agent> {
    const existing = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', agentId)
      .where('session_id', '=', access.sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!existing) throw new AgentMeshError(ErrorCode.NotFound, 'Agent not found.');

    const isSelf = access.principal.kind === 'agent' && access.principal.agentId === agentId;
    const isOwner = access.principal.kind === 'user' && existing.owner_user_id === access.principal.userId;
    if (!isSelf && !isOwner && !canDisconnectAgent(access.role, false)) {
      throw new AgentMeshError(ErrorCode.Forbidden, 'Only the agent itself or its owner may update it.');
    }

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.capabilities !== undefined) patch.capabilities = jsonb(input.capabilities);
    if (input.autonomy !== undefined) patch.autonomy = input.autonomy;
    if (input.status !== undefined) patch.status = input.status;
    if (input.metadata !== undefined) patch.metadata = jsonb(input.metadata);

    const row =
      Object.keys(patch).length === 0
        ? existing
        : await this.db
            .updateTable('agents')
            .set(patch as never)
            .where('id', '=', agentId)
            .returningAll()
            .executeTakeFirstOrThrow();

    const agent = toAgent(row, (await this.registry.onlineAgentIds(access.sessionId)).has(agentId));

    if (input.status !== undefined && input.status !== existing.status) {
      await this.log.write(access.sessionId, async (ctx) => {
        await ctx.append(LifecycleEventType.AgentStatusChanged, access.actor, {
          agentId,
          status: input.status as AgentStatus,
        });
      });
    }
    return agent;
  }

  /** Status reported by the agent itself over the realtime connection. */
  async reportStatus(access: SessionAccess, agentId: string, status: AgentStatus, note?: string): Promise<void> {
    await this.db
      .updateTable('agents')
      .set({ status, last_seen_at: new Date() })
      .where('id', '=', agentId)
      .execute();
    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.AgentStatusChanged, access.actor, {
        agentId,
        status,
        ...(note ? { note } : {}),
      });
    });
  }

  async revoke(access: SessionAccess, agentId: string): Promise<void> {
    const existing = await this.db
      .selectFrom('agents')
      .select(['id', 'owner_user_id', 'name'])
      .where('id', '=', agentId)
      .where('session_id', '=', access.sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (!existing) throw new AgentMeshError(ErrorCode.NotFound, 'Agent not found.');

    const isOwner = access.principal.kind === 'user' && existing.owner_user_id === access.principal.userId;
    if (!canDisconnectAgent(access.role, isOwner)) {
      throw new AgentMeshError(
        ErrorCode.Forbidden,
        'Only the session owner or the agent owner may disconnect this agent.',
      );
    }

    await this.db
      .updateTable('agents')
      .set({ revoked_at: new Date(), status: 'offline' })
      .where('id', '=', agentId)
      .execute();

    await this.registry.closeAgent(agentId, CloseCode.TokenRevoked, 'Agent access revoked.');

    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.AgentRevoked, access.actor, {
        agentId,
        revokedBy: access.principal.kind === 'user' ? access.principal.userId : agentId,
      });
    });
  }

  /** Called by the realtime gateway when an agent connects or drops. */
  async markPresence(
    sessionId: string,
    agent: { id: string; name: string },
    connected: boolean,
    reason?: string,
  ): Promise<void> {
    await this.db
      .updateTable('agents')
      .set(connected ? { status: 'idle', last_seen_at: new Date() } : { status: 'offline', last_seen_at: new Date() })
      .where('id', '=', agent.id)
      .execute();

    const actor = { type: 'agent' as const, id: agent.id, name: agent.name };
    await this.log.write(sessionId, async (ctx) => {
      await ctx.append(
        connected ? LifecycleEventType.AgentConnected : LifecycleEventType.AgentDisconnected,
        actor,
        connected ? { agentId: agent.id, name: agent.name } : { agentId: agent.id, name: agent.name, ...(reason ? { reason } : {}) },
      );
    });
  }
}

