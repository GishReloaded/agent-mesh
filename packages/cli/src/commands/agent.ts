import { connect } from '@agentmesh/sdk';
import type { Command } from 'commander';
import { createContext, resolveSession } from '../client.js';
import { loadConfig, updateProfile } from '../config.js';
import { actorLabel, clock, info, json, style, success, table, warn } from '../output.js';

function parseCapabilities(list: string | undefined): Record<string, boolean> {
  if (!list) return {};
  return Object.fromEntries(
    list
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.startsWith('!') ? [item.slice(1), false] : [item, true])),
  );
}

export function registerAgentCommands(program: Command): void {
  const agent = program.command('agent').description('Register and run AgentMesh agents');

  agent
    .command('register <name>')
    .description('Register an agent in a session and print its token')
    .option('-s, --session <id>', 'session id or slug')
    .option('-p, --provider <provider>', 'provider label, e.g. openai / anthropic / local', 'custom')
    .option('-m, --model <model>', 'model label', 'unknown')
    .option('-c, --capabilities <list>', 'comma separated, prefix with ! to disable')
    .option('--autonomy <level>', 'manual | semi | auto', 'semi')
    .option('--machine <id>', 'machine identifier')
    .action(
      async (
        name: string,
        options: {
          session?: string;
          provider: string;
          model: string;
          capabilities?: string;
          autonomy: string;
          machine?: string;
        },
      ) => {
        const { rest } = createContext();
        const sessionId = resolveSession(options.session);
        const result = await rest.registerAgent(sessionId, {
          name,
          provider: options.provider,
          model: options.model,
          capabilities: parseCapabilities(options.capabilities),
          autonomy: options.autonomy as 'manual' | 'semi' | 'auto',
          ...(options.machine ? { machineId: options.machine } : {}),
        });

        // Store it so `agentmesh agent connect <name>` works without copying
        // tokens around; it is also printed once for use in other tooling.
        const config = loadConfig();
        const profile = config.profiles[config.profile];
        updateProfile({
          agentTokens: { ...(profile?.agentTokens ?? {}), [`${sessionId}:${name}`]: result.token },
        });

        success(`Registered agent ${style.bold(result.agent.name)}`);
        info(`  id:    ${result.agent.id}`);
        info(`  token: ${style.bold(result.token)}`);
        warn('The token is shown once. Store it in AGENTMESH_TOKEN for your agent runtime.');
      },
    );

  agent
    .command('list')
    .alias('ls')
    .description('List agents in a session')
    .option('-s, --session <id>', 'session id or slug')
    .option('--json', 'output raw JSON')
    .action(async (options: { session?: string; json?: boolean }) => {
      const { rest } = createContext();
      const agents = await rest.listAgents(resolveSession(options.session));
      if (options.json) {
        json(agents);
        return;
      }
      table(
        agents.map((item) => ({
          status: item.online ? style.green(item.status) : style.gray('offline'),
          name: item.name,
          provider: item.provider,
          model: item.model,
          autonomy: item.autonomy,
          id: item.id,
        })),
      );
    });

  agent
    .command('revoke <agentId>')
    .description('Disconnect an agent and revoke its token')
    .option('-s, --session <id>', 'session id or slug')
    .action(async (agentId: string, options: { session?: string }) => {
      const { rest } = createContext();
      await rest.revokeAgent(resolveSession(options.session), agentId);
      success(`Revoked agent ${agentId}`);
    });

  agent
    .command('connect [name]')
    .description('Connect as an agent and stream session activity')
    .option('-s, --session <id>', 'session id or slug')
    .option('-t, --token <token>', 'agent token (defaults to AGENTMESH_TOKEN or the stored one)')
    .action(async (name: string | undefined, options: { session?: string; token?: string }) => {
      const config = loadConfig();
      const profile = config.profiles[config.profile];
      const sessionId = options.session ?? profile?.currentSession;
      const stored = name && sessionId ? profile?.agentTokens?.[`${sessionId}:${name}`] : undefined;
      const token = options.token ?? process.env.AGENTMESH_TOKEN ?? stored;

      if (!token) {
        throw new Error(
          'No agent token. Register one with: agentmesh agent register <name>, or pass --token.',
        );
      }

      const mesh = await connect({
        url: profile?.url ?? 'http://localhost:4000',
        token,
        clientName: 'agentmesh-cli',
      });

      const identity = mesh.identity;
      success(
        `Connected as ${style.bold(identity?.kind === 'agent' ? identity.name : 'user')} to session ${mesh.sessionId}`,
      );
      info(style.dim('Streaming session activity. Press Ctrl+C to disconnect.\n'));

      mesh.on('event', (event) => {
        if (event.type === 'message.created') {
          const message = (event.payload as { message: { author: { type: string; name: string | null }; body: string } })
            .message;
          info(`${style.dim(clock(event.createdAt))} ${actorLabel(message.author)}: ${message.body}`);
          return;
        }
        info(
          `${style.dim(clock(event.createdAt))} ${style.yellow(event.type)} ${style.dim(
            JSON.stringify(event.payload).slice(0, 160),
          )}`,
        );
      });

      mesh.on('state', (state) => info(style.dim(`[connection ${state}]`)));

      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          mesh.close();
          resolve();
        });
      });
    });
}
