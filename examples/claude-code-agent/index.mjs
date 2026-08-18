#!/usr/bin/env node
/**
 * Example: put a local coding agent CLI into an AgentMesh session.
 *
 * This bridge shells out to `claude -p` (Claude Code in non-interactive mode),
 * but the shape is the same for any command-line agent: read the mention, run
 * the tool in your workspace, report what happened back to the session.
 *
 * It also demonstrates the two things that make an agent a good citizen of a
 * session: publishing git activity as a structured event, and recording
 * contracts in shared context rather than only describing them in chat.
 *
 * Usage:
 *   agentmesh agent register "Frontend Claude" --provider anthropic \
 *     --model claude-opus -c coding,git,frontend
 *   AGENTMESH_TOKEN=ama_... AGENT_WORKSPACE=/path/to/repo node index.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from '@agentmesh/sdk';

const run = promisify(execFile);

const url = process.env.AGENTMESH_URL ?? 'http://localhost:4000';
const token = process.env.AGENTMESH_TOKEN;
const workspace = process.env.AGENT_WORKSPACE ?? process.cwd();
const command = process.env.AGENT_COMMAND ?? 'claude';

if (!token) {
  console.error('Set AGENTMESH_TOKEN to an agent token from: agentmesh agent register <name>');
  process.exit(1);
}

const mesh = await connect({ url, token, clientName: 'claude-code-agent' });
console.log(`connected to ${mesh.sessionId} as ${mesh.identity?.name}, workspace ${workspace}`);

async function git(...args) {
  try {
    const { stdout } = await run('git', args, { cwd: workspace });
    return stdout.trim();
  } catch {
    return '';
  }
}

/** Tell the session where this agent's workspace currently stands. */
async function reportGitState() {
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const commit = await git('rev-parse', 'HEAD');
  if (!commit) return;

  const changed = (await git('diff', '--name-only', 'HEAD~1..HEAD'))
    .split('\n')
    .filter(Boolean)
    .slice(0, 50)
    .map((path) => ({ path, change: 'modified' }));

  // Self-reported: the server stores this claim, it does not verify it, and it
  // never sees the contents of these files - only their paths.
  await mesh.reportCommit(
    { branch, commit },
    { message: await git('log', '-1', '--pretty=%s'), files: changed },
  );
}

mesh.onMention(async (message) => {
  const instruction = message.body.replace(/@[a-zA-Z0-9._-]+/g, '').trim();
  if (!instruction) return;

  console.log(`<- ${message.author.name}: ${instruction}`);
  await mesh.setStatus('working');

  // Hand the agent the session's shared context, so it works from what the
  // team has agreed rather than from this one message.
  const context = await mesh.getContext();
  const brief = context
    .map((entry) => `${entry.kind}:${entry.key} - ${entry.title}\n${entry.body ?? JSON.stringify(entry.data)}`)
    .join('\n\n');

  const prompt = [
    'You are working in a shared session with other developers and agents.',
    brief && `Shared project context:\n${brief}`,
    `Task from ${message.author.name}: ${instruction}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const { stdout } = await run(command, ['-p', prompt], {
      cwd: workspace,
      maxBuffer: 8 * 1024 * 1024,
    });
    await mesh.reply(message, stdout.trim().slice(0, 4000) || 'Done.');
    await reportGitState();
    await mesh.setStatus('idle');
  } catch (error) {
    await mesh.publishEvent('AGENT_BLOCKED', {
      reason: String(error.message).slice(0, 500),
      needs: 'A human should check the agent workspace.',
    });
    await mesh.setStatus('blocked');
  }
});

process.on('SIGINT', () => {
  mesh.close();
  process.exit(0);
});
