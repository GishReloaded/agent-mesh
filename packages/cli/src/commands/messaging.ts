import { connect } from '@agentmesh/sdk';
import type { Command } from 'commander';
import { createContext, resolveSession } from '../client.js';
import { currentProfile, loadConfig } from '../config.js';
import { actorLabel, clock, info, json, style, success, table } from '../output.js';
import { readStdin } from '../prompt.js';

export function registerMessagingCommands(program: Command): void {
  program
    .command('send [message...]')
    .description('Send a message to the session (use @name to address someone)')
    .option('-s, --session <id>', 'session id or slug')
    .action(async (words: string[], options: { session?: string }) => {
      const body = words.length > 0 ? words.join(' ') : await readStdin();
      if (!body) throw new Error('Nothing to send. Pass a message or pipe it via stdin.');

      const { rest } = createContext();
      const message = await rest.sendMessage(resolveSession(options.session), { body });
      success(`Sent (seq ${message.seq})`);
    });

  program
    .command('messages')
    .description('Show recent messages')
    .option('-s, --session <id>', 'session id or slug')
    .option('-n, --limit <count>', 'how many messages', '30')
    .option('--json', 'output raw JSON')
    .action(async (options: { session?: string; limit: string; json?: boolean }) => {
      const { rest } = createContext();
      const page = await rest.messages(resolveSession(options.session), { limit: Number(options.limit) });
      if (options.json) {
        json(page);
        return;
      }
      for (const message of page.items) {
        info(`${style.dim(clock(message.createdAt))} ${actorLabel(message.author)}: ${message.body}`);
      }
    });

  program
    .command('watch')
    .description('Stream session activity in realtime')
    .option('-s, --session <id>', 'session id or slug')
    .option('--events', 'show every event, not just messages')
    .action(async (options: { session?: string; events?: boolean }) => {
      const profile = currentProfile(loadConfig());
      const token = process.env.AGENTMESH_TOKEN ?? profile.accessToken;
      if (!token) throw new Error('Not logged in. Run: agentmesh login');

      const sessionId = resolveSession(options.session);
      const mesh = await connect({ url: profile.url, token, sessionId, clientName: 'agentmesh-cli' });
      info(style.dim(`Watching ${sessionId}. Press Ctrl+C to stop.\n`));

      mesh.on('event', (event) => {
        if (event.type === 'message.created') {
          const message = (
            event.payload as { message: { author: { type: string; name: string | null }; body: string } }
          ).message;
          info(`${style.dim(clock(event.createdAt))} ${actorLabel(message.author)}: ${message.body}`);
          return;
        }
        if (!options.events) return;
        info(`${style.dim(clock(event.createdAt))} ${style.yellow(event.type)}`);
      });

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          mesh.close();
          resolve();
        });
      });
    });

  program
    .command('status')
    .description('Show the current profile, session and connection health')
    .action(async () => {
      const profile = currentProfile(loadConfig());
      info(`${style.bold('Server')}   ${profile.url}`);
      info(`${style.bold('Account')}  ${profile.displayName ?? style.dim('not signed in')}`);
      info(`${style.bold('Session')}  ${profile.currentSession ?? style.dim('none selected')}`);

      const { rest } = createContext();
      try {
        const version = await rest.version();
        info(`${style.bold('Protocol')} ${version.protocol} (server ${version.version})`);
      } catch (error) {
        info(`${style.bold('Protocol')} ${style.red('server unreachable')}`);
        info(style.dim(`  ${(error as Error).message}`));
        return;
      }

      if (!profile.currentSession || !profile.accessToken) return;
      const detail = await rest.getSession(profile.currentSession);
      table([
        {
          participants: String(detail.members.length),
          online: String(detail.members.filter((member) => member.online).length),
          agents: String(detail.agents.length),
          'agents online': String(detail.agents.filter((agent) => agent.online).length),
        },
      ]);
    });
}
