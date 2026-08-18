import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createUser, databaseAvailable, skipMessage, startTestServer, type TestServer } from './helpers.js';

describe('authentication', { skip: databaseAvailable() ? false : skipMessage }, () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
  });

  after(async () => {
    await server.close();
  });

  it('registers an account and returns a usable access token', async () => {
    const user = await createUser(server, 'Alice');
    const request = authed(server, user.accessToken);
    const { status, body } = await request('GET', '/auth/me');
    assert.equal(status, 200);
    assert.equal((body as { displayName: string }).displayName, 'Alice');
  });

  it('rejects a short password', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'short@example.test', password: 'short', displayName: 'Short' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((response.json() as { error: { code: string } }).error.code, 'VALIDATION_FAILED');
  });

  it('does not reveal whether an email is registered', async () => {
    const user = await createUser(server, 'Bob');
    const wrongPassword = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: user.email, password: 'wrong password value' },
    });
    const unknownEmail = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong password value' },
    });
    assert.equal(wrongPassword.statusCode, 401);
    assert.equal(unknownEmail.statusCode, 401);
    assert.deepEqual(wrongPassword.json(), unknownEmail.json());
  });

  it('rotates refresh tokens and revokes the family when one is replayed', async () => {
    const user = await createUser(server, 'Carol');

    const first = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(first.statusCode, 200);
    const rotated = first.json() as { refreshToken: string };
    assert.notEqual(rotated.refreshToken, user.refreshToken);

    // Replaying the consumed token is treated as a leak: the whole family dies.
    const replay = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    assert.equal(replay.statusCode, 401);

    const afterRevocation = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    assert.equal(afterRevocation.statusCode, 401);
  });

  it('requires a bearer token on protected routes', async () => {
    const anonymous = await server.app.inject({ method: 'GET', url: '/api/v1/sessions' });
    assert.equal(anonymous.statusCode, 401);

    const garbage = await server.app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(garbage.statusCode, 401);
  });

  it('reports protocol version and health', async () => {
    const version = await server.app.inject({ method: 'GET', url: '/api/v1/version' });
    assert.equal(version.statusCode, 200);
    assert.equal((version.json() as { protocol: string }).protocol, 'agentmesh/v1');

    const health = await server.app.inject({ method: 'GET', url: '/api/v1/healthz' });
    assert.equal(health.statusCode, 200);
    assert.equal((health.json() as { database: string }).database, 'ok');
  });
});
