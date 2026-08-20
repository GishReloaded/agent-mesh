import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createUser, databaseAvailable, skipMessage, startTestServer, type TestServer, type TestUser } from './helpers.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

describe('profile', { skip: databaseAvailable() ? false : skipMessage }, () => {
  let server: TestServer;
  let user: TestUser;

  before(async () => {
    server = await startTestServer();
    user = await createUser(server, 'Dana');
  });

  after(async () => {
    await server.close();
  });

  const request = () => authed(server, user.accessToken);

  it('gives a new account a colour from the palette', async () => {
    const { body } = await request()('GET', '/auth/me');
    const me = body as { avatarColor: string; avatarUrl: string | null };
    assert.match(me.avatarColor, /^(red|blue|green|skyblue|violet|pink|orange|yellow|cyan)$/);
    assert.equal(me.avatarUrl, null);
  });

  it('lets a person change their colour and name', async () => {
    const { status, body } = await request()('PATCH', '/auth/me', {
      avatarColor: 'violet',
      displayName: 'Dana Renamed',
    });
    assert.equal(status, 200);
    assert.equal((body as { avatarColor: string }).avatarColor, 'violet');
    assert.equal((body as { displayName: string }).displayName, 'Dana Renamed');
  });

  it('refuses a colour that is not in the palette', async () => {
    const { status } = await request()('PATCH', '/auth/me', { avatarColor: '#ff00ff' });
    assert.equal(status, 400);
  });

  it('refuses an empty update', async () => {
    const { status } = await request()('PATCH', '/auth/me', {});
    assert.equal(status, 400);
  });

  it('stores an uploaded avatar and serves it back', async () => {
    const upload = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { authorization: `Bearer ${user.accessToken}`, 'content-type': 'image/png' },
      payload: png,
    });
    assert.equal(upload.statusCode, 200);

    const url = (upload.json() as { avatarUrl: string }).avatarUrl;
    assert.ok(url, 'the account should now have an avatar url');

    const fetched = await server.app.inject({ method: 'GET', url });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.headers['content-type'], 'image/png');
    // The key changes with every upload, so the response may be cached forever.
    assert.match(String(fetched.headers['cache-control']), /immutable/);
    assert.equal(fetched.headers['x-content-type-options'], 'nosniff');
  });

  it('refuses a file that is not one of the accepted image types', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/me/avatar',
      headers: { authorization: `Bearer ${user.accessToken}`, 'content-type': 'image/png' },
      payload: Buffer.from('<svg><script>alert(1)</script></svg>'),
    });
    assert.equal(response.statusCode, 400);
  });

  it('will not serve an avatar under a key that does not match the account', async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/v1/users/${user.userId}/avatar/somebody-elses.png`,
    });
    assert.equal(response.statusCode, 404);
  });

  it('removes the avatar on request', async () => {
    const { status, body } = await request()('DELETE', '/auth/me/avatar');
    assert.equal(status, 200);
    assert.equal((body as { avatarUrl: string | null }).avatarUrl, null);
  });

  it('needs an account to change anything', async () => {
    const response = await server.app.inject({ method: 'PATCH', url: '/api/v1/auth/me', payload: { avatarColor: 'red' } });
    assert.equal(response.statusCode, 401);
  });
});
