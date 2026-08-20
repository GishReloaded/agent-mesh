import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JsonlRpcClient, sanitizeCodexNotification } from '../src/agent-runtime/codex-app-server.js';

describe('Codex app-server JSONL client', () => {
  it('correlates responses while forwarding unknown notifications', async () => {
    const sent: Record<string, unknown>[] = [];
    const notifications: { method: string; params: unknown }[] = [];
    const client = new JsonlRpcClient(
      (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
      (message) => notifications.push(message),
    );

    const pending = client.request<{ thread: { id: string } }>('thread/start', { cwd: 'D:\\repo' });
    const id = sent[0]?.id;
    client.receive(JSON.stringify({ method: 'future/notification', params: { enabled: true } }));
    client.receive(JSON.stringify({ id, result: { thread: { id: 'thr_1' } } }));

    assert.equal((await pending).thread.id, 'thr_1');
    assert.deepEqual(notifications, [{ method: 'future/notification', params: { enabled: true } }]);
  });

  it('forwards server requests and writes a response with the original id', () => {
    const sent: Record<string, unknown>[] = [];
    const requests: { id: number | string; method: string; params: unknown }[] = [];
    const client = new JsonlRpcClient(
      (line) => sent.push(JSON.parse(line) as Record<string, unknown>),
      undefined,
      (message) => requests.push(message),
    );

    client.receive(
      JSON.stringify({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: 'thr_1' } }),
    );
    assert.equal(requests[0]?.id, 91);
    client.respond(91, { decision: 'decline' });
    assert.deepEqual(sent[0], { id: 91, result: { decision: 'decline' } });
  });

  it('rejects pending requests when the process closes', async () => {
    const client = new JsonlRpcClient(() => undefined);
    const pending = client.request('model/list', {});
    client.close(new Error('app-server exited'));
    await assert.rejects(pending, /app-server exited/);
  });
});

describe('Codex event sanitization', () => {
  it('keeps a reasoning summary but drops raw reasoning and auth-shaped fields', () => {
    const safe = sanitizeCodexNotification('item/reasoning/summaryTextDelta', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      delta: 'Checking the dependency graph',
      rawReasoning: 'private chain of thought',
      accessToken: 'secret',
    });
    assert.deepEqual(safe, {
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      kind: 'reasoningSummary',
      summary: 'Checking the dependency graph',
    });
  });

  it('keeps bounded command output and execution metadata', () => {
    const safe = sanitizeCodexNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'cmd_1', type: 'commandExecution', command: 'npm test', cwd: 'D:\\repo', status: 'completed',
        aggregatedOutput: '17 tests passed', exitCode: 0, durationMs: 742,
        environment: { SECRET: 'must-not-leak' },
      },
    });
    assert.deepEqual(safe, {
      threadId: 'thr_1', turnId: 'turn_1', itemId: 'cmd_1', kind: 'command', command: 'npm test', cwd: 'D:\\repo',
      status: 'completed', output: '17 tests passed', exitCode: 0, durationMs: 742,
    });
  });

  it('exposes compaction as a safe lifecycle activity', () => {
    const safe = sanitizeCodexNotification('item/completed', {
      threadId: 'thr_1', turnId: 'turn_1',
      item: { id: 'compact_1', type: 'contextCompaction', encryptedContent: 'secret' },
    });
    assert.deepEqual(safe, {
      threadId: 'thr_1', turnId: 'turn_1', itemId: 'compact_1', kind: 'contextCompaction', status: 'completed',
    });
  });
});
