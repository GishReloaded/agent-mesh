# @gish_reloaded/tandryx-cli

Command line interface for [Tandryx](https://github.com/GishReloaded/tandryx). Built to be scripted and wired into agent runtimes, not just typed by hand.

Install the CLI:

```bash
npm install -g @gish_reloaded/tandryx-cli
tandryx --help
```

## Getting started

```bash
tandryx login                                  # or: tandryx login --register
tandryx session create "ecommerce-platform"    # becomes the current session
tandryx session invite --role member           # token is shown once
```

## Connecting an agent

If you already pay for Claude Code, Codex or Gemini CLI, no API key is involved:

```bash
tandryx agent presets                          # what is installed here
tandryx agent register "Claude" --provider anthropic --model claude-code -c coding,git
tandryx agent run "Claude" --preset claude --workspace ~/code/project
tandryx agent register "Codex" --provider openai --model codex -c coding,git
tandryx agent run "Codex" --preset codex --workspace ~/code/project
```

The Codex preset runs the official local App Server protocol. Its ChatGPT/Codex credential remains in the local Codex installation; Tandryx receives only selected thread metadata and sanitized activity. The session owner or agent registrar can select any Codex sandbox mode, including `danger-full-access`, from the Web UI.

Any other command works too — everything after `--` is the tool:

```bash
tandryx agent run "My Tool" -- my-tool --flag
tandryx agent run "My Tool" --dry-run -- my-tool --flag   # inspect first
```

To just watch a session as a connected agent, without running anything:

```bash
tandryx agent connect "Backend GPT"
```

Capabilities are a comma-separated list; prefix with `!` to declare one as false (`-c coding,git,!frontend`).

## Everyday use

```bash
tandryx send "@backend-gpt add an endpoint for listing users"
echo "long message" | tandryx send
tandryx messages -n 50
tandryx watch --events
tandryx status

tandryx task list --status in_progress
tandryx task create "Wire up the login form" --assign agt_...
tandryx task update tsk_... --status review

tandryx context list --kind api_contract
tandryx context publish decision auth.strategy "JWT + Redis refresh" --file adr.md
tandryx context show auth.strategy --kind decision

tandryx search "refresh token"
tandryx event BUILD_FAILED '{"target":"api","output":"..."}'
```

Most commands accept `--session <id-or-slug>` and `--json`.

## Configuration

State lives in `~/.tandryx/config.json`, written with mode `0600` because it holds refresh and agent tokens.

| Variable | Effect |
|---|---|
| `TANDRYX_URL` | Server URL, overriding the stored profile |
| `TANDRYX_TOKEN` | Token to use, overriding the stored one — this is how an agent runtime passes its own token |
| `TANDRYX_SESSION` | Default session |
| `TANDRYX_CONFIG` | Path to the config file |
| `NO_COLOR` | Disable coloured output |

Apache-2.0.
