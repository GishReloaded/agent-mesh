import {
  AgentMeshError,
  ErrorCode,
  type Permission,
  SessionRole,
  can,
  type Session,
} from '@agentmesh/protocol';
import type { Db } from '../db/client.js';
import { principalActor, type Principal, type SessionAccess } from '../auth/principal.js';
import { toSession } from '../mappers.js';

/**
 * Resolves "may this principal do this in this session" and nothing else.
 * Route handlers never read `session_members` directly — every access decision
 * goes through here so the rules stay in one auditable place.
 */
export class AccessService {
  constructor(private readonly db: Db) {}

  async loadSession(sessionId: string): Promise<Session> {
    const row = await this.db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Session not found.');
    return toSession(row);
  }

  /** Accepts a session id or slug, so URLs can be human-readable. */
  async resolveSessionId(idOrSlug: string): Promise<string> {
    const row = await this.db
      .selectFrom('sessions')
      .select('id')
      .where((eb) => eb.or([eb('id', '=', idOrSlug), eb('slug', '=', idOrSlug)]))
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Session not found.');
    return row.id;
  }

  async roleOf(userId: string, sessionId: string): Promise<SessionRole | null> {
    const row = await this.db
      .selectFrom('session_members')
      .select('role')
      .where('session_id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? (row.role as SessionRole) : null;
  }

  /**
   * Resolve a principal's access to a session.
   *
   * For agents this is a scope check, not a lookup: an agent token is minted
   * for exactly one session and is worthless anywhere else, so presenting it
   * for another session is a `FORBIDDEN`, never a role negotiation.
   */
  async require(principal: Principal, sessionId: string): Promise<SessionAccess> {
    if (principal.kind === 'agent') {
      if (principal.sessionId !== sessionId) {
        throw new AgentMeshError(ErrorCode.Forbidden, 'This agent token is scoped to a different session.');
      }
      return {
        sessionId,
        role: SessionRole.Agent,
        principal,
        actor: principalActor(principal),
      };
    }

    const role = await this.roleOf(principal.userId, sessionId);
    if (!role) {
      // Deliberately a 404: membership is the only way to learn a session
      // exists, so a non-member should not be able to probe for valid ids.
      throw new AgentMeshError(ErrorCode.NotFound, 'Session not found.');
    }
    return { sessionId, role, principal, actor: principalActor(principal) };
  }

  requirePermission(access: SessionAccess, permission: Permission): void {
    if (!can(access.role, permission)) {
      throw new AgentMeshError(
        ErrorCode.Forbidden,
        `Role "${access.role}" is not allowed to perform "${permission}".`,
      );
    }
  }

  async requireWith(principal: Principal, sessionId: string, permission: Permission): Promise<SessionAccess> {
    const access = await this.require(principal, sessionId);
    this.requirePermission(access, permission);
    return access;
  }
}
