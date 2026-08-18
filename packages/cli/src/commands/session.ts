import type { Command } from 'commander';
import { createContext, resolveSession } from '../client.js';
import { updateProfile } from '../config.js';
import { info, json, style, success, table } from '../output.js';

export function registerSessionCommands(program: Command): void {
  const session = program.command('session').description('Create and manage collaboration sessions');

  session
    .command('create <name>')
    .description('Create a new session')
    .option('-d, --description <text>', 'session description')
    .option('--slug <slug>', 'URL-friendly identifier')
    .option('--use', 'make this the current session', true)
    .action(async (name: string, options: { description?: string; slug?: string; use?: boolean }) => {
      const { rest } = createContext();
      const created = await rest.createSession({
        name,
        ...(options.description ? { description: options.description } : {}),
        ...(options.slug ? { slug: options.slug } : {}),
      });
      if (options.use !== false) updateProfile({ currentSession: created.id });
      success(`Created session ${style.bold(created.name)}`);
      info(`  id:   ${created.id}`);
      info(`  slug: ${created.slug}`);
    });

  session
    .command('list')
    .alias('ls')
    .description('List sessions you belong to')
    .option('--json', 'output raw JSON')
    .action(async (options: { json?: boolean }) => {
      const { rest, profile } = createContext();
      const sessions = await rest.listSessions();
      if (options.json) {
        json(sessions);
        return;
      }
      table(
        sessions.map((item) => ({
          '': item.id === profile.currentSession ? '*' : ' ',
          name: item.name,
          slug: item.slug,
          role: item.role,
          members: String(item.memberCount),
          agents: String(item.agentCount),
          online: String(item.onlineCount),
          id: item.id,
        })),
      );
    });

  session
    .command('show [id]')
    .description('Show session details, participants and agents')
    .option('--json', 'output raw JSON')
    .action(async (id: string | undefined, options: { json?: boolean }) => {
      const { rest } = createContext();
      const detail = await rest.getSession(resolveSession(id));
      if (options.json) {
        json(detail);
        return;
      }
      info(style.bold(detail.session.name));
      info(style.dim(`${detail.session.id}  role: ${detail.role}`));
      if (detail.session.description) info(detail.session.description);

      info(`\n${style.bold('Participants')}`);
      table(
        detail.members.map((member) => ({
          status: member.online ? style.green('online') : style.gray('offline'),
          name: member.user.displayName,
          role: member.role,
          id: member.user.id,
        })),
      );

      info(`\n${style.bold('Agents')}`);
      table(
        detail.agents.map((agent) => ({
          status: agent.online ? style.green(agent.status) : style.gray('offline'),
          name: agent.name,
          provider: agent.provider,
          model: agent.model,
          autonomy: agent.autonomy,
          capabilities: Object.entries(agent.capabilities)
            .filter(([, enabled]) => enabled)
            .map(([key]) => key)
            .join(','),
          id: agent.id,
        })),
      );
    });

  session
    .command('use <id>')
    .description('Set the default session for subsequent commands')
    .action(async (id: string) => {
      const { rest } = createContext();
      const detail = await rest.getSession(id);
      updateProfile({ currentSession: detail.session.id });
      success(`Now using ${style.bold(detail.session.name)} (${detail.session.id})`);
    });

  session
    .command('join <token>')
    .description('Join a session with an invite token')
    .action(async (token: string) => {
      const { rest } = createContext();
      const detail = await rest.acceptInvite(token.replace(/^.*\/invite\//, ''));
      updateProfile({ currentSession: detail.session.id });
      success(
        detail.alreadyMember
          ? `Already a member of ${style.bold(detail.session.name)}`
          : `Joined ${style.bold(detail.session.name)} as ${detail.role}`,
      );
    });

  session
    .command('invite [id]')
    .description('Create an invite token for a session')
    .option('-r, --role <role>', 'member or viewer', 'member')
    .option('--uses <count>', 'how many times the invite may be used', '1')
    .option('--expires <seconds>', 'lifetime in seconds')
    .action(async (id: string | undefined, options: { role: string; uses: string; expires?: string }) => {
      const { rest } = createContext();
      const result = await rest.createInvite(resolveSession(id), {
        role: options.role === 'viewer' ? 'viewer' : 'member',
        maxUses: Number(options.uses),
        ...(options.expires ? { expiresIn: Number(options.expires) } : {}),
      });
      success('Invite created. It is shown once - copy it now:');
      info(`  token: ${style.bold(result.token)}`);
      if (result.url) info(`  url:   ${result.url}`);
      info(style.dim(`  expires: ${result.invite.expiresAt}  uses: ${result.invite.maxUses}`));
    });

  session
    .command('delete [id]')
    .description('Delete a session (owner only)')
    .action(async (id: string | undefined) => {
      const { rest } = createContext();
      const sessionId = resolveSession(id);
      await rest.deleteSession(sessionId);
      success(`Deleted session ${sessionId}`);
    });
}
