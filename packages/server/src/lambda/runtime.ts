import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig, type Config } from '../config.js';
import { createDb, type DbHandle } from '../db/client.js';
import { PostgresConnectionRegistry, type FrameSender } from '../realtime/pgRegistry.js';
import { createServices, type Services } from '../container.js';

/**
 * Shared bootstrap for both Lambda handlers.
 *
 * Everything here is created once per container and reused across invocations.
 * That matters most for the database pool: a fresh pool per invocation would
 * exhaust connection slots the moment two people type at the same time.
 */

let cachedConfig: Config | null = null;
let cachedDb: DbHandle | null = null;
let cachedApp: FastifyInstance | null = null;

/** Set by the websocket handler before each invocation; see `sendFrame`. */
let managementEndpoint: string | null = null;
let sendFrameImpl: FrameSender | null = null;

export function config(): Config {
  if (!cachedConfig) {
    cachedConfig = loadConfig({
      ...process.env,
      // Lambda has no long-lived process to hold many sockets open, and a
      // serverless Postgres charges per connection: keep the pool tiny.
      DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX ?? '2',
      // The SPA is served from the deployment package next to the handler.
      WEB_DIST: process.env.WEB_DIST ?? 'web',
    });
  }
  return cachedConfig;
}

export function db(): DbHandle {
  if (!cachedDb) cachedDb = createDb(config());
  return cachedDb;
}

/** Register the transport that can reach API Gateway for this invocation. */
export function setFrameSender(endpoint: string, sender: FrameSender): void {
  managementEndpoint = endpoint;
  sendFrameImpl = sender;
}

export function currentEndpoint(): string | null {
  return managementEndpoint;
}

const sendFrame: FrameSender = async (connectionId, frame) => {
  if (!sendFrameImpl) {
    // Reached when an HTTP request produces an event and no websocket
    // invocation has set up a sender yet. The event is still persisted; live
    // subscribers pick it up on their next frame or on resume.
    return false;
  }
  return sendFrameImpl(connectionId, frame);
};

let cachedServices: Services | null = null;

export function services(): Services {
  if (!cachedServices) {
    const handle = db();
    const connections = new PostgresConnectionRegistry(handle.db, sendFrame);
    cachedServices = createServices(config(), { db: handle, registry: connections });
  }
  return cachedServices;
}

export function registry(): PostgresConnectionRegistry {
  return services().registry as PostgresConnectionRegistry;
}

/** The Fastify app, built once per container over the shared service graph. */
export async function app(): Promise<FastifyInstance> {
  if (!cachedApp) {
    const built = await buildApp(config(), { services: services() });
    // Deliberately not calling ready(): the Lambda adapter decorates the
    // instance and must do so before Fastify starts.
    cachedApp = built.app;
  }
  return cachedApp;
}
