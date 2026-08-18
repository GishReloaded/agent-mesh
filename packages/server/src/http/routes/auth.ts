import { loginRequestSchema, refreshRequestSchema, registerRequestSchema } from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate, requireUser } from '../auth.js';
import { parse } from '../errors.js';

export async function authRoutes(app: FastifyInstance, services: Services): Promise<void> {
  // Credential endpoints get a much tighter rate limit than the rest of the
  // API: they are the ones worth brute-forcing.
  const credentialLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.post('/auth/register', credentialLimit, async (request, reply) => {
    const body = parse(registerRequestSchema, request.body);
    const tokens = await services.users.register(body, request.headers['user-agent']);
    reply.code(201).send(tokens);
  });

  app.post('/auth/login', credentialLimit, async (request) => {
    const body = parse(loginRequestSchema, request.body);
    return services.users.login(body, request.headers['user-agent']);
  });

  app.post('/auth/refresh', credentialLimit, async (request) => {
    const body = parse(refreshRequestSchema, request.body);
    return services.users.refresh(body.refreshToken, request.headers['user-agent']);
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = parse(refreshRequestSchema, request.body);
    await services.users.logout(body.refreshToken);
    reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: authenticate(services) }, async (request) => {
    const principal = requireUser(request);
    return services.users.byId(principal.userId);
  });
}
