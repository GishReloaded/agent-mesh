import { Permission, registerAgentRequestSchema, updateAgentRequestSchema } from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate } from '../auth.js';
import { parse } from '../errors.js';
import { param, sessionAccess } from '../helpers.js';

export async function agentRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', authenticate(services));

  app.get('/sessions/:id/agents', async (request) => {
    const access = await sessionAccess(services, request);
    return services.agents.list(access.sessionId);
  });

  app.post('/sessions/:id/agents', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.RegisterAgent);
    const body = parse(registerAgentRequestSchema, request.body);
    const result = await services.agents.register(access, body);
    // The token is returned once and never again: only its hash is stored.
    reply.code(201).send(result);
  });

  app.get('/sessions/:id/agents/:agentId', async (request) => {
    const access = await sessionAccess(services, request);
    return services.agents.get(access.sessionId, param(request, 'agentId'));
  });

  app.patch('/sessions/:id/agents/:agentId', async (request) => {
    const access = await sessionAccess(services, request);
    const body = parse(updateAgentRequestSchema, request.body);
    return services.agents.update(access, param(request, 'agentId'), body);
  });

  app.delete('/sessions/:id/agents/:agentId', async (request, reply) => {
    const access = await sessionAccess(services, request);
    await services.agents.revoke(access, param(request, 'agentId'));
    reply.code(204).send();
  });
}
