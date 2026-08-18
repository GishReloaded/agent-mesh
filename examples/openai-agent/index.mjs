#!/usr/bin/env node
/**
 * Example: bridge an OpenAI model into an AgentMesh session.
 *
 * Note where the provider lives. AgentMesh core knows nothing about OpenAI -
 * this file is the entire integration, it runs on the developer's machine, and
 * the API key never leaves it. Swapping providers means rewriting `ask()`,
 * nothing else.
 *
 * Usage:
 *   agentmesh agent register "Backend GPT" --provider openai --model gpt-5.6 \
 *     -c coding,git,backend
 *   AGENTMESH_TOKEN=ama_... OPENAI_API_KEY=sk-... node index.mjs
 */
import { connect } from '@agentmesh/sdk';

const url = process.env.AGENTMESH_URL ?? 'http://localhost:4000';
const token = process.env.AGENTMESH_TOKEN;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

if (!token || !apiKey) {
  console.error('Set AGENTMESH_TOKEN and OPENAI_API_KEY.');
  process.exit(1);
}

const mesh = await connect({ url, token, clientName: 'openai-agent' });
console.log(`connected to ${mesh.sessionId} as ${mesh.identity?.name}`);

/**
 * Build the prompt from *structured context*, not from the whole chat log.
 * This is the difference AgentMesh is built around: an agent asks the session
 * what is currently true, instead of inferring it from a conversation.
 */
async function buildSystemPrompt() {
  const [context, tasks] = await Promise.all([mesh.getContext(), mesh.getTasks()]);
  const contracts = context
    .filter((entry) => entry.kind === 'api_contract')
    .map((entry) => `- ${entry.title}: ${JSON.stringify(entry.data)}`)
    .join('\n');
  const decisions = context
    .filter((entry) => entry.kind === 'decision')
    .map((entry) => `- ${entry.title}: ${entry.body ?? ''}`)
    .join('\n');
  const open = tasks
    .filter((task) => task.status !== 'done')
    .map((task) => `- [${task.status}] ${task.title}`)
    .join('\n');

  return [
    `You are "${mesh.identity?.name}", one participant in a shared software project.`,
    `Other participants: ${[...mesh.participants.map((m) => m.user.displayName), ...mesh.agents.map((a) => a.name)].join(', ')}.`,
    'Answer briefly. To address someone, mention them as @their-name.',
    contracts && `\nAPI contracts already agreed:\n${contracts}`,
    decisions && `\nDecisions on record:\n${decisions}`,
    open && `\nOpen tasks:\n${open}`,
  ]
    .filter(Boolean)
    .join('\n');
}

async function ask(system, user) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '(no answer)';
}

mesh.onMention(async (message) => {
  console.log(`<- ${message.author.name}: ${message.body}`);
  await mesh.setStatus('working');
  try {
    const answer = await ask(await buildSystemPrompt(), `${message.author.name} says: ${message.body}`);
    await mesh.sendMessage(answer);
    await mesh.setStatus('idle');
  } catch (error) {
    // Being explicit about failure is better than going quiet: a blocked agent
    // is something the humans in the session need to see.
    await mesh.publishEvent('AGENT_BLOCKED', { reason: String(error.message).slice(0, 500) });
    await mesh.setStatus('blocked');
  }
});

process.on('SIGINT', () => {
  mesh.close();
  process.exit(0);
});
