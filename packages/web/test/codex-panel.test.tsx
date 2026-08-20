import assert from 'node:assert/strict';
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
          sandbox: 'workspaceWrite', approvalPolicy: 'on-request', models: [{ id: 'gpt-test', displayName: 'GPT Test' }],
        })])}
        agents={[agent]}
        identity={{ kind: 'user', userId: 'usr_1', displayName: 'Owner' }}
        session={session}
        disabled={false}
        onControl={async () => undefined}
      />,
    );

    assert.match(html, /Codex settings/);
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

  it('hides empty reasoning events instead of rendering empty cards', () => {
    const emptyReasoning = event(4, 'CODEX_ACTIVITY', {
      agentId: 'agt_1', threadId: 'thr_1', kind: 'reasoningSummary', summary: '',
    });
    assert.deepEqual(selectTimelineEvents([...events, emptyReasoning], null).map((item) => item.id), ['evt_1', 'evt_2', 'evt_3']);
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
});
