import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexBridge, type CodexBridgeServer, type CodexMesh } from '../src/agent-runtime/codex-bridge.js';
import type { RpcNotification, RpcServerRequest } from '../src/agent-runtime/codex-app-server.js';

class FakeMesh implements CodexMesh {
  readonly sessionId = 'ses_1';
  readonly identity = { kind: 'agent' as const, agentId: 'agt_1', sessionId: 'ses_1', name: 'Codex' };
  readonly events: { type: string; payload: Record<string, unknown> }[] = [];
  readonly contexts: Record<string, unknown>[] = [];

  async publishEvent(type: string, payload: Record<string, unknown>) {
    this.events.push({ type, payload });
  }
  async publishContext(input: Record<string, unknown>) {
    this.contexts.push(input);
  }
  async getContext() {
    return [];
  }
  async setStatus() {}
  async sendMessage() {}
}

class FakeServer implements CodexBridgeServer {
  notifications!: (message: RpcNotification) => void;
  requests!: (message: RpcServerRequest) => void;
  startedThreads = 0;
  startedTurns = 0;
  startedTurnInputs: unknown[] = [];
  responses: { id: number | string; result: unknown }[] = [];

  async listModels() {
    return [{ id: 'gpt-test', displayName: 'GPT Test', isDefault: true }];
  }
  async startThread() {
    this.startedThreads += 1;
    return { id: 'thr_1' };
  }
  async resumeThread(threadId: string) {
    return { id: threadId };
  }
  async startTurn(input: unknown) {
    this.startedTurns += 1;
    this.startedTurnInputs.push(input);
    return { id: 'turn_1' };
  }
  async interruptTurn() {}
  async archiveThread() {}
  respondToApproval() {}
  respondToRequest(id: number | string, result: unknown) {
    this.responses.push({ id, result });
  }
  close() {}
}

describe('Codex bridge', () => {
  it('creates one primary thread and reuses it for mention turns', async () => {
    const mesh = new FakeMesh();
    const server = new FakeServer();
    const bridge = new CodexBridge({
      mesh,
      workspace: 'D:\\repo',
      createServer: async (handlers) => {
        server.notifications = handlers.onNotification;
        server.requests = handlers.onServerRequest;
        return server;
      },
    });
    await bridge.start();

    const first = bridge.runMention('first request');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: 'done' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    assert.equal(await first, 'done');

    const second = bridge.runMention('second request');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_2', type: 'agentMessage', text: 'again' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    assert.equal(await second, 'again');

    assert.equal(server.startedThreads, 1);
    assert.equal(server.startedTurns, 2);
    assert.equal(mesh.contexts.length, 1);
  });

  it('rejects a remotely requested danger-full-access mode outside the local ceiling', async () => {
    const mesh = new FakeMesh();
    const server = new FakeServer();
    const bridge = new CodexBridge({
      mesh,
      workspace: 'D:\\repo',
      allowDangerFullAccess: false,
      createServer: async (handlers) => {
        server.notifications = handlers.onNotification;
        server.requests = handlers.onServerRequest;
        return server;
      },
    });
    await bridge.start();
    await bridge.handleControl({
      requestId: 'req_1',
      agentId: 'agt_1',
      action: 'createThread',
      sandbox: 'dangerFullAccess',
    });
    assert.equal(server.startedThreads, 0);
    assert.equal(mesh.events.at(-1)?.type, 'CODEX_THREAD_STATE');
    assert.match(String(mesh.events.at(-1)?.payload.error), /local runner/i);
  });

  it('applies primary thread settings to later mention turns', async () => {
    const mesh = new FakeMesh();
    const server = new FakeServer();
    const bridge = new CodexBridge({
      mesh,
      workspace: 'D:\\repo',
      createServer: async (handlers) => {
        server.notifications = handlers.onNotification;
        server.requests = handlers.onServerRequest;
        return server;
      },
    });
    await bridge.start();

    const first = bridge.runMention('create primary');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: 'done' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    await first;

    await bridge.handleControl({
      requestId: 'req_settings',
      agentId: 'agt_1',
      action: 'configureThread',
      threadId: 'thr_1',
      sandbox: 'readOnly',
      approvalPolicy: 'never',
    });

    const second = bridge.runMention('use settings');
    await new Promise((resolve) => setImmediate(resolve));
    const secondTurnInput = server.startedTurnInputs.at(-1);
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_2', type: 'agentMessage', text: 'done' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    await second;
    assert.deepEqual(secondTurnInput, {
      threadId: 'thr_1',
      prompt: 'use settings',
      cwd: 'D:\\repo',
      model: 'gpt-test',
      effort: undefined,
      approvalPolicy: 'never',
      sandbox: 'readOnly',
    });
  });

  it('fails closed for permission requests that the UI does not expose', async () => {
    const mesh = new FakeMesh();
    const server = new FakeServer();
    const bridge = new CodexBridge({
      mesh,
      workspace: 'D:\\repo',
      createServer: async (handlers) => {
        server.notifications = handlers.onNotification;
        server.requests = handlers.onServerRequest;
        return server;
      },
    });
    await bridge.start();
    server.requests({
      id: 71,
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thr_unknown', turnId: 'turn_1', itemId: 'item_1' },
    });
    assert.deepEqual(server.responses, [{ id: 71, result: { permissions: {} } }]);
    assert.equal(mesh.events.some((entry) => entry.type === 'CODEX_APPROVAL_REQUEST'), false);
  });
});
