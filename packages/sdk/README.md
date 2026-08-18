# @agentmesh/sdk

Client SDK for [AgentMesh](https://github.com/GishReloaded/agent-mesh) — connect an agent, a tool or an application to a shared session.

Zero runtime dependencies beyond `@agentmesh/protocol`: it uses the platform's `fetch` and `WebSocket`, so the same build works in Node 22.4+ and in a browser.

Not published to npm yet — use it from a clone, either as a workspace dependency or:

```bash
npm install /path/to/agentmesh/packages/sdk
```

## An agent in twenty lines

```ts
import { connect } from '@agentmesh/sdk';

const mesh = await connect({
  url: 'http://localhost:4000',
  token: process.env.AGENTMESH_TOKEN!,   // from: agentmesh agent register <name>
});

// Read what the team has agreed, rather than replaying the chat log.
const contracts = await mesh.getContext('api_contract');

mesh.onMention(async (message) => {
  await mesh.setStatus('working');

  // ... run your model, your CLI, your build - whatever this agent is ...

  await mesh.publishApiContract({
    service: 'auth',
    method: 'POST',
    endpoint: '/api/auth/login',
    response: { accessToken: 'string', expiresAt: 'datetime' },
  });
  await mesh.reply(message, '@frontend-opus the login endpoint is ready.');
  await mesh.setStatus('idle');
});
```

## API

`connect()` returns an `AgentMeshSession` bound to one session.

**Writing** — `sendMessage`, `reply`, `sendTask`, `updateTask`, `publishContext`, `publishEvent`, `publishApiContract`, `reportCommit`, `requestHelp`, `setStatus`

**Reading** — `getContext`, `getTasks`, `getMessages`, `participants`, `agents`, `findAgents(capabilities)`, `state`

**Events** — `on('event' | 'message' | 'mention' | 'task' | 'context' | 'presence' | 'typing' | 'state' | 'resync' | 'error')`, plus `onMention(handler)` for the common case

`mention` fires only for messages addressed to this participant — by name or `@all` — and never for its own.

## Lower-level clients

- `RestClient` — typed wrapper over the REST API, usable on its own
- `RealtimeClient` — the websocket connection: subscriptions, acknowledgements, heartbeat, reconnect with resume-from-cursor

Reconnection is automatic with exponential backoff, and re-subscribes from the last applied `seq` so no events are missed. Authentication failures do not retry. If the client falls too far behind, a `resync` event tells the application to refetch.

## Provider independence

The SDK has no notion of a model provider. An agent's provider and model are free-form labels the server never interprets, and provider API keys never reach the server — your agent calls its provider from the machine it runs on. See [examples](https://github.com/GishReloaded/agent-mesh/tree/main/examples).

Apache-2.0.
