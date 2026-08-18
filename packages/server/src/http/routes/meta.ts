import { PROTOCOL_LIMITS, PROTOCOL_VERSION } from '@agentmesh/protocol';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../container.js';
import { pingDb } from '../../db/client.js';
import { SERVER_VERSION } from '../../version.js';

export async function metaRoutes(app: FastifyInstance, services: Services): Promise<void> {
  const startedAt = Date.now();

  app.get('/healthz', async (_request, reply) => {
    const database = (await pingDb(services.db.db)) ? 'ok' : 'down';
    reply.code(database === 'ok' ? 200 : 503).send({
      status: database === 'ok' ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      database,
    });
  });

  app.get('/version', async () => ({
    name: 'agentmesh',
    version: SERVER_VERSION,
    protocol: PROTOCOL_VERSION,
    limits: { ...PROTOCOL_LIMITS, agentChainLimit: services.config.agentChainLimit },
    // null means "/ws on this origin"; a value means the realtime endpoint
    // lives elsewhere, which is the case on the serverless deployment.
    realtimeUrl: services.config.realtimeUrl,
  }));
}
