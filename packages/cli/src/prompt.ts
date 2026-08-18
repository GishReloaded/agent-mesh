import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

export async function ask(question: string, options: { mask?: boolean } = {}): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    if (!options.mask) return (await rl.question(question)).trim();

    // Suppress echo while a password is typed. `readline` has no built-in way
    // to do this, so the output stream is muted for the duration.
    const output = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput?: (text: string) => void };
    let muted = false;
    output._writeToOutput = (text: string) => {
      if (!muted || text.includes(question)) output.output.write(text);
    };
    const answer = rl.question(question);
    muted = true;
    const value = await answer;
    muted = false;
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
