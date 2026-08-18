import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export async function ask(question: string, options: { mask?: boolean } = {}): Promise<string> {
  if (!options.mask) {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }

  // Suppress echo while a password is typed. readline offers no option for it,
  // so the prompt is written directly and the interface is given an output
  // stream that discards everything - rather than reaching into readline's
  // private fields, which change between Node versions.
  stdout.write(question);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: stdin, output: sink, terminal: true });
  try {
    const value = await rl.question('');
    stdout.write('\n');
    return value.trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string): Promise<boolean> {
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer);
}

/** Read piped stdin, for `echo "..." | agentmesh send`. */
export async function readStdin(): Promise<string | null> {
  if (stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length > 0 ? text : null;
}
