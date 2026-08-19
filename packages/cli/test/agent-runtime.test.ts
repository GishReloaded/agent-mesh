import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PRESETS, getPreset, substitute } from '../src/agent-runtime/presets.js';
import { stripSelfMention } from '../src/agent-runtime/prompt.js';
import { prepareCommand, quoteForCmd, resolveCommand, runProcess } from '../src/agent-runtime/spawn.js';

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

describe('building the instruction', () => {
  it('removes only the agent being addressed', () => {
    // "@claude say hello to @gpt" must not become "say hello to". Stripping
    // every mention destroys the object of the sentence, and the agent has to
    // ask what it was told to do.
    assert.equal(
      stripSelfMention('@claude поздоровайся с @gpt', 'Claude'),
      'поздоровайся с @gpt',
    );
  });

  it('handles the handle form of a multi-word name', () => {
    assert.equal(
      stripSelfMention('@backend-gpt ship it', 'Backend GPT'),
      'ship it',
    );
  });

  it('removes the mention wherever it appears, with trailing punctuation', () => {
    assert.equal(stripSelfMention('hey @claude, look at @gpt', 'Claude'), 'hey look at @gpt');
  });

  it('leaves the message alone when the agent is not named', () => {
    assert.equal(stripSelfMention('@all ship it', 'Claude'), '@all ship it');
    assert.equal(stripSelfMention('@claude ship it', undefined), '@claude ship it');
  });

  it('does not strip a longer handle that merely starts the same', () => {
    assert.equal(stripSelfMention('@claude-two ship it', 'Claude'), '@claude-two ship it');
  });
});

describe('preparing a command', () => {
  it('runs a plain executable directly', () => {
    const prepared = prepareCommand('node', ['-e', 'x']);
    assert.equal(prepared.windowsVerbatimArguments, false);
    assert.deepEqual(prepared.args, ['-e', 'x']);
  });

  it('routes Windows batch shims through cmd.exe', { skip: process.platform !== 'win32' }, () => {
    // Node refuses to spawn .cmd files without a shell since the fix for
    // CVE-2024-27980; npm-installed CLI tools on Windows are all .cmd shims.
    const prepared = prepareCommand('npm', ['--version']);
    assert.match(prepared.file.toLowerCase(), /cmd\.exe$/);
    assert.equal(prepared.windowsVerbatimArguments, true);
    assert.equal(prepared.args[0], '/d');
    assert.equal(prepared.args[2], '/c');
  });

  it('quotes arguments for cmd without letting them become syntax', () => {
    assert.equal(quoteForCmd('simple'), 'simple');
    assert.equal(quoteForCmd('with space'), '"with space"');
    assert.equal(quoteForCmd('a & b'), '"a & b"');
    assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteForCmd(''), '""');
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
