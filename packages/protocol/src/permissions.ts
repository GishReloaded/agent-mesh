import { SessionRole } from './primitives.js';

/**
 * Actions a session participant may attempt. Kept as a flat list on purpose:
 * AgentMesh does not need an ACL engine, it needs a table small enough that a
 * reviewer can check it at a glance.
 */
export const Permission = {
  ReadSession: 'session:read',
  WriteMessage: 'message:write',
  PublishEvent: 'event:publish',
  ManageTask: 'task:manage',
  WriteContext: 'context:write',
  DeleteContext: 'context:delete',
  RegisterAgent: 'agent:register',
  DisconnectAgent: 'agent:disconnect',
  Invite: 'invite:manage',
  ManageMembers: 'member:manage',
  UpdateSession: 'session:update',
  DeleteSession: 'session:delete',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Role capability matrix.
 *
 * `agent` sits between `viewer` and `member`: it contributes to the shared
 * state it exists to maintain, but it can never change who is in the session
 * or what the session is. An agent runs on someone's laptop under a model's
 * control; administration stays with humans.
 */
const MATRIX: Record<SessionRole, readonly Permission[]> = {
  [SessionRole.Owner]: [
    Permission.ReadSession,
    Permission.WriteMessage,
    Permission.PublishEvent,
    Permission.ManageTask,
    Permission.WriteContext,
    Permission.DeleteContext,
    Permission.RegisterAgent,
    Permission.DisconnectAgent,
    Permission.Invite,
    Permission.ManageMembers,
    Permission.UpdateSession,
    Permission.DeleteSession,
  ],
  [SessionRole.Member]: [
    Permission.ReadSession,
    Permission.WriteMessage,
    Permission.PublishEvent,
    Permission.ManageTask,
    Permission.WriteContext,
    Permission.RegisterAgent,
  ],
  [SessionRole.Agent]: [
    Permission.ReadSession,
    Permission.WriteMessage,
    Permission.PublishEvent,
    Permission.ManageTask,
    Permission.WriteContext,
  ],
  [SessionRole.Viewer]: [Permission.ReadSession],
};

export function permissionsFor(role: SessionRole): readonly Permission[] {
  return MATRIX[role] ?? [];
}

export function can(role: SessionRole, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Members may remove their own agents; only owners may remove anyone else's. */
export function canDisconnectAgent(role: SessionRole, isAgentOwner: boolean): boolean {
  return can(role, Permission.DisconnectAgent) || (isAgentOwner && can(role, Permission.RegisterAgent));
}
