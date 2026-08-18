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
    const child = spawn(resolveCommand(options.command), options.args, {
      cwd: options.cwd,
      // No shell: prompts must not be re-parsed by cmd.exe or sh.
      shell: false,
      windowsHide: true,
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
