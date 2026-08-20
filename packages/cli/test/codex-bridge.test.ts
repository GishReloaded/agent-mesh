import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexBridge, type CodexBridgeServer, type CodexMesh } from '../src/agent-runtime/codex-bridge.js';
import type { RpcNotification, RpcServerRequest } from '../src/agent-runtime/codex-app-server.js';
import { formatCodexActivity } from '../src/agent-runtime/runner.js';

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
  it('formats useful one-line verbose activity without dumping payloads', () => {
    assert.equal(formatCodexActivity({ threadId: 'thr_1', kind: 'command', command: 'npm test', status: 'completed' }), '[command] npm test (completed)');
    assert.equal(formatCodexActivity({ threadId: 'thr_1', kind: 'fileChange', files: ['a.ts', 'b.ts'], status: 'completed' }), '[files] a.ts, b.ts (completed)');
    assert.equal(formatCodexActivity({ threadId: 'thr_1', kind: 'reasoningSummary', summary: 'Checking files' }), '[summary] Checking files');
  });

  it('reports sanitized activity to the local verbose observer', async () => {
    const mesh = new FakeMesh();
    const server = new FakeServer();
    const activities: Record<string, unknown>[] = [];
    const bridge = new CodexBridge({
      mesh,
      workspace: 'D:\\repo',
      onActivity: (activity) => activities.push(activity as unknown as Record<string, unknown>),
      createServer: async (handlers) => {
        server.notifications = handlers.onNotification;
        server.requests = handlers.onServerRequest;
        return server;
      },
    });
    await bridge.start();
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'cmd_1', type: 'commandExecution', command: 'npm test', status: 'completed' } },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(activities[0]?.kind, 'command');
    assert.equal(activities[0]?.command, 'npm test');
  });

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
    assert.equal((await first).answer, 'done');

    const second = bridge.runMention('second request');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_2', type: 'agentMessage', text: 'again' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    assert.equal((await second).answer, 'again');

    assert.equal(server.startedThreads, 1);
    assert.equal(server.startedTurns, 2);
    assert.equal((server.startedTurnInputs[0] as { summary?: string }).summary, 'concise');
    assert.equal(mesh.contexts.length, 1);
  });

  it('uses the App Server agent message as the turn result without publishing a duplicate activity', async () => {
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

    const turn = bridge.runMention('answer once');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({
      method: 'item/completed',
      params: { threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: 'single answer' } },
    });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });

    assert.equal((await turn).answer, 'single answer');
    assert.equal(mesh.events.some((entry) => entry.type === 'CODEX_ACTIVITY' && entry.payload.kind === 'message'), false);
  });

  it('collects one final change summary and publishes it on demand', async () => {
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

    const turn = bridge.runMention('change files');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({ method: 'item/completed', params: {
      threadId: 'thr_1', turnId: 'turn_1',
      item: { id: 'file_1', type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', diff: '@@ -1 +1,2 @@\n-old\n+new\n+more' }] },
    } });
    server.notifications({ method: 'item/completed', params: {
      threadId: 'thr_1', turnId: 'turn_1',
      item: { id: 'file_2', type: 'fileChange', status: 'completed', changes: [{ path: 'b.ts', diff: '@@ -0,0 +1 @@\n+added' }] },
    } });
    server.notifications({ method: 'item/completed', params: {
      threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: 'done' },
    } });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });

    const result = await turn;
    assert.deepEqual(result.changeSummary, {
      threadId: 'thr_1', turnId: 'turn_1', files: ['a.ts', 'b.ts'], additions: 3, deletions: 1,
      fileStats: [
        { path: 'a.ts', additions: 2, deletions: 1, diff: '@@ -1 +1,2 @@\n-old\n+new\n+more' },
        { path: 'b.ts', additions: 1, deletions: 0, diff: '@@ -0,0 +1 @@\n+added' },
      ],
    });
    assert.equal(mesh.events.some((entry) => entry.payload.kind === 'turnSummary'), false);
    await bridge.publishChangeSummary(result.changeSummary);
    assert.deepEqual(mesh.events.at(-1)?.payload, {
      agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', kind: 'turnSummary', status: 'completed',
      files: ['a.ts', 'b.ts'], additions: 3, deletions: 1,
      fileStats: [
        { path: 'a.ts', additions: 2, deletions: 1, diff: '@@ -1 +1,2 @@\n-old\n+new\n+more' },
        { path: 'b.ts', additions: 1, deletions: 0, diff: '@@ -0,0 +1 @@\n+added' },
      ],
    });
  });

  it('publishes the current context usage from official App Server notifications', async () => {
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
    const turn = bridge.runMention('inspect context');
    await new Promise((resolve) => setImmediate(resolve));
    server.notifications({ method: 'thread/tokenUsage/updated', params: {
      threadId: 'thr_1', turnId: 'turn_1',
      tokenUsage: {
        total: { totalTokens: 70_000 },
        last: { totalTokens: 42_000, inputTokens: 40_000, outputTokens: 2_000 },
        modelContextWindow: 100_000,
      },
    } });
    await new Promise((resolve) => setImmediate(resolve));

    const state = mesh.events.filter((entry) => entry.type === 'CODEX_THREAD_STATE').at(-1)?.payload;
    assert.equal(state?.contextTokens, 42_000);
    assert.equal(state?.contextWindow, 100_000);

    server.notifications({ method: 'item/completed', params: {
      threadId: 'thr_1', turnId: 'turn_1', item: { id: 'msg_1', type: 'agentMessage', text: 'done' },
    } });
    server.notifications({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } });
    await turn;
  });

  it('allows danger-full-access directly from the session settings', async () => {
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
    await bridge.handleControl({
      requestId: 'req_1',
      agentId: 'agt_1',
      action: 'createThread',
      sandbox: 'dangerFullAccess',
    });
    assert.equal(server.startedThreads, 1);
    assert.equal(mesh.events.some((event) => event.payload.error !== undefined), false);
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
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
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
      summary: 'concise',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
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
