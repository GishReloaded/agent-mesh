import {
  Permission,
  createTaskRequestSchema,
  taskListQuerySchema,
  updateTaskRequestSchema,
} from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate } from '../auth.js';
import { parse } from '../errors.js';
import { param, sessionAccess } from '../helpers.js';

export async function taskRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', authenticate(services));

  app.get('/sessions/:id/tasks', async (request) => {
    const access = await sessionAccess(services, request);
    const query = parse(taskListQuerySchema, request.query);
    return services.tasks.list(access.sessionId, query);
  });

  app.post('/sessions/:id/tasks', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.ManageTask);
    const body = parse(createTaskRequestSchema, request.body);
    reply.code(201).send(await services.tasks.create(access, body));
  });

  app.get('/sessions/:id/tasks/:taskId', async (request) => {
    const access = await sessionAccess(services, request);
    return services.tasks.get(access.sessionId, param(request, 'taskId'));
  });

  app.patch('/sessions/:id/tasks/:taskId', async (request) => {
    const access = await sessionAccess(services, request, Permission.ManageTask);
    const body = parse(updateTaskRequestSchema, request.body);
    return services.tasks.update(access, param(request, 'taskId'), body);
  });

  app.delete('/sessions/:id/tasks/:taskId', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.ManageTask);
    await services.tasks.remove(access, param(request, 'taskId'));
    reply.code(204).send();
  });
}
