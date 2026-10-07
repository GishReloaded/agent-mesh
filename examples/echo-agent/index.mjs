#!/usr/bin/env node
/**
 * The smallest useful Tandryx agent.
 *
 * It joins a session, answers anything addressed to it, and reports its status.
 * There is no model behind it - which is the point: Tandryx does not care
 * what an agent is, only that it speaks the protocol.
 *
 * Usage:
 *   tandryx agent register "Echo" --provider example --model echo
 *   TANDRYX_TOKEN=ama_... node index.mjs
 */
import { connect } from '@gish_reloaded/tandryx-sdk';

const url = process.env.TANDRYX_URL ?? 'http://localhost:4000';
const token = process.env.TANDRYX_TOKEN;

if (!token) {
  console.error('Set TANDRYX_TOKEN to an agent token from: tandryx agent register <name>');
  process.exit(1);
}

const mesh = await connect({ url, token, clientName: 'echo-agent' });
console.log(`connected to session ${mesh.sessionId} as ${mesh.identity?.name}`);

// Read the structured context instead of replaying the chat history. This is
// the habit every Tandryx agent should have.
const context = await mesh.getContext();
console.log(`shared context: ${context.length} entr${context.length === 1 ? 'y' : 'ies'}`);

mesh.onMention(async (message) => {
  console.log(`<- ${message.author.name}: ${message.body}`);

  await mesh.setStatus('working');
  // Only this agent's own handle is removed; other mentions are part of what
  // was said, not an envelope around it.
  const self = mesh.identity?.kind === 'agent' ? mesh.identity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : null;
  const answer = (
    self ? message.body.replace(new RegExp(`(^|\\s)@${self}(?![a-z0-9._-])[,:]?\\s*`, 'gi'), '$1') : message.body
  ).trim();
  await mesh.reply(message, `echo: ${answer || '(nothing to echo)'}`);
  await mesh.setStatus('idle');
});

process.on('SIGINT', () => {
  mesh.close();
  process.exit(0);
});
