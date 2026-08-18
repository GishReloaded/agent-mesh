import type { ContextKind, TaskStatus } from '@agentmesh/protocol';
import type { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { createContext, resolveSession } from '../client.js';
import { info, json, style, success, table } from '../output.js';

export function registerWorkCommands(program: Command): void {
  const task = program.command('task').description('Lightweight task tracking inside a session');

  task
    .command('list')
    .alias('ls')
    .description('List tasks')
    .option('-s, --session <id>', 'session id or slug')
    .option('--status <status>', 'todo | in_progress | blocked | review | done')
    .option('--json', 'output raw JSON')
    .action(async (options: { session?: string; status?: string; json?: boolean }) => {
      const { rest } = createContext();
      const tasks = await rest.tasks(
        resolveSession(options.session),
        options.status ? { status: options.status as TaskStatus } : {},
      );
      if (options.json) {
        json(tasks);
        return;
      }
      table(
        tasks.map((item) => ({
          status: item.status,
          title: item.title,
          assignee: item.assignee?.name ?? '-',
          id: item.id,
        })),
      );
    });

  task
    .command('create <title>')
    .description('Create a task')
    .option('-s, --session <id>', 'session id or slug')
    .option('-d, --description <text>', 'task description')
    .option('--assign <id>', 'assign to a user or agent id')
    .option('--assign-type <type>', 'user | agent', 'agent')
    .action(
      async (
        title: string,
        options: { session?: string; description?: string; assign?: string; assignType: string },
      ) => {
        const { rest } = createContext();
        const created = await rest.createTask(resolveSession(options.session), {
          title,
          ...(options.description ? { description: options.description } : {}),
          ...(options.assign
            ? { assignee: { type: options.assignType === 'user' ? 'user' : 'agent', id: options.assign } }
            : {}),
        });
        success(`Created task ${style.bold(created.title)} (${created.id})`);
      },
    );

  task
    .command('update <taskId>')
    .description('Update a task')
    .option('-s, --session <id>', 'session id or slug')
    .option('--status <status>', 'todo | in_progress | blocked | review | done')
    .option('--title <title>', 'new title')
    .option('--assign <id>', 'assign to a user or agent id')
    .option('--assign-type <type>', 'user | agent', 'agent')
    .action(
      async (
        taskId: string,
        options: { session?: string; status?: string; title?: string; assign?: string; assignType: string },
      ) => {
        const { rest } = createContext();
        const updated = await rest.updateTask(resolveSession(options.session), taskId, {
          ...(options.status ? { status: options.status as TaskStatus } : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(options.assign
            ? { assignee: { type: options.assignType === 'user' ? 'user' : 'agent', id: options.assign } }
            : {}),
        });
        success(`Task ${updated.id} is now ${style.bold(updated.status)}`);
      },
    );

  const context = program.command('context').description('Structured shared context of a session');

  context
    .command('list')
    .alias('ls')
    .description('List context entries')
    .option('-s, --session <id>', 'session id or slug')
    .option('-k, --kind <kind>', 'project | architecture | api_contract | decision | file | state | note')
    .option('--json', 'output raw JSON')
    .action(async (options: { session?: string; kind?: string; json?: boolean }) => {
      const { rest } = createContext();
      const entries = await rest.context(
        resolveSession(options.session),
        options.kind ? { kind: options.kind as ContextKind } : {},
      );
      if (options.json) {
        json(entries);
        return;
      }
      table(
        entries.map((entry) => ({
          kind: entry.kind,
          key: entry.key,
          title: entry.title,
          version: `v${entry.version}`,
          by: entry.updatedBy.name ?? '-',
        })),
      );
    });

  context
    .command('show <key>')
    .description('Show one context entry in full')
    .option('-s, --session <id>', 'session id or slug')
    .option('-k, --kind <kind>', 'context kind', 'decision')
    .action(async (key: string, options: { session?: string; kind: string }) => {
      const { rest } = createContext();
      const [entry] = await rest.context(resolveSession(options.session), {
        kind: options.kind as ContextKind,
        key,
      });
      if (!entry) throw new Error(`No ${options.kind} entry with key "${key}".`);
      info(`${style.bold(entry.title)} ${style.dim(`(${entry.kind}:${entry.key} v${entry.version})`)}`);
      if (entry.body) info(`\n${entry.body}`);
      if (Object.keys(entry.data).length > 0) {
        info(`\n${style.dim('data:')}`);
        json(entry.data);
      }
    });

  context
    .command('publish <kind> <key> <title>')
    .description('Publish or supersede a context entry')
    .option('-s, --session <id>', 'session id or slug')
    .option('-b, --body <text>', 'markdown body')
    .option('-f, --file <path>', 'read the body from a file')
    .option('--data <json>', 'machine-readable payload as JSON')
    .action(
      async (
        kind: string,
        key: string,
        title: string,
        options: { session?: string; body?: string; file?: string; data?: string },
      ) => {
        const { rest } = createContext();
        const body = options.file ? readFileSync(options.file, 'utf8') : options.body;
        const entry = await rest.publishContext(resolveSession(options.session), {
          kind: kind as ContextKind,
          key,
          title,
          ...(body ? { body } : {}),
          ...(options.data ? { data: JSON.parse(options.data) as Record<string, unknown> } : {}),
        });
        success(`Published ${entry.kind}:${entry.key} as v${entry.version}`);
      },
    );

  program
    .command('search <query>')
    .description('Search messages, tasks and context in a session')
    .option('-s, --session <id>', 'session id or slug')
    .action(async (query: string, options: { session?: string }) => {
      const { rest } = createContext();
      const results = await rest.search(resolveSession(options.session), query);
      info(style.bold(`Messages (${results.messages.length})`));
      for (const message of results.messages) {
        info(`  ${style.dim(message.author.name ?? '')}: ${message.body.slice(0, 120)}`);
      }
      info(style.bold(`\nTasks (${results.tasks.length})`));
      for (const item of results.tasks) info(`  [${item.status}] ${item.title}`);
      info(style.bold(`\nContext (${results.context.length})`));
      for (const entry of results.context) info(`  ${entry.kind}:${entry.key} ${entry.title}`);
    });

  program
    .command('event <type> [payload]')
    .description('Publish a development event, e.g. BUILD_FAILED or X_DEPLOY_STARTED')
    .option('-s, --session <id>', 'session id or slug')
    .action(async (type: string, payload: string | undefined, options: { session?: string }) => {
      const { rest } = createContext();
      const event = await rest.publishEvent(resolveSession(options.session), {
        type,
        payload: payload ? (JSON.parse(payload) as unknown) : {},
      });
      success(`Published ${event.type} (seq ${event.seq})`);
    });
}
