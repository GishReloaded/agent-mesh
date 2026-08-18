import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ClientFrameType,
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
