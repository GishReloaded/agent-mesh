import type { Permission } from '@agentmesh/protocol';
import type { FastifyRequest } from 'fastify';
import type { SessionAccess } from '../auth/principal.js';
import type { Services } from '../container.js';
import { requirePrincipal } from './auth.js';

/**
 * Resolve `:id` (a session id or slug) into a checked `SessionAccess`. Every
 * session-scoped route starts here, which is what keeps authorization from
 * drifting between endpoints.
 */
export async function sessionAccess(
  services: Services,
  request: FastifyRequest,
  permission?: Permission,
): Promise<SessionAccess> {
  const principal = requirePrincipal(request);
  const { id } = request.params as { id: string };
  const sessionId = await services.access.resolveSessionId(id);
  const access = await services.access.require(principal, sessionId);
  if (permission) services.access.requirePermission(access, permission);
  return access;
}

export function param(request: FastifyRequest, name: string): string {
  return (request.params as Record<string, string>)[name] ?? '';
}
