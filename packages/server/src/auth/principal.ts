import type { Actor, SessionRole } from '@agentmesh/protocol';

/**
 * Who is making a request.
 *
 * An agent principal always carries the session it was issued for and the human
 * who registered it: an agent token is not a general-purpose credential, it is
 * a delegation scoped to one session.
 */
export type Principal =
  | { kind: 'user'; userId: string; displayName: string }
  | {
      kind: 'agent';
      agentId: string;
      sessionId: string;
      name: string;
      ownerUserId: string;
    };

export function principalActor(principal: Principal): Actor {
  return principal.kind === 'user'
    ? { type: 'user', id: principal.userId, name: principal.displayName }
    : { type: 'agent', id: principal.agentId, name: principal.name };
}

export function systemActor(): Actor {
  return { type: 'system', id: null, name: 'AgentMesh' };
}

/** A principal's access to one session, resolved per request. */
export interface SessionAccess {
  sessionId: string;
  role: SessionRole;
  principal: Principal;
  actor: Actor;
}
