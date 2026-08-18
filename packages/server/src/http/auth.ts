import { AgentMeshError, ErrorCode } from '@agentmesh/protocol';
import type { FastifyRequest } from 'fastify';
import type { Principal } from '../auth/principal.js';
import { TokenPrefix, tokenLooksLike } from '../auth/tokens.js';
import type { Services } from '../container.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * Resolve the bearer token on a request.
 *
 * Both humans and agents use `Authorization: Bearer …`; the token's prefix says
 * which kind it is, so there is no ambiguity and no fallback path that could
 * let an agent token be treated as a user token.
 */
export async function resolvePrincipal(services: Services, header: string | undefined): Promise<Principal> {
  if (!header) {
    throw new AgentMeshError(ErrorCode.Unauthorized, 'Authorization header is missing.');
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new AgentMeshError(ErrorCode.Unauthorized, 'Expected an "Authorization: Bearer <token>" header.');
  }
  return resolveToken(services, token);
}

export async function resolveToken(services: Services, token: string): Promise<Principal> {
  if (tokenLooksLike(token, TokenPrefix.Agent)) {
    const principal = await services.agents.findByToken(token);
    if (!principal) {
      throw new AgentMeshError(ErrorCode.InvalidToken, 'Agent token is not valid or has been revoked.');
    }
    return principal;
  }

  const claims = await services.accessTokens.verify(token);
  const user = await services.users.byId(claims.sub);
  return { kind: 'user', userId: user.id, displayName: user.displayName };
}

/** Fastify preHandler: requires any authenticated principal. */
export function authenticate(services: Services) {
  return async (request: FastifyRequest): Promise<void> => {
    request.principal = await resolvePrincipal(services, request.headers.authorization);
  };
}

export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new AgentMeshError(ErrorCode.Unauthorized, 'Authentication required.');
  }
  return request.principal;
}

/** Routes that only make sense for a human account, e.g. creating a session. */
export function requireUser(request: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const principal = requirePrincipal(request);
  if (principal.kind !== 'user') {
    throw new AgentMeshError(ErrorCode.Forbidden, 'This endpoint is available to user accounts only.');
  }
  return principal;
}
