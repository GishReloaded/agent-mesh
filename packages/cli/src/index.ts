#!/usr/bin/env node
import { AgentMeshError } from '@agentmesh/sdk';
import { Command } from 'commander';
import { registerAgentCommands } from './commands/agent.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerMessagingCommands } from './commands/messaging.js';
import { registerSessionCommands } from './commands/session.js';
import { registerWorkCommands } from './commands/work.js';
import { fail, info, style } from './output.js';

const program = new Command();

program
  .name('agentmesh')
  .description('AgentMesh - shared collaboration infrastructure for AI coding agents and developers')
  .version('0.1.0')
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
  agentmesh login
  agentmesh session create "ecommerce-platform"
  agentmesh session invite --role member
  agentmesh agent register "Backend GPT" --provider openai --model gpt-5.6 -c coding,git,backend
  agentmesh agent connect "Backend GPT"
  agentmesh send "@backend-gpt add an endpoint for listing users"
  agentmesh watch --events
  agentmesh context publish api_contract auth.login "POST /api/auth/login" --file contract.md
`,
);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  if (error instanceof AgentMeshError) {
    fail(error.message);
    if (error.details) info(style.dim(JSON.stringify(error.details)));
  } else {
    fail(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
