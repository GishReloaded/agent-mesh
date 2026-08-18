#!/usr/bin/env node
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { loadEnvFiles } from './env.js';

async function main(): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();

  // Applying pending migrations on boot keeps "clone, configure, start" true
  // for a self-hosted deployment. It is idempotent and cheap when up to date.
  await runMigrations(config.database.url, () => undefined);

  const built = await buildApp(config);
  await built.app.listen({ host: config.host, port: config.port });
  built.startRealtime();

  built.app.log.info(
    { port: config.port, ws: `ws://${config.host}:${config.port}/ws` },
    'AgentMesh server ready',
  );

  const shutdown = (signal: string) => {
    built.app.log.info({ signal }, 'shutting down');
    built
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        built.app.log.error({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
