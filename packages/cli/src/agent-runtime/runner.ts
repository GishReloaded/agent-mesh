import { randomUUID } from 'node:crypto';
import { connect, type AgentMeshSession, type Message } from '@agentmesh/sdk';
import { actorLabel, clock, info, style, success, warn } from '../output.js';
import { buildBrief, buildTurn } from './prompt.js';
import { getPreset, substitute, type AgentPreset } from './presets.js';
import { runProcess } from './spawn.js';

export interface RunnerOptions {
  url: string;
  token: string;
  preset: AgentPreset;
  workspace: string;
  timeoutMs: number;
  /** Queue depth. Extra mentions beyond this are declined rather than piled up. */
  maxQueue: number;
  /** Print the command and prompt instead of running the tool. */
  dryRun: boolean;
  verbose: boolean;
}

interface Job {
  message: Message;
}

/**
 * Bridges a local, subscription-backed coding agent into an AgentMesh session.
 *
 * The loop is deliberately simple: a mention arrives, the tool runs once in the
 * developer's workspace, its answer goes back to the session. What makes it
 * useful rather than a toy is what surrounds that call - the prompt is built
 * from shared context, work is serialised so one agent never runs twice at
 * once, and failure is reported as `AGENT_BLOCKED` instead of silence.
 */
export class AgentRunner {
  private mesh: AgentMeshSession | null = null;
  private queue: Job[] = [];
  private busy = false;
  private started = false;
  private hasRunOnce = false;
  /** Pins one conversation in tools that can resume, so turns build on each other. */
  private readonly toolSessionId = randomUUID();
  private stopping = false;

  constructor(private readonly options: RunnerOptions) {}

  async start(): Promise<void> {
    const mesh = await connect({
      url: this.options.url,
      token: this.options.token,
      clientName: `agentmesh-agent/${this.options.preset.id}`,
    });
    this.mesh = mesh;

    const name = mesh.identity?.kind === 'agent' ? mesh.identity.name : 'unknown';
    success(`Connected as ${style.bold(name)} to session ${mesh.sessionId}`);
    info(`  tool:      ${this.options.preset.label} (${this.options.preset.command})`);
    info(`  workspace: ${this.options.workspace}`);
    info(style.dim('  Waiting for mentions. Press Ctrl+C to disconnect.\n'));

    await mesh.setStatus('idle').catch(() => undefined);

    mesh.on('state', (state) => {
      if (state === 'reconnecting') warn('connection lost, reconnecting...');
      if (state === 'connected' && this.started) info(style.dim('[reconnected]'));
      this.started = true;
    });

    // Echo the room so the terminal is a usable transcript of what the agent sees.
    mesh.on('message', (message) => {
      if (message.author.id === (mesh.identity?.kind === 'agent' ? mesh.identity.agentId : null)) return;
      info(`${style.dim(clock(message.createdAt))} ${actorLabel(message.author)}: ${message.body}`);
    });

    mesh.onMention((message) => this.enqueue(message));
  }

  private enqueue(message: Message): void {
    if (this.stopping) return;

    if (this.queue.length >= this.options.maxQueue) {
      // Declining loudly beats silently dropping work a human is waiting on.
      void this.mesh?.sendMessage(
        `@${handleOf(message.author.name)} I have ${this.queue.length} requests queued already and dropped this one. Ask again when I catch up.`,
      );
      warn(`queue full, declined a request from ${message.author.name ?? 'unknown'}`);
      return;
    }

    this.queue.push({ message });
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.busy || this.stopping) return;
    const job = this.queue.shift();
    if (!job) return;

    this.busy = true;
    try {
      await this.handle(job.message);
    } catch (error) {
      await this.reportBlocked(error);
    } finally {
      this.busy = false;
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async handle(message: Message): Promise<void> {
    const mesh = this.mesh;
    if (!mesh) return;

    const { preset, workspace, timeoutMs } = this.options;
    // A tool that cannot resume its own conversation gets the full brief every
    // turn; one that can gets it once and builds on it afterwards.
    const first = !this.hasRunOnce || !preset.continueArgs;

    // Tools that resume their own conversation only need the full brief once;
    // re-sending it every turn would waste the context window it already has.
    const brief = first ? await buildBrief(mesh) : '';
    const recent = await mesh.getMessages(undefined, 10).then((page) => page.items).catch(() => []);
    const prompt = [brief, buildTurn(message, recent)].filter(Boolean).join('\n\n---\n\n');

    const argsTemplate = first ? preset.args : (preset.continueArgs ?? preset.args);
    const args = substitute(argsTemplate, {
      prompt: preset.promptVia === 'arg' ? prompt : '',
      session: this.toolSessionId,
    }).filter((arg) => arg !== '' || preset.promptVia === 'arg');

    if (this.options.dryRun) {
      info(style.yellow('\n--- dry run: command ---'));
      info(`${preset.command} ${args.map(quoteForDisplay).join(' ')}`);
      info(style.yellow('--- prompt ---'));
      info(prompt);
      info(style.yellow('--- end ---\n'));
      return;
    }

    await mesh.setStatus('working', `handling a request from ${message.author.name ?? 'someone'}`);
    info(style.dim(`[running ${preset.command}...]`));
    const startedAt = Date.now();

    const result = await runProcess({
      command: preset.command,
      args,
      cwd: workspace,
      ...(preset.promptVia === 'stdin' ? { stdin: prompt } : {}),
      timeoutMs,
      ...(this.options.verbose ? { onOutput: (chunk: string) => process.stdout.write(style.dim(chunk)) } : {}),
    });

    this.hasRunOnce = true;
    const seconds = Math.round((Date.now() - startedAt) / 1000);

    if (result.timedOut) {
      await mesh.publishEvent('AGENT_BLOCKED', {
        reason: `The local tool did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        needs: 'A human should check the agent workspace, or raise --timeout.',
      });
      await mesh.setStatus('blocked');
      await mesh.reply(message, `I stopped after ${seconds}s without an answer. See AGENT_BLOCKED.`);
      return;
    }

    const answer = result.stdout.trim();
    if (result.code !== 0 || answer.length === 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 800);
      await mesh.publishEvent('AGENT_BLOCKED', {
        reason: `${preset.command} exited with code ${String(result.code)}.`,
        needs: detail,
      });
      await mesh.setStatus('blocked');
      await mesh.reply(message, `My local tool failed (exit ${String(result.code)}). Details in AGENT_BLOCKED.`);
      return;
    }

    info(style.dim(`[done in ${seconds}s, ${answer.length} chars]`));
    await mesh.reply(message, truncateForChat(answer));
    await mesh.setStatus('idle');
  }

  private async reportBlocked(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    warn(reason);
    await this.mesh?.publishEvent('AGENT_BLOCKED', { reason: reason.slice(0, 500) }).catch(() => undefined);
    await this.mesh?.setStatus('blocked').catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.mesh?.setStatus('offline').catch(() => undefined);
    this.mesh?.close();
  }
}

/** Chat messages have a hard size limit; point at the terminal for the rest. */
function truncateForChat(text: string): string {
  const limit = 30_000;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n... (truncated; full output is in the agent's terminal)`;
}

function handleOf(name: string | null): string {
  return (name ?? 'all')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function quoteForDisplay(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

export function createRunner(options: Omit<RunnerOptions, 'preset'> & { preset: string }): AgentRunner {
  return new AgentRunner({ ...options, preset: getPreset(options.preset) });
}
