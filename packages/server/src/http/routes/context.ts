import { Permission, contextListQuerySchema, publishContextRequestSchema } from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate } from '../auth.js';
import { parse } from '../errors.js';
import { param, sessionAccess } from '../helpers.js';

export async function contextRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', authenticate(services));

  app.get('/sessions/:id/context', async (request) => {
    const access = await sessionAccess(services, request);
    const query = parse(contextListQuerySchema, request.query);
    return services.context.list(access.sessionId, query);
  });

  app.post('/sessions/:id/context', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.WriteContext);
    const body = parse(publishContextRequestSchema, request.body);
    const entry = await services.context.publish(access, body);
    reply.code(entry.version === 1 ? 201 : 200).send(entry);
  });

  app.get('/sessions/:id/context/:entryId', async (request) => {
    const access = await sessionAccess(services, request);
    return services.context.get(access.sessionId, param(request, 'entryId'));
  });

  app.get('/sessions/:id/context/:entryId/revisions', async (request) => {
    const access = await sessionAccess(services, request);
    return services.context.revisions(access.sessionId, param(request, 'entryId'));
  });

  app.delete('/sessions/:id/context/:entryId', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.DeleteContext);
    await services.context.remove(access, param(request, 'entryId'));
    reply.code(204).send();
  });
}
