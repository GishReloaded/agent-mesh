/**
 * Parser for Claude Code's `--output-format stream-json` output.
 *
 * The tool emits one JSON object per line while it works: the model's thinking,
 * each tool it reaches for, rate-limit notices, and finally a `result` object
 * carrying the clean answer. Reading that stream is what lets a session show
 * *what an agent is doing* instead of a spinner - and it is also the only
 * correct way to get the answer in this mode, since stdout is JSON rather than
 * prose.
 *
 * Only summaries leave this file. A tool's arguments are reduced to a path or a
 * first line, and thinking is passed on only when the caller asks for it: the
 * server has no business holding the contents of someone's workspace.
 */

export interface ProgressStep {
  kind: 'thinking' | 'tool' | 'text' | 'status';
  tool?: string;
  detail?: string;
}

export interface StreamResult {
  /** The answer, taken from the tool's own `result` object. */
  text: string;
  isError: boolean;
  /** Present when the provider reported a limit rather than a failure. */
  rateLimited: string | null;
  durationMs: number | null;
}

export interface StreamHandlers {
  onStep?: (step: ProgressStep) => void;
  /** Thinking is verbose and often sensitive; off unless asked for. */
  includeThinking?: boolean;
}

interface Block {
  type?: string;
  name?: string;
  text?: string;
  input?: Record<string, unknown>;
}

/**
 * Feed output chunks in, get steps out as they arrive. Line-buffered, because
 * a chunk boundary lands mid-object often enough to matter.
 */
export class ClaudeStreamParser {
  private buffer = '';
  private result: StreamResult = { text: '', isError: false, rateLimited: null, durationMs: null };
  private currentTool: string | null = null;
  private thinking = '';

  constructor(private readonly handlers: StreamHandlers = {}) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  /** Call once the process has exited, to consume a trailing partial line. */
  finish(): StreamResult {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.line(rest);
    return this.result;
  }

  private line(raw: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Not every line is ours to understand - a warning printed by the tool
      // is not a reason to fail the whole run.
      return;
    }

    switch (parsed.type) {
      case 'system':
        if (parsed.subtype === 'init') this.emit({ kind: 'status', detail: 'starting' });
        return;

      case 'rate_limit_event': {
        const info = parsed.rate_limit_info as { status?: string; rateLimitType?: string } | undefined;
        if (info?.status && info.status !== 'allowed') {
          this.result.rateLimited = `${info.status}${info.rateLimitType ? ` (${info.rateLimitType})` : ''}`;
        }
        return;
      }

      case 'stream_event':
        this.streamEvent(parsed.event as Record<string, unknown> | undefined);
        return;

      case 'result': {
        this.result.text = typeof parsed.result === 'string' ? parsed.result : '';
        this.result.isError = parsed.is_error === true || parsed.subtype !== 'success';
        this.result.durationMs = typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null;
        return;
      }

      default:
        return;
    }
  }

  private streamEvent(event: Record<string, unknown> | undefined): void {
    if (!event) return;

    if (event.type === 'content_block_start') {
      const block = event.content_block as Block | undefined;
      if (block?.type === 'tool_use') {
        this.currentTool = block.name ?? 'tool';
        this.emit({ kind: 'tool', tool: this.currentTool, detail: summarizeInput(block.input) });
      }
      if (block?.type === 'thinking') this.thinking = '';
      return;
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta as { type?: string; thinking?: string } | undefined;
      if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        this.thinking += delta.thinking;
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      if (this.thinking && this.handlers.includeThinking) {
        this.emit({ kind: 'thinking', detail: firstSentence(this.thinking) });
      }
      this.thinking = '';
      this.currentTool = null;
      return;
    }
  }

  private emit(step: ProgressStep): void {
    this.handlers.onStep?.(step);
  }
}

/** Reduce a tool's arguments to the one thing worth showing. */
function summarizeInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return truncate(value.trim(), 160);
  }
  return undefined;
}

function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const stop = trimmed.search(/[.!?]\s/);
  return truncate(stop > 20 ? trimmed.slice(0, stop + 1) : trimmed, 200);
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
