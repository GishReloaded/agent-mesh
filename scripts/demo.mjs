#!/usr/bin/env node
/** Deterministic SDK demo: no model calls and no source-file changes. */
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { RestClient, connect } from '@gish_reloaded/tandryx-sdk';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:4000' },
    play: { type: 'boolean', default: false },
    'allow-remote': { type: 'boolean', default: false },
  },
});
const url = new URL(values.url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !values['allow-remote']) {
  throw new Error('Demo creates sample data. Use a local server or explicitly pass --allow-remote.');
}
const rest = new RestClient({ url: url.origin });
await rest.version();
const email = `demo-${Date.now()}-${randomBytes(3).toString('hex')}@example.test`;
const password = randomBytes(18).toString('base64url');
const tokens = await rest.register({ email, password, displayName: 'Demo Developer' });
rest.setToken(tokens.accessToken);
const session = await rest.createSession({
  name: 'Tandryx · shared API contract',
  description: 'Scripted SDK demo. No model calls or file changes.',
});
const backend = await rest.registerAgent(session.id, {
  name: 'Backend Demo',
  provider: 'demo',
  model: 'scripted',
  autonomy: 'semi',
  capabilities: { backend: true },
});
const frontend = await rest.registerAgent(session.id, {
  name: 'Frontend Demo',
  provider: 'demo',
  model: 'scripted',
  autonomy: 'semi',
  capabilities: { frontend: true },
});
const task = await rest.createTask(session.id, {
  title: 'Read the login contract and prepare the UI handoff',
  description: 'A scripted demonstration; no application files are modified.',
  assignee: { type: 'agent', id: frontend.agent.id },
});
await rest.publishContext(session.id, {
  kind: 'project',
  key: 'demo.scope',
  title: 'How this demo works',
  body: 'Two deterministic local SDK agents share an API contract and move a task to review. Connect a real coding CLI for implementation.',
  data: { scripted: true, modelCalls: false, editsFiles: false },
});
const sessions = [];
try {
  const back = await connect({ url: url.origin, token: backend.token });
  sessions.push(back);
  const front = await connect({ url: url.origin, token: frontend.token });
  sessions.push(front);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let running = false;
  back.onMention((message) => {
    if (message.author.type !== 'user' || running) return;
    running = true;
    void (async () => {
      try {
        await back.setStatus('working', 'Publishing the shared API contract');
        await pause(900);
        await back.publishApiContract({
          service: 'auth',
          method: 'POST',
          endpoint: '/api/auth/login',
          request: { email: 'string', password: 'string' },
          response: { accessToken: 'string', expiresAt: 'ISO-8601 string' },
          note: 'Demo contract only; no endpoint has been implemented by this scripted agent.',
        });
        await back.sendMessage(
          '@frontend-demo The login contract is published. Read it from shared context and prepare the handoff.',
        );
        await back.setStatus('idle');
      } catch (error) {
        console.error(error);
        await back.setStatus('blocked', 'Demo failed').catch(() => undefined);
      } finally {
        running = false;
      }
    })();
  });
  front.onMention((message) => {
    if (message.author.id !== backend.agent.id) return;
    void (async () => {
      try {
        await front.setStatus('working', 'Reading the shared contract');
        await front.updateTask(task.id, { status: 'in_progress' });
        await pause(1400);
        const contracts = await front.getContext('api_contract');
        const contract = contracts.find((entry) => entry.data.endpoint === '/api/auth/login');
        if (!contract) throw new Error('Shared login contract was not delivered');
        await front.sendMessage(
          `Read contract v${contract.version}: POST /api/auth/login returns accessToken and expiresAt. The demo handoff is ready for human review; no files were changed.`,
        );
        await front.updateTask(task.id, { status: 'review' });
        await front.setStatus('idle');
        console.log('Demo complete: second agent read the contract; task moved to review.');
      } catch (error) {
        console.error(error);
        await front.setStatus('blocked', 'Demo failed').catch(() => undefined);
      }
    })();
  });
  await rest.sendMessage(session.id, {
    body: 'Welcome! Backend Demo and Frontend Demo are scripted SDK agents. Send “@backend-demo publish the login contract” to try a handoff without calling a model.',
  });
  console.log(
    `\nOpen ${url.origin}/s/${session.id}\nLocal sample account:\nEmail: ${email}\nPassword: ${password}\n\nSend: @backend-demo publish the login contract\nKeep this terminal open. Ctrl+C disconnects the demo agents.\n`,
  );
  if (values.play) await rest.sendMessage(session.id, { body: '@backend-demo publish the login contract' });
  const stop = () => {
    sessions.forEach((mesh) => mesh.close());
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  sessions.forEach((mesh) => mesh.close());
  throw error;
}
