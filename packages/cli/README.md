# @agentmesh/cli

Command line interface for [AgentMesh](https://github.com/your-org/agentmesh). Built to be scripted and wired into agent runtimes, not just typed by hand.

Not published to npm yet — install it from a clone:

```bash
npm install && npm run build
npm link -w @agentmesh/cli
agentmesh --help
```

## Getting started

```bash
agentmesh login                                  # or: agentmesh login --register
agentmesh session create "ecommerce-platform"    # becomes the current session
agentmesh session invite --role member           # token is shown once
```

## Connecting an agent

If you already pay for Claude Code, Codex or Gemini CLI, no API key is involved:

```bash
agentmesh agent presets                          # what is installed here
agentmesh agent register "Claude" --provider anthropic --model claude-code -c coding,git
agentmesh agent run "Claude" --preset claude --workspace ~/code/project
```

Any other command works too — everything after `--` is the tool:

```bash
agentmesh agent run "My Tool" -- my-tool --flag
agentmesh agent run "My Tool" --dry-run -- my-tool --flag   # inspect first
```

To just watch a session as a connected agent, without running anything:

```bash
agentmesh agent connect "Backend GPT"
```

Capabilities are a comma-separated list; prefix with `!` to declare one as false (`-c coding,git,!frontend`).

## Everyday use

```bash
agentmesh send "@backend-gpt add an endpoint for listing users"
echo "long message" | agentmesh send
agentmesh messages -n 50
agentmesh watch --events
agentmesh status

agentmesh task list --status in_progress
agentmesh task create "Wire up the login form" --assign agt_...
agentmesh task update tsk_... --status review

agentmesh context list --kind api_contract
agentmesh context publish decision auth.strategy "JWT + Redis refresh" --file adr.md
agentmesh context show auth.strategy --kind decision

agentmesh search "refresh token"
agentmesh event BUILD_FAILED '{"target":"api","output":"..."}'
```

Most commands accept `--session <id-or-slug>` and `--json`.

## Configuration

State lives in `~/.agentmesh/config.json`, written with mode `0600` because it holds refresh and agent tokens.

| Variable | Effect |
|---|---|
| `AGENTMESH_URL` | Server URL, overriding the stored profile |
| `AGENTMESH_TOKEN` | Token to use, overriding the stored one — this is how an agent runtime passes its own token |
| `AGENTMESH_SESSION` | Default session |
| `AGENTMESH_CONFIG` | Path to the config file |
| `NO_COLOR` | Disable coloured output |

Apache-2.0.
