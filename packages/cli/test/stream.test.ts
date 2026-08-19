import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClaudeStreamParser, type ProgressStep } from '../src/agent-runtime/stream.js';

/** Lines in the shape the installed CLI actually emits. */
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

const toolStart = (name: string, input: Record<string, unknown>) =>
  line({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name, input } },
  });

const thinking = (text: string) =>
  line({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  }) +
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } },
  }) +
  line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });

function collect(input: string, includeThinking = false): { steps: ProgressStep[]; parser: ClaudeStreamParser } {
  const steps: ProgressStep[] = [];
  const parser = new ClaudeStreamParser({ onStep: (step) => steps.push(step), includeThinking });
  parser.push(input);
  return { steps, parser };
}

describe('claude stream parsing', () => {
  it('takes the answer from the result object, not from stdout', () => {
    // stdout is NDJSON in this mode; posting it raw would put JSON in the chat.
    const { parser } = collect(
      line({ type: 'system', subtype: 'init' }) +
        line({ type: 'result', subtype: 'success', is_error: false, result: 'All done.', duration_ms: 1200 }),
    );
    const result = parser.finish();
    assert.equal(result.text, 'All done.');
    assert.equal(result.isError, false);
    assert.equal(result.durationMs, 1200);
  });

  it('reports each tool with what it was pointed at', () => {
    const { steps } = collect(
      toolStart('Read', { file_path: 'src/auth/AuthService.cs' }) +
        toolStart('Bash', { command: 'npm test' }),
    );
    const tools = steps.filter((step) => step.kind === 'tool');
    assert.deepEqual(
      tools.map((step) => [step.tool, step.detail]),
      [
        ['Read', 'src/auth/AuthService.cs'],
        ['Bash', 'npm test'],
      ],
    );
  });

  it('withholds reasoning unless it was asked for', () => {
    assert.equal(collect(thinking('I should look at the auth module first.')).steps.some((s) => s.kind === 'thinking'), false);

    const { steps } = collect(thinking('I should look at the auth module first. Then the tests.'), true);
    const step = steps.find((s) => s.kind === 'thinking');
    assert.ok(step);
    assert.match(step?.detail ?? '', /auth module/);
  });

  it('survives a chunk boundary in the middle of an object', () => {
    const steps: ProgressStep[] = [];
    const parser = new ClaudeStreamParser({ onStep: (step) => steps.push(step) });
    const whole = toolStart('Edit', { file_path: 'README.md' });
    parser.push(whole.slice(0, 30));
    parser.push(whole.slice(30));
    assert.equal(steps.filter((step) => step.kind === 'tool').length, 1);
  });

  it('ignores output that is not ours to understand', () => {
    const { parser } = collect('warning: something unrelated\n' + line({ type: 'result', result: 'fine' }));
    assert.equal(parser.finish().text, 'fine');
  });

  it('surfaces a provider rate limit rather than calling it a crash', () => {
    const { parser } = collect(
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } }) +
        line({ type: 'result', subtype: 'error', is_error: true, result: '' }),
    );
    const result = parser.finish();
    assert.equal(result.isError, true);
    assert.match(result.rateLimited ?? '', /rejected.*five_hour/);
  });

  it('treats an unsuccessful result as an error', () => {
    const { parser } = collect(line({ type: 'result', subtype: 'error_during_execution', result: '' }));
    assert.equal(parser.finish().isError, true);
  });
});
