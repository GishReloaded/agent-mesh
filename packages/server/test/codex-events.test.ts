import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DevEventType, SessionRole } from '@agentmesh/protocol';
import type { SessionAccess } from '../src/auth/principal.js';
import { assertCodexEventAuthority } from '../src/services/devEvents.js';

const ownerAccess: SessionAccess = {
  sessionId: 'ses_1',
  role: SessionRole.Owner,
  principal: { kind: 'user', userId: 'usr_owner', displayName: 'Owner' },
  actor: { type: 'user', id: 'usr_owner', name: 'Owner' },
};

const memberAccess: SessionAccess = {
  sessionId: 'ses_1',
  role: SessionRole.Member,
  principal: { kind: 'user', userId: 'usr_member', displayName: 'Member' },
  actor: { type: 'user', id: 'usr_member', name: 'Member' },
};

const agentAccess: SessionAccess = {
  sessionId: 'ses_1',
  role: SessionRole.Agent,
  principal: { kind: 'agent', agentId: 'agt_1', sessionId: 'ses_1', name: 'Codex', ownerUserId: 'usr_member' },
  actor: { type: 'agent', id: 'agt_1', name: 'Codex' },
};

describe('Codex event authority', () => {
  it('allows only the target agent to publish its state', () => {
    assert.doesNotThrow(() =>
      assertCodexEventAuthority(agentAccess, DevEventType.CodexThreadState, 'agt_1', 'usr_member'),
    );
    assert.throws(
      () => assertCodexEventAuthority(agentAccess, DevEventType.CodexThreadState, 'agt_2', 'usr_member'),
      /own Codex state/,
    );
    assert.throws(
      () => assertCodexEventAuthority(memberAccess, DevEventType.CodexThreadState, 'agt_1', 'usr_member'),
      /Only agents/,
    );
  });

  it('allows the session owner or agent registrar to control Codex', () => {
    assert.doesNotThrow(() =>
      assertCodexEventAuthority(ownerAccess, DevEventType.CodexControlRequest, 'agt_1', 'usr_else'),
    );
    assert.doesNotThrow(() =>
      assertCodexEventAuthority(memberAccess, DevEventType.CodexApprovalResponse, 'agt_1', 'usr_member'),
    );
    assert.throws(
      () => assertCodexEventAuthority(memberAccess, DevEventType.CodexControlRequest, 'agt_1', 'usr_else'),
      /registered this agent/,
    );
    assert.throws(
      () => assertCodexEventAuthority(agentAccess, DevEventType.CodexApprovalResponse, 'agt_1', 'usr_member'),
      /Only human users/,
    );
  });
});
