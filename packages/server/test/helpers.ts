import { type AddressInfo } from 'node:net';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';
import { loadEnvFiles } from '../src/env.js';

loadEnvFiles();

/**
 * Integration tests run against a real PostgreSQL database, because most of
 * what is worth testing here - sequence allocation, transactional projections,
 * unique constraints - is behaviour the database provides. A fake would test
 * the fake.
 *
 * The target database is wiped before the suite, so it must be a throwaway.
 * The name check below is a guard against pointing this at anything real.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

export function databaseAvailable(): boolean {
  return TEST_DATABASE_URL.length > 0;
}

export const skipMessage =
  'TEST_DATABASE_URL is not set - skipping server integration tests. ' +
  'Set it to a throwaway database, e.g. postgres://user:pass@localhost:5432/agentmesh_test';

function assertThrowaway(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name}": its name must contain "test" so a real database cannot be wiped by accident.`,
    );
  }
}

export interface TestServer extends BuiltApp {
  baseUrl: string;
  wsUrl: string;
}

export async function startTestServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  assertThrowaway(TEST_DATABASE_URL);
  await resetDatabase(TEST_DATABASE_URL, () => undefined);
  await runMigrations(TEST_DATABASE_URL, () => undefined);

  const config: Config = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret-value-that-is-long-enough-32',
      LOG_LEVEL: 'silent',
      PORT: '0',
      CORS_ORIGINS: '*',
    }),
    ...overrides,
  };

  const built = await buildApp(config);
  await built.app.listen({ host: '127.0.0.1', port: 0 });
  built.startRealtime();

  const address = built.app.server.address() as AddressInfo;
  return Object.assign(built, {
    baseUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
  });
}

export interface TestUser {
  accessToken: string;
  refreshToken: string;
  userId: string;
  displayName: string;
  email: string;
  password: string;
}

let userCounter = 0;

export async function createUser(server: TestServer, displayName = 'Alice'): Promise<TestUser> {
  userCounter += 1;
  const email = `user${userCounter}@example.test`;
  const password = 'correct horse battery staple';
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password, displayName },
  });
  if (response.statusCode !== 201) {
    throw new Error(`Failed to create test user: ${response.body}`);
  }
  const body = response.json() as { accessToken: string; refreshToken: string; user: { id: string } };
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    displayName,
    email,
    password,
  };
}

export function authed(server: TestServer, token: string) {
  return async (method: string, url: string, payload?: unknown) => {
    const response = await server.app.inject({
      method: method as 'GET',
      url: url.startsWith('/api') ? url : `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (JSON.parse(response.body) as unknown) : null,
    };
  };
}

/** Wait for a condition, polling briefly - used for realtime assertions. */
export async function waitFor<T>(
  probe: () => T | undefined,
  { timeoutMs = 3000, label = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
