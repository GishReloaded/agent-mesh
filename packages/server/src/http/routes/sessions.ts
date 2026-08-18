import {
  AgentMeshError,
  ErrorCode,
  Permission,
  createInviteRequestSchema,
  createSessionRequestSchema,
  updateMemberRequestSchema,
  updateSessionRequestSchema,
} from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate, requireUser } from '../auth.js';
import { parse } from '../errors.js';
import { param, sessionAccess } from '../helpers.js';

export async function sessionRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', authenticate(services));

  app.get('/sessions', async (request) => {
    const principal = requireUser(request);
    return services.sessions.listForUser(principal.userId);
  });

  app.post('/sessions', async (request, reply) => {
    const principal = requireUser(request);
    const body = parse(createSessionRequestSchema, request.body);
    const session = await services.sessions.create(principal, body);
    reply.code(201).send(session);
  });

  app.get('/sessions/:id', async (request) => {
    const access = await sessionAccess(services, request);
    return services.sessions.detail(access);
  });

  app.patch('/sessions/:id', async (request) => {
    const access = await sessionAccess(services, request, Permission.UpdateSession);
    const body = parse(updateSessionRequestSchema, request.body);
    return services.sessions.update(access, body);
  });

  app.delete('/sessions/:id', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.DeleteSession);
    await services.sessions.remove(access.sessionId);
    reply.code(204).send();
  });

  // --- members -------------------------------------------------------------

  app.get('/sessions/:id/members', async (request) => {
    const access = await sessionAccess(services, request);
    return services.sessions.members(access.sessionId);
  });

  app.patch('/sessions/:id/members/:userId', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.ManageMembers);
    const body = parse(updateMemberRequestSchema, request.body);
    await services.sessions.setMemberRole(access, param(request, 'userId'), body.role);
    reply.code(204).send();
  });

  app.delete('/sessions/:id/members/:userId', async (request, reply) => {
    const principal = requireUser(request);
    const targetUserId = param(request, 'userId');

    // Leaving is self-service; removing anyone else requires the owner role.
    if (targetUserId === principal.userId) {
      const sessionId = await services.access.resolveSessionId(param(request, 'id'));
      await services.sessions.leave(principal, sessionId);
    } else {
      const access = await sessionAccess(services, request, Permission.ManageMembers);
      await services.sessions.removeMember(access, targetUserId);
    }
    reply.code(204).send();
  });

  // --- invites -------------------------------------------------------------

  app.post('/sessions/:id/invites', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.Invite);
    const body = parse(createInviteRequestSchema, request.body ?? {});
    reply.code(201).send(await services.invites.create(access, body));
  });

  app.get('/sessions/:id/invites', async (request) => {
    const access = await sessionAccess(services, request, Permission.Invite);
    return services.invites.list(access.sessionId);
  });

  app.delete('/sessions/:id/invites/:inviteId', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.Invite);
    await services.invites.revoke(access.sessionId, param(request, 'inviteId'));
    reply.code(204).send();
  });

  app.post('/invites/:token/accept', async (request) => {
    const principal = requireUser(request);
    const token = param(request, 'token');
    if (!token) throw new AgentMeshError(ErrorCode.ValidationFailed, 'Invite token is missing.');

    const { sessionId, alreadyMember } = await services.invites.accept(token, principal.userId);
    const access = await services.access.require(principal, sessionId);
    return { ...(await services.sessions.detail(access)), alreadyMember };
  });
}
