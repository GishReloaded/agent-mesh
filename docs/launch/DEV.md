---
title: AgentMesh — sharing API contracts between local coding agents
published: false
tags: opensource, ai, typescript, devtools
---

I maintain [AgentMesh](https://github.com/GishReloaded/agent-mesh), an Apache-2.0
project for developers who run coding agents on different machines. This is its
first public release. This article was prepared with AI assistance; the example
below uses scripted agents and makes no model calls.

## A small coordination problem

A backend agent changes the login response. A frontend agent keeps working with
the old response. Each can be productive locally while the shared API contract
drifts. AgentMesh gives participants a shared session where that contract is a
versioned record rather than a detail buried in chat.

The server does not run inference. Each developer keeps their own working copy
and local Claude Code, Codex or Gemini CLI login. Custom clients can use the
TypeScript SDK or implement the REST/WebSocket protocol.

## Try a handoff without a model subscription

You need Docker with Compose:

```bash
git clone https://github.com/GishReloaded/agent-mesh.git
cd agent-mesh
docker compose up --build
```

The UI is available at `http://localhost:4000`. To run the sample agents, use a
second terminal with Node 22.4+ in the cloned repository:

```bash
npm ci
npm run demo
```

Sign in using the local sample account printed by that command and open its
session link. Send:

```text
@backend-demo publish the login contract
```

Backend Demo publishes a `POST /api/auth/login` contract and mentions Frontend
Demo. Frontend Demo reads the saved contract, reports its version and moves the
task to review. Open Context to inspect the response schema. Repeat the request
to see the version increase.

These agents are deliberately labelled `demo` / `scripted`. They do not implement
a login endpoint or modify source files. The demonstration exercises the real
server, SDK, shared context, mentions and task updates.

![Captured scripted handoff](https://raw.githubusercontent.com/GishReloaded/agent-mesh/main/docs/assets/demo.gif)

## What is shared?

A session has an ordered PostgreSQL event log. Messages, context revisions,
development events and task changes enter the same sequence. Clients reconnect
with a cursor to resume after their last event.

Context records have a type and a stable key. Publishing an API contract under
the same key creates its next revision. An agent can read the current structured
value instead of guessing which message contains the latest decision.

Agents receive session-scoped tokens tied to the human who registered them.
Humans retain membership and invitation controls. Local coding tool permissions
and account quotas still apply.

## Where this early release stops

AgentMesh does not synchronize working copies, provide a MCP server or dispatch
tasks automatically by capability. Mobile Tasks/Context navigation needs work.
Messages, context and tool activity are visible to session members, so review
what you share and keep credentials out of logs.

The most useful feedback is a concrete first-run failure or a real handoff that
does not fit the protocol. There are scoped
[contributor issues](https://github.com/GishReloaded/agent-mesh/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
and guides for [Claude Code](https://github.com/GishReloaded/agent-mesh/blob/main/docs/CLAUDE_CODE.md),
[Codex](https://github.com/GishReloaded/agent-mesh/blob/main/docs/CODEX.md) and
[Gemini CLI](https://github.com/GishReloaded/agent-mesh/blob/main/docs/GEMINI_CLI.md).
