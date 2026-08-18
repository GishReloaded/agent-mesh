import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { loadEnvFiles } from '../env.js';

/**
 * A deliberately small migration runner: plain `.sql` files applied in
 * lexicographic order, each inside its own transaction, recorded in
 * `_agentmesh_migrations`. No ORM, no codegen, no rollback DSL — for a project
 * whose schema fits on one screen, a migration tool would be more moving parts
 * than the thing it manages.
 */
function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'migrations'), // running from src/, or from dist/ after asset copy
    join(here, '..', '..', 'src', 'db', 'migrations'), // running from dist/ without a copy
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) throw new Error(`Could not locate migrations directory. Looked in:\n${candidates.join('\n')}`);
  return found;
}

const MIGRATIONS_DIR = resolveMigrationsDir();

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((name) => name.endsWith('.sql')).sort();
}

export interface MigrationOptions {
  /**
   * Use TLS without verifying the certificate chain. Managed PostgreSQL
   * providers almost always require TLS and almost always present a
   * certificate signed by their own authority.
   */
  ssl?: boolean;
}

export async function runMigrations(
  connectionString: string,
  log: (message: string) => void = console.log,
  options: MigrationOptions = {},
): Promise<void> {
  const client = new pg.Client({
    connectionString,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _agentmesh_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _agentmesh_migrations')).rows.map((r) => r.name),
    );

    let count = 0;
    for (const file of await migrationFiles()) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _agentmesh_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      log(`applied ${file}`);
      count += 1;
    }
    log(count === 0 ? 'database is up to date' : `applied ${count} migration(s)`);
  } finally {
    await client.end();
  }
}

/** Drops every AgentMesh table. Destructive; intended for local development. */
export async function resetDatabase(
  connectionString: string,
  log: (message: string) => void = console.log,
  options: MigrationOptions = {},
): Promise<void> {
  const client = new pg.Client({
    connectionString,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema()`,
    );
    if (rows.length > 0) {
      const list = rows.map((row) => `"${row.tablename}"`).join(', ');
      await client.query(`DROP TABLE IF EXISTS ${list} CASCADE`);
    }
    log(`dropped ${rows.length} table(s)`);
  } finally {
    await client.end();
  }
}

const entry = process.argv[1];
const isEntrypoint = entry !== undefined && pathToFileURL(entry).href === import.meta.url;

if (isEntrypoint) {
  loadEnvFiles();
  const config = loadConfig();
  const command = process.argv[2] ?? 'up';

  const options: MigrationOptions = { ssl: config.database.ssl };

  const run = async () => {
    if (command === 'reset') {
      await resetDatabase(config.database.url, console.log, options);
      await runMigrations(config.database.url, console.log, options);
    } else if (command === 'up') {
      await runMigrations(config.database.url, console.log, options);
    } else {
      throw new Error(`Unknown command: ${command}. Use "up" or "reset".`);
    }
  };

  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
