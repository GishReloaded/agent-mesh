import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { authed, createUser, databaseAvailable, skipMessage, startTestServer, type TestServer, type TestUser } from './helpers.js';

describe('sessions, permissions and shared state', { skip: databaseAvailable() ? false : skipMessage }, () => {
  let server: TestServer;
  let owner: TestUser;
  let sessionId: string;

  before(async () => {
    server = await startTestServer();
    owner = await createUser(server, 'Alice');
    const request = authed(server, owner.accessToken);
    const created = await request('POST', '/sessions', { name: 'Ecommerce Platform' });
    assert.equal(created.status, 201);
    sessionId = (created.body as { id: string }).id;
  });

  after(async () => {
    await server.close();
  });

  it('creates a session with the creator as owner and a readable slug', async () => {
    const request = authed(server, owner.accessToken);
    const { status, body } = await request('GET', `/sessions/${sessionId}`);
    assert.equal(status, 200);
    const detail = body as { session: { slug: string }; role: string; members: unknown[] };
    assert.equal(detail.role, 'owner');
    assert.equal(detail.session.slug, 'ecommerce-platform');
    assert.equal(detail.members.length, 1);
  });

  it('hides sessions from non-members as not found', async () => {
    const stranger = await createUser(server, 'Mallory');
    const { status } = await authed(server, stranger.accessToken)('GET', `/sessions/${sessionId}`);
    assert.equal(status, 404);
  });

  it('lets a user join with an invite and enforces single use', async () => {
    const ownerRequest = authed(server, owner.accessToken);
    const invite = await ownerRequest('POST', `/sessions/${sessionId}/invites`, { role: 'member', maxUses: 1 });
    assert.equal(invite.status, 201);
    const token = (invite.body as { token: string }).token;

    const bob = await createUser(server, 'Bob');
    const joined = await authed(server, bob.accessToken)('POST', `/invites/${token}/accept`);
    assert.equal(joined.status, 200);

    const carol = await createUser(server, 'Carol');
    const rejected = await authed(server, carol.accessToken)('POST', `/invites/${token}/accept`);
    assert.equal(rejected.status, 401);
  });

  it('denies writes to viewers and administration to members', async () => {
    const ownerRequest = authed(server, owner.accessToken);
    const viewerInvite = await ownerRequest('POST', `/sessions/${sessionId}/invites`, { role: 'viewer' });
    const viewer = await createUser(server, 'Vic');
    await authed(server, viewer.accessToken)(
      'POST',
      `/invites/${(viewerInvite.body as { token: string }).token}/accept`,
    );
    const viewerRequest = authed(server, viewer.accessToken);

    const read = await viewerRequest('GET', `/sessions/${sessionId}/messages`);
    assert.equal(read.status, 200);

    const write = await viewerRequest('POST', `/sessions/${sessionId}/messages`, { body: 'hello' });
    assert.equal(write.status, 403);

    const invite = await viewerRequest('POST', `/sessions/${sessionId}/invites`, { role: 'member' });
    assert.equal(invite.status, 403);
  });

  it('paginates message history with a cursor', async () => {
    const request = authed(server, owner.accessToken);
    for (let index = 0; index < 12; index += 1) {
      const sent = await request('POST', `/sessions/${sessionId}/messages`, { body: `message ${index}` });
      assert.equal(sent.status, 201);
    }

    const firstPage = await request('GET', `/sessions/${sessionId}/messages?limit=5`);
    const first = firstPage.body as { items: { body: string; seq: number }[]; hasMore: boolean; nextCursor: number };
    assert.equal(first.items.length, 5);
    assert.equal(first.hasMore, true);
    assert.equal(first.items.at(-1)?.body, 'message 11');

    const secondPage = await request('GET', `/sessions/${sessionId}/messages?limit=5&beforeSeq=${first.nextCursor}`);
    const second = secondPage.body as { items: { body: string }[] };
    assert.equal(second.items.length, 5);
    assert.equal(second.items.at(-1)?.body, 'message 6');
  });

  it('resolves mentions against session participants', async () => {
    const request = authed(server, owner.accessToken);
    const sent = await request('POST', `/sessions/${sessionId}/messages`, {
      body: '@alice and @nobody, please look at this',
    });
    const message = sent.body as { mentions: { handle: string; type: string }[] };
    assert.equal(message.mentions.length, 1);
    assert.equal(message.mentions[0]?.handle, 'alice');
  });

  it('versions shared context instead of duplicating it', async () => {
    const request = authed(server, owner.accessToken);
    const first = await request('POST', `/sessions/${sessionId}/context`, {
      kind: 'api_contract',
      key: 'auth.login',
      title: 'POST /api/auth/login',
      data: { response: { accessToken: 'string' } },
    });
    assert.equal(first.status, 201);
    assert.equal((first.body as { version: number }).version, 1);

    const second = await request('POST', `/sessions/${sessionId}/context`, {
      kind: 'api_contract',
      key: 'auth.login',
      title: 'POST /api/auth/login',
      data: { response: { accessToken: 'string', expiresAt: 'datetime' } },
    });
    assert.equal((second.body as { version: number }).version, 2);
    assert.equal((second.body as { id: string }).id, (first.body as { id: string }).id);

    const listed = await request('GET', `/sessions/${sessionId}/context?kind=api_contract`);
    assert.equal((listed.body as unknown[]).length, 1);

    const revisions = await request(
      'GET',
      `/sessions/${sessionId}/context/${(first.body as { id: string }).id}/revisions`,
    );
    assert.equal((revisions.body as unknown[]).length, 2);
  });

  it('rejects a stale optimistic write to shared context', async () => {
    const request = authed(server, owner.accessToken);
    const conflict = await request('POST', `/sessions/${sessionId}/context`, {
      kind: 'api_contract',
      key: 'auth.login',
      title: 'POST /api/auth/login',
      expectedVersion: 1,
    });
    assert.equal(conflict.status, 409);
  });

  it('validates development event payloads and refuses lifecycle types', async () => {
    const request = authed(server, owner.accessToken);

    const good = await request('POST', `/sessions/${sessionId}/events`, {
      type: 'API_CONTRACT_CREATED',
      payload: { service: 'auth', method: 'POST', endpoint: '/api/auth/login' },
    });
    assert.equal(good.status, 201);

    const bad = await request('POST', `/sessions/${sessionId}/events`, {
      type: 'API_CONTRACT_CREATED',
      payload: { service: 'auth' },
    });
    assert.equal(bad.status, 400);

    const forged = await request('POST', `/sessions/${sessionId}/events`, {
      type: 'message.created',
      payload: {},
    });
    assert.equal(forged.status, 403);

    const custom = await request('POST', `/sessions/${sessionId}/events`, {
      type: 'X_DEPLOY_STARTED',
      payload: { env: 'staging' },
    });
    assert.equal(custom.status, 201);
  });

  it('keeps one gap-free sequence per session across message, task and context writes', async () => {
    const request = authed(server, owner.accessToken);
    await request('POST', `/sessions/${sessionId}/tasks`, { title: 'Implement refresh tokens' });
    await request('POST', `/sessions/${sessionId}/messages`, { body: 'task created' });

    const events = await request('GET', `/sessions/${sessionId}/events?sinceSeq=0&limit=200`);
    const items = (events.body as { items: { seq: number }[] }).items;
    assert.ok(items.length > 0);
    for (const [index, event] of items.entries()) {
      assert.equal(event.seq, index + 1, 'sequence numbers must be contiguous from 1');
    }
  });

  it('assigns tasks only to participants of the session', async () => {
    const request = authed(server, owner.accessToken);
    const bad = await request('POST', `/sessions/${sessionId}/tasks`, {
      title: 'Bad assignee',
      assignee: { type: 'agent', id: 'agt_does_not_exist' },
    });
    assert.equal(bad.status, 400);
  });
});
