import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESETS, getPreset, substitute } from '../src/agent-runtime/presets.js';
import { resolveCommand, runProcess } from '../src/agent-runtime/spawn.js';

describe('agent presets', () => {
  it('ships a preset for each subscription-backed tool', () => {
    for (const id of ['claude', 'codex', 'gemini', 'custom']) {
      assert.ok(PRESETS[id], `missing preset: ${id}`);
    }
  });

  it('rejects an unknown preset by name', () => {
    assert.throws(() => getPreset('nope'), /Unknown preset/);
  });

  it('substitutes the prompt and the tool session id', () => {
    const args = substitute(['exec', '--session', '{session}', '{prompt}'], {
      prompt: 'do the thing',
      session: 'abc-123',
    });
    assert.deepEqual(args, ['exec', '--session', 'abc-123', 'do the thing']);
  });

  it('lets Claude Code resume its own conversation across turns', () => {
    // Without this the agent would start from scratch on every mention and
    // forget what it just did in the same session.
    const claude = getPreset('claude');
    assert.ok(claude.continueArgs);
    assert.ok(claude.args.includes('--session-id'));
    assert.ok(claude.continueArgs?.includes('--resume'));
  });
});

describe('command resolution', () => {
  it('finds an executable on PATH', () => {
    const resolved = resolveCommand('node');
    assert.notEqual(resolved, 'node', 'node should resolve to a real path');
  });

  it('leaves an explicit path alone', () => {
    const explicit = process.platform === 'win32' ? 'C:\\tools\\thing.exe' : '/usr/bin/thing';
    assert.equal(resolveCommand(explicit), explicit);
  });

  it('returns the bare name when nothing matches, so the error stays readable', () => {
    assert.equal(resolveCommand('definitely-not-installed-xyz'), 'definitely-not-installed-xyz');
  });
});

describe('running a tool', () => {
  it('passes the prompt on stdin and captures stdout', async () => {
    const result = await runProcess({
      command: 'node',
      args: ['-e', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write("got:"+s))'],
      cwd: process.cwd(),
      stdin: 'a prompt with "quotes" and\nnewlines',
      timeoutMs: 15_000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    // Quoting is the reason stdin is preferred: prompts must survive verbatim.
    assert.match(result.stdout, /got:a prompt with "quotes" and\nnewlines/);
  });

  it('reports a non-zero exit rather than throwing', async () => {
    const result = await runProcess({
      command: 'node',
      args: ['-e', 'process.stderr.write("broken");process.exit(3)'],
      cwd: process.cwd(),
      timeoutMs: 15_000,
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /broken/);
  });

  it('kills a tool that runs past its timeout', async () => {
    const result = await runProcess({
      command: 'node',
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      cwd: process.cwd(),
      timeoutMs: 500,
    });
    assert.equal(result.timedOut, true);
  });

  it('fails with a usable message when the tool is not installed', async () => {
    await assert.rejects(
      runProcess({
        command: 'definitely-not-installed-xyz',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 5000,
      }),
      /was not found on PATH/,
    );
  });
});
