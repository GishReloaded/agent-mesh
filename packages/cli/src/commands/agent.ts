import { connect } from '@agentmesh/sdk';
import type { Command } from 'commander';
import { resolve } from 'node:path';
import { PRESETS, getPreset } from '../agent-runtime/presets.js';
import { AgentRunner } from '../agent-runtime/runner.js';
import { resolveCommand } from '../agent-runtime/spawn.js';
import { createContext, resolveSession } from '../client.js';
import { currentProfile, loadConfig, updateProfile } from '../config.js';
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
    .command('presets')
    .description('List built-in integrations for local, subscription-backed coding agents')
    .action(() => {
      info(
        style.dim(
          'These run the command-line tool of a product you already pay for.\n' +
            'They use the same login as its IDE extension - no API key involved.\n',
        ),
      );
      for (const preset of Object.values(PRESETS)) {
        const found = preset.command ? resolveCommand(preset.command) !== preset.command : false;
        const mark = preset.command === '' ? style.dim('n/a') : found ? style.green('installed') : style.yellow('not found');
        info(`${style.bold(preset.id.padEnd(8))} ${preset.label.padEnd(22)} ${mark}`);
        info(style.dim(`         ${preset.notes}`));
      }
      info(style.dim('\nRun one with:  agentmesh agent run <agent-name> --preset <id>'));
    });

  agent
    .command('run [name] [tool...]')
    .description('Run a local coding agent as a participant, driven by its own subscription')
    .option('-s, --session <id>', 'session id or slug')
    .option('-t, --token <token>', 'agent token (defaults to AGENTMESH_TOKEN or the stored one)')
    .option('-P, --preset <id>', 'claude | codex | gemini | custom', 'claude')
    .option('-w, --workspace <dir>', 'directory the tool runs in', process.cwd())
    .option('--command <bin>', 'override the executable')
    .option('--args <json>', 'override the argument list, as a JSON array using {prompt} and {session}')
    .option('--timeout <seconds>', 'how long one invocation may take', '600')
    .option('--queue <count>', 'how many pending mentions to hold', '3')
    .option('--dry-run', 'print the command and prompt instead of running the tool')
    .option('-v, --verbose', 'stream the tool output into this terminal')
    .option('--log-file <path>', 'where to append the full diagnostic log')
    .option('--no-log', 'do not write a diagnostic log')
    .action(
      async (
        name: string | undefined,
        tool: string[],
        options: {
          session?: string;
          token?: string;
          preset: string;
          workspace: string;
          command?: string;
          args?: string;
          timeout: string;
          queue: string;
          dryRun?: boolean;
          verbose?: boolean;
          logFile?: string;
          log?: boolean;
        },
      ) => {
        // Commander treats operands after `--` as positionals too, so the first
        // word of the tool command lands in `name`. Take the tool straight from
        // argv and drop the misassigned name.
        const dash = process.argv.indexOf('--');
        let agentName = name;
        if (dash >= 0) {
          tool = process.argv.slice(dash + 1);
          if (agentName === tool[0]) agentName = undefined;
        }

        const profile = currentProfile(loadConfig());
        const sessionId = options.session ?? profile.currentSession;
        const stored = agentName && sessionId ? profile.agentTokens?.[`${sessionId}:${agentName}`] : undefined;
        const token = options.token ?? process.env.AGENTMESH_TOKEN ?? stored;

        if (!token) {
          throw new Error(
            'No agent token. Register one first:\n' +
              `  agentmesh agent register "${agentName ?? 'My Agent'}" --provider <provider> --model <model>\n` +
              'then pass it with --token, or set AGENTMESH_TOKEN.',
          );
        }

        const preset = { ...getPreset(options.preset) };

        // `agentmesh agent run "Name" -- mytool --flag {prompt}` is the readable
        // way to plug in an arbitrary tool; the JSON form below stays for
        // scripts and config files.
        if (tool.length > 0) {
          preset.command = tool[0] as string;
          preset.args = tool.slice(1);
          preset.label = tool.join(' ');
          delete preset.continueArgs;
          // Without an explicit {prompt} placeholder the prompt goes to stdin,
          // which is what most CLI tools accept and avoids argv length limits.
          if (!preset.args.some((arg) => arg.includes('{prompt}'))) preset.promptVia = 'stdin';
        }

        if (options.command) preset.command = options.command;
        if (options.args) {
          const parsed: unknown = JSON.parse(options.args);
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
            throw new Error('--args must be a JSON array of strings, e.g. \'["exec","{prompt}"]\'');
          }
          preset.args = parsed as string[];
          // An overridden argument list invalidates the preset's resume flags.
          delete preset.continueArgs;
        }
        if (!preset.command) {
          throw new Error('This preset needs --command with the executable to run.');
        }

        const runner = new AgentRunner({
          url: profile.url,
          token,
          preset,
          workspace: resolve(options.workspace),
          timeoutMs: Number(options.timeout) * 1000,
          maxQueue: Number(options.queue),
          dryRun: Boolean(options.dryRun),
          verbose: Boolean(options.verbose),
          // commander turns --no-log into `log: false`.
          logFile: options.log === false ? null : (options.logFile ?? undefined),
        });

        await runner.start();

        await new Promise<void>((resolvePromise) => {
          process.on('SIGINT', () => {
            info(style.dim('\ndisconnecting...'));
            void runner.stop().then(() => resolvePromise());
          });
        });
      },
    );

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
