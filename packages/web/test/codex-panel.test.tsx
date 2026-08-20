import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { Agent, ContextEntry, Event as MeshEvent, Session } from '@agentmesh/sdk';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexAgentSettings, deriveCodexView } from '../src/components/CodexPanel.js';
import { MessageList, selectTimelineEvents } from '../src/components/Messages.js';

const actor = { type: 'agent' as const, id: 'agt_1', name: 'Codex' };
const now = '2026-08-20T00:00:00.000Z';

function event(seq: number, type: string, payload: Record<string, unknown>): MeshEvent {
  return { id: `evt_${seq}`, sessionId: 'ses_1', seq, type, actor, payload, createdAt: now };
}

const threadContext: ContextEntry = {
  id: 'ctx_1',
  sessionId: 'ses_1',
  kind: 'codex_thread',
  key: 'codex:agt_1:thr_1',
  title: 'Primary Codex',
  body: null,
  data: { agentId: 'agt_1', threadId: 'thr_1', title: 'Primary Codex', primary: true, archived: false },
  version: 1,
  createdBy: actor,
  updatedBy: actor,
  createdAt: now,
  updatedAt: now,
};

describe('Codex panel state', () => {
  it('lets the settings menu fill the conversation width without clipping keyboard focus', () => {
    const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

    assert.match(styles, /\.codex-agent-settings\s*{[^}]*width:\s*100%/s);
    assert.match(styles, /\.codex-agent-settings\s*>\s*summary:focus-visible\s*{[^}]*outline-offset:\s*-2px/s);
  });

  it('keeps Codex as compact agent settings instead of a second chat navigation', () => {
    const agent: Agent = {
      id: 'agt_1', sessionId: 'ses_1', name: 'GPT', provider: 'openai', model: 'codex', machineId: null,
      avatarColor: '#fff', capabilities: { coding: true }, status: 'idle', autonomy: 'semi', online: true,
      ownerUserId: 'usr_1', metadata: {}, lastSeenAt: now, createdAt: now,
    };
    const session = {
      id: 'ses_1', slug: 'test', name: 'Test', description: null, ownerId: 'usr_1', projectMeta: {},
      lastSeq: 0, createdAt: now, updatedAt: now, archivedAt: null,
    } as Session;
    const html = renderToStaticMarkup(
      <CodexAgentSettings
        view={deriveCodexView([threadContext], [event(1, 'CODEX_THREAD_STATE', {
          agentId: 'agt_1', threadId: 'thr_1', title: 'Codex 1', status: 'idle', model: 'gpt-test', primary: true,
          reasoningEffort: 'high',
          sandbox: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user',
          models: [{
            id: 'gpt-test', displayName: 'GPT Test', defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: ['low', 'medium', 'high'],
          }],
        })])}
        agents={[agent]}
        identity={{ kind: 'user', userId: 'usr_1', displayName: 'Owner' }}
        session={session}
        disabled={false}
        onControl={async () => undefined}
      />,
    );

    assert.match(html, /Codex settings/);
    assert.match(html, />Reasoning effort</);
    assert.match(html, /<option value="low">Low<\/option>/);
    assert.match(html, /<option value="medium">Medium<\/option>/);
    assert.match(html, /<option value="high" selected="">High<\/option>/);
    assert.match(html, />Permissions</);
    assert.match(html, />Ask for approval</);
    assert.match(html, />Approve for me</);
    assert.match(html, />Full access</);
    assert.doesNotMatch(html, />Sandbox<|>Approvals</);
    assert.doesNotMatch(html, /aria-label="Codex agent"/);
    assert.doesNotMatch(html, /Shared chat|New chat|Codex 1/);
  });

  it('combines durable thread metadata with the latest runtime state and activity', () => {
    const view = deriveCodexView([threadContext], [
      event(2, 'CODEX_THREAD_STATE', {
        agentId: 'agt_1',
        threadId: 'thr_1',
        status: 'idle',
        model: 'gpt-old',
      }),
      event(3, 'CODEX_THREAD_STATE', {
        agentId: 'agt_1',
        threadId: 'thr_1',
        status: 'working',
        model: 'gpt-current',
        activeTurnId: 'turn_1',
      }),
      event(4, 'CODEX_ACTIVITY', {
        agentId: 'agt_1',
        threadId: 'thr_1',
        turnId: 'turn_1',
        kind: 'mcpTool',
        tool: 'codebase-memory/search_graph',
      }),
    ]);
    assert.equal(view.threads[0]?.status, 'working');
    assert.equal(view.threads[0]?.model, 'gpt-current');
    assert.equal(view.activityByThread.get('thr_1')?.length, 1);
  });

  it('uses the latest runtime reasoning effort instead of stale context metadata', () => {
    const context = {
      ...threadContext,
      data: { ...threadContext.data, reasoningEffort: 'low' },
    };
    const view = deriveCodexView([context], [event(1, 'CODEX_THREAD_STATE', {
      agentId: 'agt_1', threadId: 'thr_1', status: 'idle', reasoningEffort: 'high',
    })]);

    assert.equal(view.threads[0]?.reasoningEffort, 'high');
  });

  it('derives and renders current Codex context usage', () => {
    const view = deriveCodexView([threadContext], [event(1, 'CODEX_THREAD_STATE', {
      agentId: 'agt_1', threadId: 'thr_1', status: 'working', contextTokens: 42_000, contextWindow: 100_000,
    })]);
    assert.equal(view.threads[0]?.contextTokens, 42_000);
    assert.equal(view.threads[0]?.contextWindow, 100_000);

    const html = renderToStaticMarkup(
      <CodexAgentSettings
        view={view}
        agents={[{
          id: 'agt_1', sessionId: 'ses_1', name: 'GPT', provider: 'openai', model: 'codex', machineId: null,
          avatarColor: '#fff', capabilities: { coding: true }, status: 'working', autonomy: 'semi', online: true,
          ownerUserId: 'usr_1', metadata: {}, lastSeenAt: now, createdAt: now,
        }]}
        identity={{ kind: 'user', userId: 'usr_1', displayName: 'Owner' }}
        session={{
          id: 'ses_1', slug: 'test', name: 'Test', description: null, ownerId: 'usr_1', projectMeta: {},
          lastSeq: 0, createdAt: now, updatedAt: now, archivedAt: null,
        }}
        disabled={false}
        onControl={async () => undefined}
      />,
    );
    assert.match(html, /Context 42% used/);
    assert.match(html, /42k \/ 100k tokens/);
    assert.match(html, /codex-context-meter/);
  });

  it('keeps only unresolved and unexpired approvals', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const view = deriveCodexView([threadContext], [
      event(5, 'CODEX_APPROVAL_REQUEST', {
        requestId: 'approval_1',
        agentId: 'agt_1',
        threadId: 'thr_1',
        kind: 'command',
        availableDecisions: ['accept', 'decline'],
        expiresAt: future,
      }),
      event(6, 'CODEX_APPROVAL_RESPONSE', {
        requestId: 'approval_1',
        agentId: 'agt_1',
        threadId: 'thr_1',
        decision: 'decline',
      }),
      event(7, 'CODEX_APPROVAL_REQUEST', {
        requestId: 'approval_2',
        agentId: 'agt_1',
        threadId: 'thr_1',
        kind: 'fileChange',
        availableDecisions: ['accept', 'decline'],
        expiresAt: future,
      }),
    ]);
    assert.deepEqual(view.pendingApprovals.map((approval) => approval.requestId), ['approval_2']);
  });
});

describe('shared chat timeline', () => {
  const events = [
    event(1, 'CODEX_ACTIVITY', { agentId: 'agt_1', threadId: 'thr_1', kind: 'reasoningSummary', summary: 'Checking the project structure.' }),
    event(2, 'BUILD_SUCCEEDED', { target: 'web' }),
    event(3, 'CODEX_ACTIVITY', { agentId: 'agt_1', threadId: 'thr_2', kind: 'command' }),
  ];

  it('keeps Codex activity visible in the shared room', () => {
    assert.deepEqual(selectTimelineEvents(events, null).map((item) => item.id), ['evt_1', 'evt_2', 'evt_3']);
  });

  it('never splits the session timeline by an internal Codex thread', () => {
    assert.deepEqual(selectTimelineEvents(events, 'thr_1').map((item) => item.id), ['evt_1', 'evt_2', 'evt_3']);
  });

  it('replaces an in-progress technical item with its completed form', () => {
    const duplicate = [
      event(10, 'CODEX_ACTIVITY', { agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'cmd_1', kind: 'command', status: 'inProgress' }),
      event(11, 'CODEX_ACTIVITY', { agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'cmd_1', kind: 'command', status: 'completed' }),
    ];
    assert.deepEqual(selectTimelineEvents(duplicate).map((item) => item.id), ['evt_11']);
  });

  it('hides empty reasoning events instead of rendering empty cards', () => {
    const emptyReasoning = event(4, 'CODEX_ACTIVITY', {
      agentId: 'agt_1', threadId: 'thr_1', kind: 'reasoningSummary', summary: '',
    });
    assert.deepEqual(selectTimelineEvents([...events, emptyReasoning], null).map((item) => item.id), ['evt_1', 'evt_2', 'evt_3']);
  });

  it('hides historical agentMessage activities because the final answer is a normal chat message', () => {
    const duplicateAnswer = event(12, 'CODEX_ACTIVITY', {
      agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'msg_1', kind: 'message', summary: 'same answer',
    });
    assert.deepEqual(selectTimelineEvents([...events, duplicateAnswer]).map((item) => item.id), ['evt_1', 'evt_2', 'evt_3']);
  });

  it('renders a reasoning summary as a Codex chat message', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={[events[0]!]}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /class="message agent codex-agent-message"/);
    assert.match(html, /Checking the project structure\./);
  });

  it('renders commands as compact expandable terminal output', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={[event(5, 'CODEX_ACTIVITY', {
          agentId: 'agt_1', threadId: 'thr_1', kind: 'command', status: 'completed',
          command: 'npm test', cwd: 'D:\\repo', output: '17 tests passed', exitCode: 0, durationMs: 742,
        })]}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /codex-command-card/);
    assert.match(html, /Ran command/);
    assert.match(html, /npm test/);
    assert.match(html, /17 tests passed/);
    assert.match(html, /exit 0/);
  });

  it('renders changed files as editor links with a colored mini diff', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={[event(6, 'CODEX_ACTIVITY', {
          agentId: 'agt_1', threadId: 'thr_1', kind: 'fileChange', status: 'completed',
          files: ['D:\\repo\\src\\index.ts'], diff: '@@ -1 +1 @@\n-old\n+new',
        })]}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /codex-file-card/);
    assert.match(html, /href="vscode:\/\/file\/D:\/repo\/src\/index\.ts"/);
    assert.match(html, /diff-remove/);
    assert.match(html, /diff-add/);
  });

  it('expands each final changed file into its colored changed lines', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={[event(7, 'CODEX_ACTIVITY', {
          agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', kind: 'turnSummary', status: 'completed',
          files: ['D:\\repo\\src\\a.ts', 'D:\\repo\\src\\b.ts'], additions: 44, deletions: 2,
          fileStats: [
            {
              path: 'D:\\repo\\src\\a.ts', additions: 40, deletions: 2,
              diff: '@@ -18,3 +18,3 @@ function run()\n unchanged context\n-old value\n+new value',
            },
            { path: 'D:\\repo\\src\\b.ts', additions: 4, deletions: 0, diff: '@@ -0,0 +1 @@\n+export {}' },
          ],
        })]}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /codex-turn-summary/);
    assert.match(html, /codex-turn-summary-head/);
    assert.doesNotMatch(html, /<details[^>]*codex-turn-summary/);
    assert.match(html, /Changed 2 files/);
    assert.doesNotMatch(html, /\+44/);
    assert.doesNotMatch(html, /vscode:\/\/file/);
    assert.match(html, /<details class="codex-file-stat"/);
    assert.match(html, /\+40/);
    assert.match(html, /−2/);
    assert.match(html, /diff-hunk/);
    assert.match(html, /diff-remove/);
    assert.match(html, /diff-add/);
    assert.match(html, /class="diff-remove" data-old-line="19" data-new-line=""/);
    assert.match(html, /class="diff-add" data-old-line="" data-new-line="19"/);
    assert.doesNotMatch(html, /unchanged context/);
  });

  it('makes a historical final summary expandable from its preceding single-file diff', () => {
    const diff = '@@ -1 +1 @@\n-old value\n+new value';
    const historicalEvents = [
      event(8, 'CODEX_ACTIVITY', {
        agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'file_1',
        kind: 'fileChange', status: 'completed', files: ['D:\\repo\\src\\a.ts'], diff,
      }),
      event(9, 'CODEX_ACTIVITY', {
        agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', kind: 'turnSummary', status: 'completed',
        files: ['D:\\repo\\src\\a.ts'], additions: 1, deletions: 1,
        fileStats: [{ path: 'D:\\repo\\src\\a.ts', additions: 1, deletions: 1 }],
      }),
    ];

    const summary = selectTimelineEvents(historicalEvents).find((item) => (
      (item.payload as Record<string, unknown>).kind === 'turnSummary'
    ));
    const summaryStats = (summary?.payload as Record<string, unknown>).fileStats as Array<Record<string, unknown>>;
    assert.equal(summaryStats[0]?.diff, diff);

    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={historicalEvents}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /codex-turn-summary[\s\S]*<details class="codex-file-stat"/);
  });

  it('renders compaction as a compact shared lifecycle event', () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[]}
        events={[event(8, 'CODEX_ACTIVITY', {
          agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', itemId: 'compact_1',
          kind: 'contextCompaction', status: 'completed',
        })]}
        identity={null}
        hasMore={false}
        onLoadMore={() => undefined}
        colorOf={() => null}
      />,
    );
    assert.match(html, /codex-context-compaction/);
    assert.match(html, /Context compacted/);
  });
});
