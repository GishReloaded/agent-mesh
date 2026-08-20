import type { AgentMeshSession, ContextEntry, Message, Task } from '@agentmesh/sdk';

const MAX_CONTEXT_CHARS = 12_000;

/**
 * Build what the local agent actually reads.
 *
 * The brief is assembled from *shared context* - current contracts, decisions,
 * project notes, open tasks - rather than from the message history. That is the
 * whole point of AgentMesh: an agent should work from what the team has agreed,
 * not infer it from a conversation and guess which message still holds.
 */
export async function buildBrief(mesh: AgentMeshSession): Promise<string> {
  const [context, tasks] = await Promise.all([
    mesh.getContext().catch(() => [] as ContextEntry[]),
    mesh.getTasks().catch(() => [] as Task[]),
  ]);

  const people = mesh.participants.map((member) => member.user.displayName);
  const self = identityName(mesh);
  const agents = mesh.agents.filter((agent) => agent.name !== self).map((agent) => agent.name);

  const sections: string[] = [
    `You are "${self}", a participant in a shared development session on AgentMesh.`,
    'Other participants you can address by mention:',
    `  people: ${people.length > 0 ? people.map(handle).join(', ') : '(none)'}`,
    `  agents: ${agents.length > 0 ? agents.map(handle).join(', ') : '(none)'}`,
    '',
    'Rules for this session:',
    '- Answer concisely. Your reply is posted verbatim into a team chat.',
    '- A mention wakes that participant and spends their budget. Mention someone',
    '  only when you need them to do something. Never mention another agent just',
    '  to acknowledge, greet or agree - that starts an exchange neither of you',
    '  can stop. Refer to them by name without @ when you only mean to mention them.',
    '- @all wakes every agent. Use it only for something everyone must act on.',
    '- Being named is not the same as being asked. If the request is plainly',
    '  directed at someone else and you are only mentioned in passing, do not',
    '  carry it out - say nothing of substance, or one short line at most.',
    '- If you change or decide something the others must know, say so explicitly.',
    '- If you cannot proceed, say what you are blocked on rather than guessing.',
  ];

  const grouped = groupByKind(context);
  for (const [kind, entries] of Object.entries(grouped)) {
    sections.push('', `${kind.replace('_', ' ').toUpperCase()}:`);
    for (const entry of entries) {
      const data = Object.keys(entry.data).length > 0 ? ` ${JSON.stringify(entry.data)}` : '';
      const body = entry.body ? `\n    ${entry.body.replace(/\n/g, '\n    ')}` : '';
      sections.push(`  [${entry.key} v${entry.version}] ${entry.title}${data}${body}`);
    }
  }

  const open = tasks.filter((task) => task.status !== 'done');
  if (open.length > 0) {
    sections.push('', 'OPEN TASKS:');
    for (const task of open) {
      sections.push(`  [${task.status}] ${task.title}${task.assignee ? ` -> ${task.assignee.name}` : ''}`);
    }
  }

  return truncate(sections.join('\n'), MAX_CONTEXT_CHARS);
}

/**
 * The instruction turn: who asked, what they asked, and recent chat for flow.
 *
 * Only the mention that addresses *this* agent is removed. Every other mention
 * stays, because it is usually part of the sentence rather than an envelope -
 * "@claude say hello to @gpt" means nothing once @gpt is stripped out.
 */
export function buildTurn(message: Message, recent: Message[], selfName?: string): string {
  const instruction = stripSelfMention(message.body, selfName).trim();

  const transcript = recent
    .filter((item) => item.id !== message.id)
    .slice(-6)
    .map((item) => `  ${item.author.name ?? 'unknown'}: ${item.body.replace(/\n/g, ' ').slice(0, 300)}`)
    .join('\n');

  // Who else the message named. Being mentioned is not the same as being the
  // one asked: a message can name an agent as the subject of the request
  // rather than as its recipient, and answering as if it were addressed to you
  // duplicates someone else's work.
  const named = [...message.body.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9._-]*)/g)].map((m) => `@${m[1]}`);
  const others = [...new Set(named)].filter((tag) => tag.toLowerCase() !== `@${handleOf(selfName)}`);

  return [
    transcript ? `Recent conversation:\n${transcript}\n` : '',
    others.length > 0 ? `This message also names ${others.join(', ')}.` : '',
    `${message.author.name ?? 'Someone'} asks you:`,
    instruction || '(no instruction given)',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Remove the agent's own handle only where it opens the message.
 *
 * A mention at the start is an envelope - "@claude do X" means "do X". The
 * same handle inside a sentence is part of the sentence: "@claude say hello to
 * @gpt" read by @gpt must not become "@claude say hello to", which is what
 * removing it everywhere produced. The agent then complained, correctly, that
 * the message was cut off.
 */
export function stripSelfMention(body: string, selfName?: string): string {
  if (!selfName) return body;
  const self = handle(selfName).slice(1);
  if (!self) return body;

  // Anchored, and only through the leading run of mentions: "@a @b do X"
  // addressed to @b should still lose @b. The lookahead stops `@claude` from
  // matching inside `@claude-two`, which is a different participant.
  const leading = new RegExp(`^((?:\\s*@[a-z0-9][a-z0-9._-]*[,:]?)*\\s*)@${escapeRegExp(self)}(?![a-z0-9._-])[,:]?`, 'i');
  return body.replace(leading, '$1').replace(/^[^\S\n]+/, '').replace(/[^\S\n]{2,}/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function identityName(mesh: AgentMeshSession): string {
  const identity = mesh.identity;
  return identity?.kind === 'agent' ? identity.name : 'an agent';
}

function handleOf(name?: string): string {
  return name ? handle(name).slice(1) : '';
}

function handle(name: string): string {
  return `@${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function groupByKind(entries: ContextEntry[]): Record<string, ContextEntry[]> {
  return entries.reduce<Record<string, ContextEntry[]>>((acc, entry) => {
    (acc[entry.kind] ??= []).push(entry);
    return acc;
  }, {});
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... (context truncated)`;
}
