import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mentionsActor, parseMentions } from '@agentmesh/protocol';

const participants = [
  { type: 'agent' as const, id: 'agt_gpt', handle: 'gpt', displayName: 'GPT' },
  { type: 'agent' as const, id: 'agt_claude', handle: 'claude', displayName: 'Claude' },
  { type: 'user' as const, id: 'usr_1', handle: 'gish-reloaded', displayName: 'Gish_Reloaded' },
];

const gpt = { type: 'agent' as const, id: 'agt_gpt' };
const claude = { type: 'agent' as const, id: 'agt_claude' };

/**
 * An agent receives every event in its session - that is what makes resume and
 * context work - but it must only *act* when it was addressed. These lock down
 * exactly who is addressed by a given message.
 */
describe('who a message is addressed to', () => {
  it('reaches only the agent that was named', () => {
    const mentions = parseMentions('@gpt привет как дела?', participants);
    assert.ok(mentionsActor(mentions, gpt));
    assert.equal(mentionsActor(mentions, claude), false);
  });

  it('reaches exactly the agents that were named', () => {
    const mentions = parseMentions('@gpt @claude привет как дела?', participants);
    assert.ok(mentionsActor(mentions, gpt));
    assert.ok(mentionsActor(mentions, claude));
  });

  it('reaches every agent for @all', () => {
    const mentions = parseMentions('@all authentication contract changed', participants);
    assert.ok(mentionsActor(mentions, gpt));
    assert.ok(mentionsActor(mentions, claude));
  });

  it('reaches no agent when nobody is named', () => {
    const mentions = parseMentions('просто болтаю с коллегой', participants);
    assert.deepEqual(mentions, []);
    assert.equal(mentionsActor(mentions, gpt), false);
    assert.equal(mentionsActor(mentions, claude), false);
  });

  it('does not treat a mention of a person as addressing an agent', () => {
    const mentions = parseMentions('@gish-reloaded посмотри пожалуйста', participants);
    assert.equal(mentionsActor(mentions, gpt), false);
    assert.equal(mentionsActor(mentions, claude), false);
  });

  it('ignores a handle that belongs to nobody', () => {
    const mentions = parseMentions('@nobody hello', participants);
    assert.deepEqual(mentions, []);
  });

  it('does not match a longer handle that merely starts the same', () => {
    const mentions = parseMentions('@gpt-two hello', [
      ...participants,
      { type: 'agent' as const, id: 'agt_gpt2', handle: 'gpt-two', displayName: 'GPT Two' },
    ]);
    assert.equal(mentionsActor(mentions, gpt), false);
    assert.ok(mentionsActor(mentions, { type: 'agent', id: 'agt_gpt2' }));
  });
});
