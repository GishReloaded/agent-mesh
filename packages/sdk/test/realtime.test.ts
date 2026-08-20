import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROTOCOL_VERSION } from '@agentmesh/protocol';
import { RealtimeClient } from '../src/realtime.js';

interface Frame {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

/** Enough of a WebSocket to drive the client without a server. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readonly OPEN = 1;
  readyState = 1;
  readonly sent: Frame[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Frame);
  }

  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Pretend the server said something. */
  deliver(type: string, payload: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ v: PROTOCOL_VERSION, id: 's1', type, ts: new Date().toISOString(), payload }),
    });
  }

  static reset(): void {
    FakeSocket.instances.length = 0;
  }
}

const helloOk = {
  protocol: PROTOCOL_VERSION,
  serverVersion: '0.1.0',
  heartbeatIntervalMs: 20_000,
  identity: { kind: 'agent', agentId: 'agt_1', sessionId: 'ses_1', name: 'Tester' },
};

function makeClient(overrides: Record<string, unknown> = {}) {
  return new RealtimeClient({
    url: 'ws://example.invalid/ws',
    token: 'ama_test',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    autoReconnect: false,
    ...overrides,
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('realtime keep-alive', () => {
  it('sends periodic pings once connected', async () => {
    // Without this a quiet connection is dropped by whatever sits in front of
    // the server - API Gateway closes an idle WebSocket after ten minutes -
    // and an agent that is merely waiting for work silently goes offline.
    FakeSocket.reset();
    const client = makeClient({ heartbeatIntervalMs: 25 });
    const connected = client.connect();

    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket, 'a socket should have been opened');
    socket.deliver('hello.ok', helloOk);
    await connected;

    await wait(90);
    const pings = socket.sent.filter((frame) => frame.type === 'ping');
    assert.ok(pings.length >= 2, `expected repeated pings, got ${pings.length}`);
    client.close();
  });

  it('stops pinging after the connection closes', async () => {
    FakeSocket.reset();
    const client = makeClient({ heartbeatIntervalMs: 25 });
    const connected = client.connect();

    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    socket.deliver('hello.ok', helloOk);
    await connected;

    await wait(60);
    client.close();
    const afterClose = socket.sent.filter((frame) => frame.type === 'ping').length;

    await wait(80);
    assert.equal(
      socket.sent.filter((frame) => frame.type === 'ping').length,
      afterClose,
      'a closed client must not keep pinging',
    );
  });

  it('can be disabled for servers that ping their own clients', async () => {
    FakeSocket.reset();
    const client = makeClient({ heartbeatIntervalMs: 0 });
    const connected = client.connect();

    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    socket.deliver('hello.ok', helloOk);
    await connected;

    await wait(60);
    assert.equal(socket.sent.filter((frame) => frame.type === 'ping').length, 0);
    client.close();
  });
});

describe('realtime credentials', () => {
  it('resolves a token provider on every attempt', async () => {
    FakeSocket.reset();
    let calls = 0;
    const client = makeClient({
      token: () => {
        calls += 1;
        return `ama_call_${calls}`;
      },
    });
    const connected = client.connect();

    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    const hello = socket.sent.find((frame) => frame.type === 'hello');
    assert.equal((hello?.payload as { token: string }).token, 'ama_call_1');

    socket.deliver('hello.ok', helloOk);
    await connected;
    client.close();
  });

  it('gives up when the provider has no credential to offer', async () => {
    FakeSocket.reset();
    const client = makeClient({ token: () => null });
    await assert.rejects(client.connect(), /credential/i);
  });
});

describe('recovering a forgotten connection', () => {
  it('says hello again instead of surfacing an error nobody can act on', async () => {
    // The socket is fine and the credential is fine; the server simply no
    // longer has a record of this connection. The client can fix that itself.
    FakeSocket.reset();
    const client = makeClient();
    const errors: string[] = [];
    client.on('error', (error) => errors.push(error.code));
    const connected = client.connect();

    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    socket.deliver('hello.ok', helloOk);
    await connected;

    const before = socket.sent.filter((frame) => frame.type === 'hello').length;
    socket.deliver('error', { code: 'REAUTHENTICATE', message: 'no longer registered' });
    await wait(20);

    assert.equal(
      socket.sent.filter((frame) => frame.type === 'hello').length,
      before + 1,
      'the client should re-introduce itself',
    );
    assert.deepEqual(errors, [], 'and not bother the application with it');
    client.close();
  });
});

describe('Codex control', () => {
  it('publishes typed control requests over the existing event channel', async () => {
    FakeSocket.reset();
    const client = makeClient();
    const connected = client.connect();
    await wait(10);
    const socket = FakeSocket.instances[0];
    assert.ok(socket);
    socket.deliver('hello.ok', helloOk);
    await connected;

    const pending = client.controlCodex('ses_1', {
      requestId: 'req_1',
      agentId: 'agt_1',
      action: 'startTurn',
      threadId: 'thr_1',
      prompt: 'Run the tests',
    });
    const frame = socket.sent.at(-1);
    assert.equal(frame?.type, 'event.publish');
    assert.equal(frame?.payload.type, 'CODEX_CONTROL_REQUEST');
    assert.equal((frame?.payload.payload as { prompt: string }).prompt, 'Run the tests');

    socket.deliver('ack', { ref: frame?.id });
    await pending;
    client.close();
  });
});
