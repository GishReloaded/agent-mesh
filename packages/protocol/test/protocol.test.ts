import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClientFrameType,
  ContextKind,
  DevEventType,
  LifecycleEventType,
  PROTOCOL_VERSION,
  Permission,
  SessionRole,
  can,
  clientFrameSchema,
  isCustomEventType,
  isPublishableEventType,
  isSupportedProtocolVersion,
  mentionsActor,
  parseEventPayload,
  parseMentions,
  toHandle,
} from '../src/index.js';

describe('protocol version', () => {
  it('declares agentmesh/v1', () => {
    assert.equal(PROTOCOL_VERSION, 'agentmesh/v1');
    assert.ok(isSupportedProtocolVersion('agentmesh/v1'));
    assert.equal(isSupportedProtocolVersion('agentmesh/v2'), false);
  });
});

describe('event types', () => {
  it('separates lifecycle events from publishable development events', () => {
    assert.equal(isPublishableEventType(LifecycleEventType.MessageCreated), false);
    assert.ok(isPublishableEventType(DevEventType.ApiContractCreated));
  });

  it('accepts namespaced custom events', () => {
    assert.ok(isCustomEventType('X_DEPLOY_STARTED'));
    assert.equal(isCustomEventType('DEPLOY_STARTED'), false);
    assert.ok(isPublishableEventType('X_DEPLOY_STARTED'));
  });

  it('validates development payloads against their schema', () => {
    const payload = parseEventPayload(DevEventType.ApiContractCreated, {
      service: 'auth',
      method: 'POST',
      endpoint: '/api/auth/login',
      response: { accessToken: 'string', expiresAt: 'datetime' },
      commit: '82af31',
      status: 'ready',
    }) as Record<string, unknown>;
    assert.equal(payload.service, 'auth');

    assert.throws(() => parseEventPayload(DevEventType.ApiContractCreated, { service: 'auth' }));
    assert.throws(() => parseEventPayload('NOT_A_REAL_EVENT', {}));
  });

  it('validates typed Codex control and activity events', () => {
    const control = parseEventPayload(DevEventType.CodexControlRequest, {
      requestId: 'req_1',
      agentId: 'agt_1',
      action: 'startTurn',
      threadId: 'thr_1',
      prompt: 'Inspect the failing test',
      model: 'gpt-5.6-terra',
    }) as Record<string, unknown>;
    assert.equal(control.action, 'startTurn');

    const settings = parseEventPayload(DevEventType.CodexControlRequest, {
      requestId: 'req_settings',
      agentId: 'agt_1',
      action: 'configureThread',
      threadId: 'thr_1',
      sandbox: 'readOnly',
      approvalPolicy: 'never',
      approvalsReviewer: 'auto_review',
    }) as Record<string, unknown>;
    assert.equal(settings.action, 'configureThread');
    assert.equal(settings.approvalsReviewer, 'auto_review');

    const activity = parseEventPayload(DevEventType.CodexActivity, {
      agentId: 'agt_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      kind: 'mcpTool',
      tool: 'search_graph',
      summary: 'Searching project symbols',
    }) as Record<string, unknown>;
    assert.equal(activity.kind, 'mcpTool');

    const command = parseEventPayload(DevEventType.CodexActivity, {
      agentId: 'agt_1',
      threadId: 'thr_1',
      itemId: 'cmd_1',
      kind: 'command',
      command: 'npm test',
      output: '17 tests passed',
      exitCode: 0,
      durationMs: 742,
    }) as Record<string, unknown>;
    assert.equal(command.output, '17 tests passed');

    const summary = parseEventPayload(DevEventType.CodexActivity, {
      agentId: 'agt_1', threadId: 'thr_1', turnId: 'turn_1', kind: 'turnSummary',
      status: 'completed', files: ['src/a.ts', 'src/b.ts'], additions: 12, deletions: 3,
      fileStats: [{ path: 'src/a.ts', additions: 10, deletions: 1 }, { path: 'src/b.ts', additions: 2, deletions: 2 }],
    }) as Record<string, unknown>;
    assert.equal(summary.kind, 'turnSummary');
    assert.equal(summary.additions, 12);
    assert.equal((summary.fileStats as unknown[]).length, 2);

    const contextState = parseEventPayload(DevEventType.CodexThreadState, {
      agentId: 'agt_1', threadId: 'thr_1', status: 'working', contextTokens: 42_000, contextWindow: 100_000,
    }) as Record<string, unknown>;
    assert.equal(contextState.contextTokens, 42_000);

    assert.throws(() =>
      parseEventPayload(DevEventType.CodexControlRequest, {
        requestId: 'req_2',
        agentId: 'agt_1',
        action: 'startTurn',
        threadId: 'thr_1',
      }),
    );
    assert.throws(() =>
      parseEventPayload(DevEventType.CodexActivity, {
        agentId: 'agt_1',
        threadId: 'thr_1',
        kind: 'command',
        environment: { OPENAI_API_KEY: 'secret' },
      }),
    );
  });

  it('passes custom payloads through untouched', () => {
    const payload = parseEventPayload('X_DEPLOY_STARTED', { env: 'staging', build: 42 });
    assert.deepEqual(payload, { env: 'staging', build: 42 });
  });
});

describe('permissions', () => {
  it('lets owners administer and viewers only read', () => {
    assert.ok(can(SessionRole.Owner, Permission.DeleteSession));
    assert.ok(can(SessionRole.Viewer, Permission.ReadSession));
    assert.equal(can(SessionRole.Viewer, Permission.WriteMessage), false);
  });

  it('lets agents contribute but never administer', () => {
    assert.ok(can(SessionRole.Agent, Permission.WriteMessage));
    assert.ok(can(SessionRole.Agent, Permission.WriteContext));
    assert.ok(can(SessionRole.Agent, Permission.PublishEvent));
    assert.equal(can(SessionRole.Agent, Permission.Invite), false);
    assert.equal(can(SessionRole.Agent, Permission.ManageMembers), false);
    assert.equal(can(SessionRole.Agent, Permission.DeleteSession), false);
    assert.equal(can(SessionRole.Agent, Permission.RegisterAgent), false);
    assert.equal(can(SessionRole.Agent, Permission.ControlAgent), false);
  });

  it('reserves durable context for AgentMesh-owned Codex threads', () => {
    assert.equal(ContextKind.CodexThread, 'codex_thread');
  });

  it('lets human members control their registered agents', () => {
    assert.ok(can(SessionRole.Owner, Permission.ControlAgent));
    assert.ok(can(SessionRole.Member, Permission.ControlAgent));
    assert.equal(can(SessionRole.Viewer, Permission.ControlAgent), false);
  });
});

describe('mentions', () => {
  const candidates = [
    { type: 'agent' as const, id: 'agt_1', handle: 'backend-gpt', displayName: 'Backend GPT' },
    { type: 'user' as const, id: 'usr_1', handle: 'alice', displayName: 'Alice' },
  ];

  it('derives handles from display names', () => {
    assert.equal(toHandle('Backend GPT'), 'backend-gpt');
    assert.equal(toHandle('  Claude Opus Frontend '), 'claude-opus-frontend');
  });

  it('resolves known handles and drops unknown ones', () => {
    const mentions = parseMentions('@backend-gpt please ping @alice, ignore @nobody', candidates);
    assert.deepEqual(
      mentions.map((m) => m.id),
      ['agt_1', 'usr_1'],
    );
  });

  it('treats @all as a broadcast', () => {
    const mentions = parseMentions('@all authentication contract changed', candidates);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0]?.type, 'all');
    assert.ok(mentionsActor(mentions, { type: 'agent', id: 'agt_2' }));
  });

  it('does not match inside words or emails', () => {
    assert.deepEqual(parseMentions('mail me at bob@alice.dev', candidates), []);
  });

  it('deduplicates repeated mentions', () => {
    const mentions = parseMentions('@alice @alice @alice', candidates);
    assert.equal(mentions.length, 1);
  });
});

describe('websocket frames', () => {
  it('accepts a well-formed message.send frame', () => {
    const frame = clientFrameSchema.parse({
      v: PROTOCOL_VERSION,
      id: '01JABCDEF',
      type: ClientFrameType.MessageSend,
      payload: { sessionId: 'ses_1', body: 'hello' },
    });
    assert.equal(frame.type, 'message.send');
  });

  it('rejects an unknown frame type', () => {
    assert.throws(() =>
      clientFrameSchema.parse({ v: PROTOCOL_VERSION, id: '1', type: 'nope', payload: {} }),
    );
  });

  it('rejects an empty message body', () => {
    assert.throws(() =>
      clientFrameSchema.parse({
        v: PROTOCOL_VERSION,
        id: '1',
        type: ClientFrameType.MessageSend,
        payload: { sessionId: 'ses_1', body: '' },
      }),
    );
  });
});
