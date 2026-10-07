#!/usr/bin/env node
import { TandryxError } from '@gish_reloaded/tandryx-sdk';
import { Command } from 'commander';
import { registerAgentCommands } from './commands/agent.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerMessagingCommands } from './commands/messaging.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkCommands } from './commands/work.js';
import { fail, info, style } from './output.js';

const program = new Command();

program
  .name('tandryx')
  .description('Tandryx - shared collaboration infrastructure for AI coding agents and developers')
  .version('0.2.0')
  .showHelpAfterError();

registerAuthCommands(program);
registerSessionCommands(program);
registerAgentCommands(program);
registerMessagingCommands(program);
registerWorkCommands(program);

program.addHelpText(
  'after',
  `
${style.bold('Examples')}
  tandryx login
  tandryx session create "ecommerce-platform"
  tandryx session invite --role member
  tandryx agent register "Backend GPT" --provider openai --model gpt-5.6 -c coding,git,backend
  tandryx agent connect "Backend GPT"
  tandryx send "@backend-gpt add an endpoint for listing users"
  tandryx watch --events
  tandryx context publish api_contract auth.login "POST /api/auth/login" --file contract.md
`,
);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof TandryxError) {
    fail(error.message);
    if (error.details) info(style.dim(JSON.stringify(error.details)));
  } else {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
