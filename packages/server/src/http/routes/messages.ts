import {
  PROTOCOL_LIMITS,
  Permission,
  createMessageRequestSchema,
  historyQuerySchema,
  publishEventRequestSchema,
  searchQuerySchema,
  type EventPage,
} from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { authenticate } from '../auth.js';
import { parse } from '../errors.js';
import { sessionAccess } from '../helpers.js';

export async function messageRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.addHook('preHandler', authenticate(services));

  app.get('/sessions/:id/messages', async (request) => {
    const access = await sessionAccess(services, request);
    const query = parse(historyQuerySchema, request.query);
    return services.messages.page(
      access.sessionId,
      query.beforeSeq,
      query.limit ?? PROTOCOL_LIMITS.defaultPageSize,
    );
  });

  app.post('/sessions/:id/messages', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.WriteMessage);
    const body = parse(createMessageRequestSchema, request.body);
    reply.code(201).send(await services.messages.create(access, body));
  });

  /**
   * The raw session log. `sinceSeq` walks forward (catch-up after a
   * disconnect), `beforeSeq` walks backward (scrolling into history).
   */
  app.get('/sessions/:id/events', async (request): Promise<EventPage> => {
    const access = await sessionAccess(services, request);
    const query = parse(historyQuerySchema, request.query);
    const limit = Math.min(query.limit ?? PROTOCOL_LIMITS.defaultPageSize, PROTOCOL_LIMITS.maxPageSize);

    if (query.sinceSeq !== undefined) {
      const items = await services.log.since(access.sessionId, query.sinceSeq, limit + 1);
      const hasMore = items.length > limit;
      const page = items.slice(0, limit);
      return { items: page, nextCursor: hasMore ? (page.at(-1)?.seq ?? null) : null, hasMore };
    }

    const items = await services.log.before(access.sessionId, query.beforeSeq, limit + 1);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(1) : items;
    return { items: page, nextCursor: hasMore ? (page[0]?.seq ?? null) : null, hasMore };
  });

  app.post('/sessions/:id/events', async (request, reply) => {
    const access = await sessionAccess(services, request, Permission.PublishEvent);
    const body = parse(publishEventRequestSchema, request.body);
    reply.code(201).send(await services.devEvents.publish(access, body.type, body.payload));
  });

  app.get('/sessions/:id/search', async (request) => {
    const access = await sessionAccess(services, request);
    const query = parse(searchQuerySchema, request.query);
    const limit = query.limit ?? 20;
    const [messages, tasks, context] = await Promise.all([
      services.messages.search(access.sessionId, query.q, limit),
      services.tasks.search(access.sessionId, query.q, limit),
      services.context.search(access.sessionId, query.q, limit),
    ]);
    return { messages, tasks, context };
  });
}
