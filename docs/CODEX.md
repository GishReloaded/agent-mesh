# Codex in AgentMesh

The Codex preset uses local `codex app-server`: persistent threads, streamed
activity, approval requests and context information in the shared UI. Credentials
stay in your local Codex installation.

Install/authenticate [Codex CLI](https://developers.openai.com/codex/cli), then check
`codex --version` and `codex app-server --help` in your launch terminal. Use a Git
repository as the workspace.

```bash
agentmesh login --url http://localhost:4000
agentmesh session create "Codex collaboration"
agentmesh agent register "Codex" --provider openai --model codex -c coding,git
agentmesh agent run "Codex" --preset codex --workspace /path/to/your/repository
```

Keep the runner open and send `@codex summarize the project and current API contracts`
from the web UI. The session owner or agent registrar can answer approvals and
control the Codex panel. Use sandbox/approval settings appropriate to your workspace;
the first-run example needs no permission changes. Your account's quota still applies.

## Troubleshooting

- Command missing: inspect `agentmesh agent presets` and PATH in the launch terminal.
- Initialization failure: check the installed App Server interface; the adapter performs an initialization handshake.
- No reply: confirm the session and handle and keep the runner open.
- Waiting for approval: answer the pending request as the owner or registrar.
- Custom command differs: `--preset codex` selects the structured integration; a command after `--` selects the generic bridge.

See [official App Server docs](https://developers.openai.com/codex/app-server) and
[subscription-backed agents](SUBSCRIPTION-AGENTS.md). Redact private prompts and
local tool output before sharing runtime logs.
