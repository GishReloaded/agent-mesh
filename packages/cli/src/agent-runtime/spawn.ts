import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Resolve an executable against PATH without going through a shell.
 *
 * On Windows, npm-installed tools are `.cmd` or `.ps1` shims that `spawn`
 * cannot execute by bare name. Going through `shell: true` would fix that but
 * would also concatenate arguments into a command line with no escaping - and
 * these arguments carry model prompts. Resolving the real file keeps the
 * argument vector intact.
 */
export function resolveCommand(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command;

  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];

  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = join(dir, command + extension.toLowerCase());
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export interface PreparedCommand {
  file: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Work out how to actually start a command.
 *
 * On Windows most CLI tools installed through npm are `.cmd` shims, and since
 * the fix for CVE-2024-27980 Node refuses to spawn those without a shell -
 * it fails with `EINVAL`. The safe way is to invoke `cmd.exe` explicitly and
 * build the command line ourselves, rather than setting `shell: true` and
 * letting Node concatenate arguments with no escaping at all.
 */
export function prepareCommand(command: string, args: string[]): PreparedCommand {
  const resolved = resolveCommand(command);

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(quoteForCmd).join(' ');
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      // /d skips AutoRun scripts, /s makes cmd strip exactly the outer quotes.
      args: ['/d', '/s', '/c', `"${line}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { file: resolved, args, windowsVerbatimArguments: false };
}

/**
 * Quote one argument for cmd.exe.
 *
 * Note that cmd still expands `%VAR%` inside double quotes, so a prompt
 * containing `%SOMETHING%` may come out altered. Presets that can take the
 * prompt on stdin avoid the problem entirely, which is why they do.
 */
export function quoteForCmd(value: string): string {
  if (value === '') return '""';
  if (!/[\s"&|<>^()%!,;=]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface RunOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Written to stdin, for tools that read the prompt from a pipe. */
  stdin?: string;
  timeoutMs: number;
  /** Called with output as it arrives, for live progress in the terminal. */
  onOutput?: (chunk: string) => void;
}

export function runProcess(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const prepared = prepareCommand(options.command, options.args);
    const child = spawn(prepared.file, prepared.args, {
      cwd: options.cwd,
      // Never `shell: true`: that would concatenate arguments with no escaping.
      // Windows batch shims are handled explicitly in prepareCommand instead.
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A coding agent mid-edit may ignore SIGTERM; do not wait forever.
      setTimeout(() => child.kill('SIGKILL'), 5000).unref?.();
    }, options.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onOutput?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Command "${options.command}" was not found on PATH. Install it, or pass --command with a full path.`,
          ),
        );
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin, 'utf8');
    }
    child.stdin.end();
  });
}
