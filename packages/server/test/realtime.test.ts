import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '@agentmesh/protocol';
import { authed, createUser, databaseAvailable, skipMessage, startTestServer, type TestServer, type TestUser } from './helpers.js';

interface Frame {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

/** Small websocket harness: sends frames and waits for the ones a test needs. */
class TestSocket {
  private socket: WebSocket;
  private received: Frame[] = [];
  private waiters: { predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  private counter = 0;

  private constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      this.received.push(frame);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(frame)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    };
  }

  static async open(url: string): Promise<TestSocket> {
    const client = new TestSocket(url);
    await new Promise<void>((resolve, reject) => {
      client.socket.onopen = () => resolve();
      client.socket.onerror = () => reject(new Error('websocket failed to open'));
    });
    return client;
  }

  /** Send a raw frame, bypassing envelope construction. */
  sendRaw(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  send(type: string, payload: unknown): string {
    this.counter += 1;
    const id = `t${this.counter}`;
    this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, id, type, payload }));
    return id;
  }

  waitFor(predicate: (frame: Frame) => boolean, timeoutMs = 4000): Promise<Frame> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  waitForType(type: string, timeoutMs?: number): Promise<Frame> {
    return this.waitFor((frame) => frame.type === type, timeoutMs);
  }

  waitForEvent(eventType: string, timeoutMs?: number): Promise<Frame> {
    return this.waitFor(
      (frame) => frame.type === 'event' && (frame.payload.event as { type: string }).type === eventType,
      timeoutMs,
    );
  }

  async hello(token: string) {
    this.send('hello', { token, client: { name: 'test' } });
    return this.waitFor((frame) => frame.type === 'hello.ok' || frame.type === 'error');
  }

  async subscribe(sessionId: string, sinceSeq?: number) {
    this.send('subscribe', { sessionId, ...(sinceSeq === undefined ? {} : { sinceSeq }) });
    return this.waitForType('subscribed');
  }

  closed(): Promise<{ code: number }> {
    return new Promise((resolve) => {
      this.socket.onclose = (event: CloseEvent) => resolve({ code: event.code });
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe('realtime gateway', { skip: databaseAvailable() ? false : skipMessage }, () => {
  let server: TestServer;
  let alice: TestUser;
  let sessionId: string;

  before(async () => {
    // A small limit keeps the exchange short; the mechanism under test is the
    // window, not the number.
    server = await startTestServer({ agentChainLimit: 3, agentChainWindowMs: 5 * 60 * 1000 });
    alice = await createUser(server, 'Alice');
    const created = await authed(server, alice.accessToken)('POST', '/sessions', { name: 'Realtime Session' });
    sessionId = (created.body as { id: string }).id;
  });

  after(async () => {
    await server.close();
  });

  it('rejects a connection whose first frame is not a valid hello', async () => {
    const socket = await TestSocket.open(server.wsUrl);
    const closing = socket.closed();
    socket.send('hello', { token: 'not-a-token' });
    const error = await socket.waitForType('error');
    assert.equal(error.payload.code, 'INVALID_TOKEN');
    const { code } = await closing;
    assert.equal(code, 4001);
  });

  it('refuses frames that declare an unsupported protocol version', async () => {
    const socket = await TestSocket.open(server.wsUrl);
    const closing = socket.closed();
    socket.sendRaw({ v: 'agentmesh/v99', id: 'x', type: 'ping', payload: {} });
    const error = await socket.waitForType('error');
    assert.equal(error.payload.code, 'PROTOCOL_VERSION_UNSUPPORTED');
    const { code } = await closing;
    assert.equal(code, 4003);
  });

  it('delivers a snapshot on subscribe and broadcasts messages live', async () => {
    const first = await TestSocket.open(server.wsUrl);
    await first.hello(alice.accessToken);
    const subscribed = await first.subscribe(sessionId);
    const snapshot = subscribed.payload.snapshot as { members: unknown[]; lastSeq: number };
    assert.equal(snapshot.members.length, 1);

    const second = await TestSocket.open(server.wsUrl);
    await second.hello(alice.accessToken);
    await second.subscribe(sessionId);

    first.send('message.send', { sessionId, body: 'hello from the first socket' });
    const delivered = await second.waitForEvent('message.created');
    const message = (delivered.payload.event as { payload: { message: { body: string } } }).payload.message;
    assert.equal(message.body, 'hello from the first socket');

    first.close();
    second.close();
  });

  it('requires a subscription before writing to a session', async () => {
    const socket = await TestSocket.open(server.wsUrl);
    await socket.hello(alice.accessToken);
    socket.send('message.send', { sessionId, body: 'no subscription' });
    const error = await socket.waitForType('error');
    assert.equal(error.payload.code, 'NOT_SUBSCRIBED');
    socket.close();
  });

  it('replays missed events when a client resumes from its last sequence', async () => {
    const request = authed(server, alice.accessToken);
    const before = await request('GET', `/sessions/${sessionId}`);
    const cursor = (before.body as { session: { lastSeq: number } }).session.lastSeq;

    await request('POST', `/sessions/${sessionId}/messages`, { body: 'missed one' });
    await request('POST', `/sessions/${sessionId}/messages`, { body: 'missed two' });

    const socket = await TestSocket.open(server.wsUrl);
    await socket.hello(alice.accessToken);
    const subscribed = await socket.subscribe(sessionId, cursor);
    const replayed = subscribed.payload.replayed as { type: string; payload: { message?: { body: string } } }[];

    const bodies = replayed
      .filter((event) => event.type === 'message.created')
      .map((event) => event.payload.message?.body);
    assert.deepEqual(bodies, ['missed one', 'missed two']);
    socket.close();
  });

  it('connects an agent, reports presence, and enforces the agent chain limit', async () => {
    const request = authed(server, alice.accessToken);
    const registerBackend = await request('POST', `/sessions/${sessionId}/agents`, {
      name: 'Backend GPT',
      provider: 'openai',
      model: 'gpt-5.6',
      capabilities: { coding: true, backend: true },
    });
    assert.equal(registerBackend.status, 201);
    const backendToken = (registerBackend.body as { token: string }).token;

    const registerFrontend = await request('POST', `/sessions/${sessionId}/agents`, {
      name: 'Frontend Opus',
      provider: 'anthropic',
      model: 'claude-opus',
      capabilities: { coding: true, frontend: true },
    });
    const frontendToken = (registerFrontend.body as { token: string }).token;

    const watcher = await TestSocket.open(server.wsUrl);
    await watcher.hello(alice.accessToken);
    await watcher.subscribe(sessionId);

    // An agent token names its session, so no explicit subscribe is needed.
    const backend = await TestSocket.open(server.wsUrl);
    const hello = await backend.hello(backendToken);
    assert.equal(hello.type, 'hello.ok');
    assert.equal((hello.payload.identity as { kind: string }).kind, 'agent');
    await watcher.waitForEvent('agent.connected');

    const agents = await request('GET', `/sessions/${sessionId}/agents`);
    const online = (agents.body as { name: string; online: boolean }[]).find((a) => a.name === 'Backend GPT');
    assert.equal(online?.online, true);

    const frontend = await TestSocket.open(server.wsUrl);
    await frontend.hello(frontendToken);

    // Agents may exchange up to the configured number of messages inside the
    // window; the next one needs a human to have spoken.
    backend.send('message.send', { sessionId, body: '@frontend-opus login contract is ready' });
    await watcher.waitForEvent('message.created');

    frontend.send('message.send', { sessionId, body: '@backend-gpt is refresh implemented?' });
    await watcher.waitFor(
      (frame) =>
        frame.type === 'event' &&
        (frame.payload.event as { type: string; payload: { message?: { body: string } } }).payload.message?.body ===
          '@backend-gpt is refresh implemented?',
    );

    backend.send('message.send', { sessionId, body: '@frontend-opus not yet' });
    await watcher.waitFor(
      (frame) =>
        frame.type === 'event' &&
        (frame.payload.event as { payload: { message?: { body: string } } }).payload.message?.body ===
          '@frontend-opus not yet',
    );

    frontend.send('message.send', { sessionId, body: '@backend-gpt understood, one more question' });
    const blocked = await frontend.waitForType('error');
    assert.equal(blocked.payload.code, 'AGENT_CHAIN_LIMIT');

    // A human turn resets the chain.
    await request('POST', `/sessions/${sessionId}/messages`, { body: 'carry on' });
    frontend.send('message.send', { sessionId, body: '@backend-gpt continuing now' });
    const ack = await frontend.waitFor((frame) => frame.type === 'ack' || frame.type === 'error');
    assert.equal(ack.type, 'ack');

    const disconnected = watcher.waitForEvent('agent.disconnected');
    backend.close();
    await disconnected;

    frontend.close();
    watcher.close();
  });

  it('scopes an agent token to its own session', async () => {
    const request = authed(server, alice.accessToken);
    const other = await request('POST', '/sessions', { name: 'Other Session' });
    const otherId = (other.body as { id: string }).id;

    const registered = await request('POST', `/sessions/${sessionId}/agents`, { name: 'Scoped Agent' });
    const token = (registered.body as { token: string }).token;

    const socket = await TestSocket.open(server.wsUrl);
    await socket.hello(token);
    socket.send('subscribe', { sessionId: otherId });
    const error = await socket.waitForType('error');
    assert.equal(error.payload.code, 'FORBIDDEN');
    socket.close();
  });

  it('closes an agent connection when its token is revoked', async () => {
    const request = authed(server, alice.accessToken);
    const registered = await request('POST', `/sessions/${sessionId}/agents`, { name: 'Temporary Agent' });
    const { token, agent } = registered.body as { token: string; agent: { id: string } };

    const socket = await TestSocket.open(server.wsUrl);
    await socket.hello(token);
    const closing = socket.closed();

    const revoked = await request('DELETE', `/sessions/${sessionId}/agents/${agent.id}`);
    assert.equal(revoked.status, 204);

    const { code } = await closing;
    assert.equal(code, 4002);
  });
});
