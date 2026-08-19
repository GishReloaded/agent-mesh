import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Append-only diagnostic log for an agent runtime.
 *
 * When a local tool fails, the one thing that answers "why" is what the tool
 * actually printed - and by the time anyone asks, the terminal has scrolled or
 * been closed. So every invocation is written to disk in full: the exact
 * command, the prompt it was given, and its complete stdout and stderr. The
 * chat message is a summary; this is the evidence.
 *
 * Tokens never reach it. The agent's credential is not part of any record
 * written here, and the log lives under the user's own profile directory.
 */
export class RunLog {
  private counter = 0;

  private constructor(readonly path: string | null) {}

  /** `null` disables logging entirely. */
  static open(explicitPath: string | null | undefined, sessionId: string, agentName: string): RunLog {
    if (explicitPath === null) return new RunLog(null);

    const path = explicitPath ? resolve(explicitPath) : RunLog.defaultPath(sessionId, agentName);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const log = new RunLog(path);
      log.section('session start', {
        agent: agentName,
        session: sessionId,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        cwd: process.cwd(),
      });
      return log;
    } catch {
      // A log that cannot be written must not stop the agent from working.
      return new RunLog(null);
    }
  }

  private static defaultPath(sessionId: string, agentName: string): string {
    const home = process.env.AGENTMESH_HOME ?? join(homedir(), '.agentmesh');
    const day = new Date().toISOString().slice(0, 10);
    const safeAgent = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    return join(home, 'logs', `${safeAgent}-${sessionId.slice(-8)}-${day}.log`);
  }

  /** A one-line event: connection state, a mention arriving, a status change. */
  event(message: string, detail?: Record<string, unknown>): void {
    const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
    this.write(`[${new Date().toISOString()}] ${message}${suffix}\n`);
  }

  private section(title: string, detail: Record<string, unknown>): void {
    const lines = Object.entries(detail).map(([key, value]) => `  ${key}: ${String(value)}`);
    this.write(`\n=== ${new Date().toISOString()}  ${title} ===\n${lines.join('\n')}\n`);
  }

  /**
   * A complete record of one tool run. Nothing is truncated: a stack trace cut
   * off at 800 characters is exactly the part you needed.
   */
  invocation(record: {
    command: string;
    args: string[];
    cwd: string;
    promptVia: string;
    prompt: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    requestedBy: string;
  }): void {
    if (!this.path) return;
    this.counter += 1;

    const parts = [
      `\n=== ${new Date().toISOString()}  invocation #${this.counter} ===`,
      `  requested by: ${record.requestedBy}`,
      `  command:      ${record.command} ${record.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`,
      `  cwd:          ${record.cwd}`,
      `  prompt via:   ${record.promptVia}`,
      `  result:       exit=${String(record.exitCode)} timedOut=${record.timedOut} duration=${Math.round(record.durationMs / 100) / 10}s`,
      `--- prompt (${record.prompt.length} chars) ---`,
      record.prompt,
      `--- stdout (${record.stdout.length} chars) ---`,
      record.stdout,
      `--- stderr (${record.stderr.length} chars) ---`,
      record.stderr,
      '--- end ---',
      '',
    ];
    this.write(parts.join('\n'));
  }

  private write(text: string): void {
    if (!this.path) return;
    try {
      appendFileSync(this.path, text, 'utf8');
    } catch {
      // Disk full, permissions, a removed directory - none of it is worth
      // interrupting the agent for.
    }
  }
}
