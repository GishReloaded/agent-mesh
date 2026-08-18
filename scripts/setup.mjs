#!/usr/bin/env node
/**
 * One-command setup for a fresh clone.
 *
 * Creates a `.env` with generated secrets, makes sure the database exists,
 * and applies migrations. Everything it does is idempotent, so running it
 * again on an existing checkout is safe.
 *
 *   npm run setup
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/agentmesh';

const say = (message) => process.stdout.write(`${message}\n`);
const step = (message) => say(`\n== ${message}`);

function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) result[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return result;
}

function writeEnv(values) {
  const template = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : '';
  const lines = template.split(/\r?\n/).map((line) => {
    const match = /^\s*#?\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    return values[key] === undefined ? line : `${key}=${values[key]}`;
  });

  // Append anything the example file did not mention.
  for (const [key, value] of Object.entries(values)) {
    if (!lines.some((line) => line.startsWith(`${key}=`))) lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`);
}

async function ensureDatabase(url) {
  const target = new URL(url);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));

  const direct = new pg.Client({ connectionString: url });
  try {
    await direct.connect();
    await direct.end();
    say(`  database "${databaseName}" is reachable`);
    return true;
  } catch (error) {
    if (error.code !== '3D000') {
      say(`  cannot connect: ${error.message}`);
      return false;
    }
  }

  // 3D000 means the server is up but the database does not exist yet.
  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    say(`  created database "${databaseName}"`);
    return true;
  } catch (error) {
    say(`  could not create database "${databaseName}": ${error.message}`);
    return false;
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function main() {
  say('AgentMesh setup');

  step('1/3 Configuration');
  const existing = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const databaseUrl = process.env.DATABASE_URL ?? existing.DATABASE_URL ?? DEFAULT_DATABASE_URL;

  const values = {
    NODE_ENV: existing.NODE_ENV ?? 'development',
    PORT: existing.PORT ?? '4000',
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL:
      process.env.TEST_DATABASE_URL ?? existing.TEST_DATABASE_URL ?? databaseUrl.replace(/\/([^/?]+)(\?|$)/, '/$1_test$2'),
    // Regenerating this would invalidate everyone's sessions, so it is only
    // created when missing.
    JWT_SECRET: existing.JWT_SECRET ?? randomBytes(32).toString('hex'),
    PUBLIC_URL: existing.PUBLIC_URL ?? 'http://localhost:4000',
    CORS_ORIGINS: existing.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4000',
    LOG_LEVEL: existing.LOG_LEVEL ?? 'info',
  };

  writeEnv(values);
  say(existsSync(envPath) && Object.keys(existing).length > 0 ? '  updated .env' : '  created .env');
  say(`  DATABASE_URL=${values.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, '://$1:****@')}`);

  step('2/3 Database');
  const ready = await ensureDatabase(values.DATABASE_URL);
  if (!ready) {
    say('\nPostgreSQL is not reachable with that URL.');
    say('Options:');
    say('  - start one with Docker:  docker compose up -d postgres');
    say('  - or set DATABASE_URL and run this again:');
    say('      DATABASE_URL=postgres://user:pass@host:5432/agentmesh npm run setup');
    process.exit(1);
  }
  await ensureDatabase(values.TEST_DATABASE_URL);

  step('3/3 Migrations');
  process.env.DATABASE_URL = values.DATABASE_URL;
  const { runMigrations } = await import('../packages/server/dist/db/migrate.js').catch(() => ({
    runMigrations: null,
  }));

  if (runMigrations) {
    await runMigrations(values.DATABASE_URL, (message) => say(`  ${message}`));
    await runMigrations(values.TEST_DATABASE_URL, () => undefined).catch(() => undefined);
  } else {
    say('  server not built yet - migrations will run automatically on first start');
  }

  say('\nDone. Next:');
  say('  npm run dev     start server and web client with hot reload');
  say('  npm start       build everything and serve UI + API on http://localhost:4000');
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
