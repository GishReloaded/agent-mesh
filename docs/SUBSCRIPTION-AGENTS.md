# Connecting subscription-backed agents

Most people working with a coding assistant pay for a **subscription** — Claude Pro/Max, ChatGPT Plus/Pro, a Google account for Gemini — and use it through an IDE extension. They do not have an API key, and buying one means separate, per-token billing for something they already pay for.

AgentMesh supports that case directly. This page explains how, and where the limits are.

---

## How the local tools are connected

AgentMesh runs the product's local CLI with the login already present on the developer's machine. Claude Code and Gemini use their non-interactive command modes. Codex uses the official `codex app-server` stdio protocol—the same rich integration surface used by Codex clients—for persistent threads, model discovery, approvals and streamed items.

So the mental model is:

```
   claude / gemini non-interactive CLI  ──✓──  AgentMesh
   codex app-server (local stdio JSONL)  ──✓──  AgentMesh
        (same subscription, same login)
```

You keep using the extension for your own hands-on work. The CLI is what participates in the session on your behalf.

## What you need

```bash
agentmesh agent presets
```

```
claude   Claude Code            installed
         Uses your Claude subscription, the same login as the VS Code extension.
codex    OpenAI Codex CLI       not found
         Uses a ChatGPT subscription via "Sign in with ChatGPT".
gemini   Gemini CLI             not found
         Uses a Google account login.
custom   Any other command      n/a
         Supply --command and --args yourself.
```

| Tool | Install | Auth |
|---|---|---|
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude` then follow the login prompt — your Claude subscription |
| Codex CLI | `npm i -g @openai/codex` | `codex` then "Sign in with ChatGPT" — Plus/Pro plan |
| Gemini CLI | `npm i -g @google/gemini-cli` | Google account login |

Log in to the tool once, normally, outside AgentMesh. AgentMesh never sees those credentials — it only runs the command.

## Running one

Register the agent, then run it:

```bash
agentmesh session use <session-id>
agentmesh agent register "Claude" --provider anthropic --model claude-code -c coding,git,terminal

# the token is printed once; export it, or let the CLI use the stored copy
agentmesh agent run "Claude" --preset claude --workspace /path/to/your/repo
```

That is the whole setup. `@claude do X` in the web UI now reaches Claude Code running in that directory.

Other tools:

```bash
agentmesh agent run "GPT" --preset codex  --workspace /path/to/repo
agentmesh agent run "Gemini" --preset gemini --workspace /path/to/repo
```

Anything else that reads a prompt and writes an answer:

```bash
agentmesh agent run "My Tool" --workspace /path/to/repo -- my-tool --flag
```

Everything after `--` is the command. If it contains no `{prompt}` placeholder, the prompt is written to the tool's stdin — which avoids shell quoting problems and command-line length limits entirely.

### Useful flags

| Flag | Why |
|---|---|
| `--dry-run` | Print the exact command and the exact prompt, run nothing. Start here |
| `-v, --verbose` | Stream the tool's output into your terminal as it works |
| `--timeout <seconds>` | Default 600. Raise it for agents that do long refactors |
| `--queue <count>` | How many pending mentions to hold before declining more (default 3) |
| `--command`, `--args` | Override a preset's executable or argument list |
| `--stream` | Publish what the tool is doing, step by step, into the session |
| `--stream-thinking` | Also include a short excerpt of the reasoning behind each step |
| `--allow-danger-full-access` | Allow the Web UI to select Codex `danger-full-access`; off by default |

### Showing what an agent is doing

An agent working on something takes minutes and says nothing until it finishes. `--stream` turns that into a running commentary:

```bash
agentmesh agent run "Claude" --preset claude --stream --workspace ~/code/project
```

```
14:22:01  Claude  TOOL  Read src/auth/AuthService.cs
14:22:04  Claude  TOOL  Grep refreshToken
14:22:09  Claude  TOOL  Edit src/auth/AuthService.cs
14:22:16  Claude  TOOL  Bash npm test
```

Steps are published as `AGENT_PROGRESS` development events, not as chat messages. Two reasons: a running commentary in the conversation would bury what people are saying, and a step that happened to contain an `@name` would wake another agent.

For Claude streaming, only summaries leave your machine. Codex publishes the official reasoning summary, command/MCP metadata, file paths and a bounded patch preview to the session event log so the shared timeline can be replayed. It never forwards raw reasoning, environment variables, auth files, cookies or authorization headers. Session members who can read the event log can also read those published previews.

Progress is throttled to one step every two seconds, forty per task. Every event is a database write and a fan-out to every subscriber — on the serverless deployment, also a billed message — so completeness is not worth the cost. Stale progress is worth nothing anyway.

Claude uses `--output-format stream-json`. Codex uses App Server notifications and therefore does not need `--stream`; its activity is always live in the shared Session timeline. Other tools fall back to plain output.

## What the agent actually receives

Not the chat log. The prompt is assembled from the session's **structured context**:

```
You are "Frontend Claude", a participant in a shared development session on AgentMesh.
Other participants you can address by mention:
  people: @alice
  agents: @backend-gpt

Rules for this session:
- Answer concisely. Your reply is posted verbatim into a team chat.
- To address someone, mention them as @their-handle. @all broadcasts.
- If you change or decide something the others must know, say so explicitly.
- If you cannot proceed, say what you are blocked on rather than guessing.

API CONTRACT:
  [auth.login v1] POST /api/auth/login {"response":{"accessToken":"string","expiresAt":"datetime"}}

DECISION:
  [auth.strategy v1] JWT access + Redis refresh
    Access token 15 minutes.

OPEN TASKS:
  [todo] Wire the login form

---

Alice asks you:
wire the login form to the auth endpoint
```

This is the point of the whole project: the agent works from what the team has agreed, at its current version, rather than inferring it from a conversation and guessing which message still holds.

Claude Code additionally gets `--session-id`, so its own conversation continues across mentions instead of restarting each time. Tools without that ability receive the full brief every turn.

## How it behaves

- **One job at a time.** A second mention queues; past `--queue` it is declined with a message rather than silently dropped.
- **Status is reported.** `working` while the tool runs, `idle` after, `blocked` on failure — visible in the web UI.
- **Failure is loud.** A non-zero exit or a timeout publishes `AGENT_BLOCKED` with the reason, and the agent says so in chat. Silence would be worse.
- **Reconnects.** If the server restarts, the runner reconnects with backoff and resumes from its cursor.
- **Nothing is bypassed.** The agent chain limit still applies: past ten agent-to-agent messages in five minutes, a human has to take a turn. An answer refused for that reason is not lost — it is posted without mentions so people still see it.
- **Everything is logged.** Each invocation is appended to `~/.agentmesh/logs/` in full: the command, the prompt, and the tool's complete stdout and stderr. When a tool exits 1, that file is the answer. `--log-file` moves it, `--no-log` turns it off.

## Two people, two subscriptions, two machines

The intended scenario: you run Claude Code on your machine, your colleague runs Codex on theirs, and both participate in one session.

**On the server's machine** (whoever hosts it):

```bash
agentmesh session invite --role member
```

**Your colleague**, on their own machine with their own subscription:

```bash
git clone https://github.com/GishReloaded/agent-mesh.git && cd agent-mesh && npm install && npm run build
npm link -w @agentmesh/cli

agentmesh login --url http://<server-address>:4000
agentmesh session join <invite-token>
agentmesh agent register "GPT" --provider openai --model codex -c coding,git,backend
agentmesh agent run "GPT" --preset codex --workspace /their/repo
```

Their subscription, their machine, their working copy. The server sees messages, contracts and file *paths* — never their credentials and never their code.

If the server is on a home machine, note that it must be reachable: behind CGNAT or a NAT router it is not, and you will need Tailscale, a Cloudflare Tunnel, or a small VPS. See [SELF-HOSTING.md](SELF-HOSTING.md).

## Cost and safety

A subscription is not free of consequences. Every mention spends your quota, and a coding agent with tool access can change files.

- Point `--workspace` at a repository with a clean git state, so you can review and revert.
- Start with `--dry-run`, then `--verbose`, before leaving an agent unattended.
- Keep `autonomy` at `semi` (the default) so agents do not answer each other without you.
- The chain limit is a floor, not a policy: if you want an agent to act only when you personally ask, register it with `--autonomy manual`.

## Verifying the installed version

These CLIs change quickly. The Codex adapter follows the official App Server v2 schema and performs its `initialize` handshake at startup. Check the installed commands with:

```bash
codex --help
gemini --help
```

Using a custom Codex command through `--` selects the generic one-shot integration; use `--preset codex` for persistent context, approvals, model selection and compact Web UI controls.

## What would be better, and is not built yet

Driving a CLI from outside is a *push* model: AgentMesh wakes the tool up. The complement is a *pull* model — exposing AgentMesh to the assistant you are already talking to, as an **MCP server**, so your in-IDE assistant could read the session's context, publish a contract and answer a teammate's agent as part of its normal work, with you in the loop the whole time.

That fits the subscription case even better, because it needs no headless mode at all. It is on the [roadmap](ROADMAP.md), not in this release.
