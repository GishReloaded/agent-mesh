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

/** How many times the same failure is announced in chat before going quiet. */
const MAX_REPORTED_FAILURES = 2;

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
  private consecutiveFailures = 0;
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
    if (this.options.dryRun) {
      warn('DRY RUN: mentions will be printed here and never answered. Remove --dry-run to reply for real.');
    }
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
    const self = mesh.identity?.kind === 'agent' ? mesh.identity.name : undefined;
    const prompt = [brief, buildTurn(message, recent, self)].filter(Boolean).join('\n\n---\n\n');

    const argsTemplate = first ? preset.args : (preset.continueArgs ?? preset.args);
    const args = substitute(argsTemplate, {
      prompt: preset.promptVia === 'arg' ? prompt : '',
      session: this.toolSessionId,
    }).filter((arg) => arg !== '' || preset.promptVia === 'arg');

    if (this.options.dryRun) {
      info(style.yellow('\n--- dry run: command that WOULD run ---'));
      info(`${preset.command} ${args.map(quoteForDisplay).join(' ')}`);
      info(style.yellow('--- prompt that WOULD be sent ---'));
      info(prompt);
      info(style.yellow('--- end of dry run ---'));
      // The person who wrote the mention is now waiting for an answer that is
      // never coming. Say so where the operator will see it.
      warn(
        `Nothing ran and nothing was posted, so ${message.author.name ?? 'the sender'} will get no reply.`,
      );
      warn('Restart without --dry-run to actually answer.\n');
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
      await this.reportFailure(
        `${preset.command} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped.`,
        'A human should check the agent workspace, or raise --timeout.',
      );
      return;
    }

    const answer = result.stdout.trim();
    if (result.code !== 0 || answer.length === 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 800);
      await this.reportFailure(`${preset.command} exited with code ${String(result.code)}.`, detail);
      return;
    }

    this.consecutiveFailures = 0;
    info(style.dim(`[done in ${seconds}s, ${answer.length} chars]`));
    await this.postAnswer(message, truncateForChat(answer));
    await mesh.setStatus('idle');
  }

  /**
   * Post the tool's answer.
   *
   * The server refuses a message that would extend an agent-to-agent exchange
   * past the chain limit. That refusal is about *routing*, not about the
   * answer: the model has already run and the work is paid for. So the reply
   * is posted again with the agent mentions taken out - it lands in the
   * session for the humans, and wakes nobody, which is exactly what the limit
   * is asking for.
   */
  private async postAnswer(message: Message, answer: string): Promise<void> {
    const mesh = this.mesh;
    if (!mesh) return;

    try {
      await mesh.reply(message, answer);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== 'AGENT_CHAIN_LIMIT') throw error;
    }

    warn('agent-to-agent chain limit reached - posting without mentions so a human can pick it up');
    const handles = mesh.agents.map((agent) => handleOf(agent.name)).filter(Boolean);
    await mesh.sendMessage(stripMentions(answer, handles));
  }

  /**
   * Announce that the local tool could not do its job.
   *
   * Two things matter here. The notice carries no mention, because a mention
   * is what wakes another agent up - a failing agent that addresses someone
   * gets answered, replies again, and two models spend a budget passing an
   * error message back and forth. And the reason travels in the message
   * itself: "see AGENT_BLOCKED" asks the reader to go dig for the one piece of
   * information they need.
   */
  private async reportFailure(reason: string, detail: string): Promise<void> {
    const mesh = this.mesh;
    warn(`${reason} ${detail}`);
    this.consecutiveFailures += 1;

    await mesh?.publishEvent('AGENT_BLOCKED', { reason: reason.slice(0, 500), needs: detail.slice(0, 2000) }).catch(
      () => undefined,
    );
    await mesh?.setStatus('blocked').catch(() => undefined);

    // Repeating the same failure into the chat helps nobody after the first
    // time; the events are still published for anyone watching.
    if (this.consecutiveFailures > MAX_REPORTED_FAILURES) {
      warn(`still failing (${this.consecutiveFailures}x) - staying quiet in chat until something succeeds`);
      return;
    }

    const firstLine = detail.split('\n').find((line) => line.trim().length > 0) ?? '';
    const summary = firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine;
    await mesh
      ?.sendMessage(`I could not run my local tool. ${reason}${summary ? `\n${summary}` : ''}`)
      .catch(() => undefined);
  }

  private async reportBlocked(error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    await this.reportFailure(reason, '');
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

/**
 * Remove mentions that would route the message to another agent, leaving the
 * text otherwise intact. `@all` goes too: it addresses agents as well.
 */
export function stripMentions(body: string, handles: readonly string[]): string {
  let result = body;
  for (const handle of [...handles, 'all']) {
    if (!handle) continue;
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`(^|\\s)@${escaped}(?![a-z0-9._-])[,:]?\\s*`, 'gi'), '$1');
  }
  return result.replace(/[^\S\n]{2,}/g, ' ').trim();
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
