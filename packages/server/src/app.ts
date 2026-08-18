import { API_PREFIX, PROTOCOL_LIMITS } from '@agentmesh/protocol';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createServices, type Services } from './container.js';
import type { DbHandle } from './db/client.js';
import { registerErrorHandler } from './http/errors.js';
import { agentRoutes } from './http/routes/agents.js';
import { authRoutes } from './http/routes/auth.js';
import { contextRoutes } from './http/routes/context.js';
import { messageRoutes } from './http/routes/messages.js';
import { metaRoutes } from './http/routes/meta.js';
import { sessionRoutes } from './http/routes/sessions.js';
import { taskRoutes } from './http/routes/tasks.js';
import { attachGateway, type Gateway } from './realtime/gateway.js';

export interface BuiltApp {
  app: FastifyInstance;
  services: Services;
  gateway: Gateway | null;
  /** Attach the websocket gateway once the HTTP server is listening. */
  startRealtime(): void;
  close(): Promise<void>;
}

export async function buildApp(config: Config, existingDb?: DbHandle): Promise<BuiltApp> {
  const services = createServices(config, existingDb);

  const app = Fastify({
    logger: { level: config.logLevel },
    // Bodies are small by design; the protocol's own limits are stricter still.
    bodyLimit: PROTOCOL_LIMITS.frameBytes,
    trustProxy: config.isProduction,
  });

  await app.register(helmet, {
    // The API serves JSON, not documents; the web client is a separate origin.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.window,
    // Authenticated callers are limited per principal, anonymous ones per IP,
    // so one busy agent cannot exhaust the quota of everyone behind a NAT.
    keyGenerator: (request) => {
      const principal = request.principal;
      if (principal?.kind === 'user') return `user:${principal.userId}`;
      if (principal?.kind === 'agent') return `agent:${principal.agentId}`;
      return request.ip;
    },
  });

  // Serving the built web client from the same origin makes a self-hosted
  // AgentMesh one process on one port, with no CORS configuration at all.
  if (config.webDist) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
  }
  registerErrorHandler(app, { serveSpa: config.webDist !== null });

  await app.register(
    async (instance) => {
      await instance.register(async (scope) => metaRoutes(scope, services));
      await instance.register(async (scope) => authRoutes(scope, services));
      await instance.register(async (scope) => sessionRoutes(scope, services));
      await instance.register(async (scope) => agentRoutes(scope, services));
      await instance.register(async (scope) => messageRoutes(scope, services));
      await instance.register(async (scope) => taskRoutes(scope, services));
      await instance.register(async (scope) => contextRoutes(scope, services));
    },
    { prefix: API_PREFIX },
  );

  // Unprefixed aliases so probes and load balancers do not need to know the
  // API version.
  app.get('/healthz', async (_request, reply) => {
    reply.redirect(`${API_PREFIX}/healthz`, 308);
  });


  let gateway: Gateway | null = null;

  return {
    app,
    services,
    get gateway() {
      return gateway;
    },
    startRealtime: () => {
      gateway = attachGateway(app.server, services, app.log);
    },
    close: async () => {
      await gateway?.close();
      await app.close();
      if (!existingDb) await services.db.close();
    },
  };
}
