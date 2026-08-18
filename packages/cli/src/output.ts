/** Terminal output helpers. No dependency - a few ANSI codes are enough. */

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const ESC = String.fromCharCode(27) + '[';
const code = (open: number, close: number) => (text: string) =>
  useColor ? `${ESC}${open}m${text}${ESC}${close}m` : text;

export const style = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  yellow: code(33, 39),
  blue: code(34, 39),
  magenta: code(35, 39),
  cyan: code(36, 39),
  gray: code(90, 39),
};

export function info(message: string): void {
  process.stdout.write(`${message}\n`);
}

export function success(message: string): void {
  process.stdout.write(`${style.green('OK')} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${style.yellow('!')} ${message}\n`);
}

export function fail(message: string): void {
  process.stderr.write(`${style.red('x')} ${message}\n`);
}

export function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function table(rows: Record<string, string>[], columns?: string[]): void {
  if (rows.length === 0) {
    info(style.dim('(nothing to show)'));
    return;
  }
  const keys = columns ?? Object.keys(rows[0] ?? {});
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => (row[key] ?? '').length)));

  info(keys.map((key, index) => style.dim(key.padEnd(widths[index] ?? 0))).join('  '));
  for (const row of rows) {
    info(keys.map((key, index) => (row[key] ?? '').padEnd(widths[index] ?? 0)).join('  '));
  }
}

/** `2026-08-18T09:12:00Z` -> `09:12:00`, for chat-style output. */
export function clock(timestamp: string): string {
  return new Date(timestamp).toTimeString().slice(0, 8);
}

/**
 * Humans, agents and system notices get different markers so a terminal
 * transcript stays readable without colour.
 */
export function actorLabel(actor: { type: string; name: string | null }): string {
  const name = actor.name ?? 'unknown';
  if (actor.type === 'agent') return style.magenta(`[agent] ${name}`);
  if (actor.type === 'system') return style.gray(`[system] ${name}`);
  return style.cyan(`[user]  ${name}`);
}
