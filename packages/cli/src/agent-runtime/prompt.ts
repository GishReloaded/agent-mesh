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
    '- To address someone, mention them as @their-handle. @all broadcasts.',
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

/** The instruction turn: who asked, what they asked, and recent chat for flow. */
export function buildTurn(message: Message, recent: Message[]): string {
  const instruction = message.body.replace(/@[a-zA-Z0-9._-]+/g, '').trim();

  const transcript = recent
    .filter((item) => item.id !== message.id)
    .slice(-6)
    .map((item) => `  ${item.author.name ?? 'unknown'}: ${item.body.replace(/\n/g, ' ').slice(0, 300)}`)
    .join('\n');

  return [
    transcript ? `Recent conversation:\n${transcript}\n` : '',
    `${message.author.name ?? 'Someone'} asks you:`,
    instruction || '(no instruction given)',
  ]
    .filter(Boolean)
    .join('\n');
}

function identityName(mesh: AgentMeshSession): string {
  const identity = mesh.identity;
  return identity?.kind === 'agent' ? identity.name : 'an agent';
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
