import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Config } from '../config.js';
import type { Database } from './types.js';

// `seq` and other BIGINT columns stay well below 2^53, so parsing them as
// numbers is safe and saves every caller a string-to-number dance. Without this
// node-postgres returns int8 as a string to avoid precision loss.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));

export type Db = Kysely<Database>;

/**
 * Serialize a value for a `jsonb` column.
 *
 * node-postgres turns a JS array into a PostgreSQL *array literal*, not JSON,
 * so writing `['a']` into a jsonb column silently stores `{"a"}` - an object,
 * not the array that comes back out. Every jsonb write goes through here so
 * arrays and objects are both encoded as real JSON.
 */
export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export function createDb(config: Config): DbHandle {
  const pool = new pg.Pool({
    connectionString: config.database.url,
    max: config.database.poolMax,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    application_name: 'agentmesh-server',
  });

  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

/** Cheap liveness probe used by `/healthz`. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.selectFrom('users').select(({ fn }) => fn.countAll().as('count')).executeTakeFirst();
    return true;
  } catch {
    return false;
  }
}
