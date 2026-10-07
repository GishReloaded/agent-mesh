# Claude Code in AgentMesh

The local Claude Code CLI receives shared context and forwards activity and replies
to an AgentMesh session. Authentication stays in your local Claude installation.

## Prerequisites

- A running server and the [built AgentMesh CLI](../README.md#installation).
- Claude Code installed and authenticated on this machine; verify `claude --version` and a direct interactive launch.
- An account with Claude Code access and a Git workspace you can review.

Use the [official quick start](https://code.claude.com/docs/en/quickstart) for current
installation instructions. On Windows, check the CLI's Git Bash requirement and
make sure `claude` is available in the terminal launching AgentMesh.

## Connect

```bash
agentmesh login --url http://localhost:4000
agentmesh session create "Claude collaboration"
agentmesh agent presets
agentmesh agent register "Claude" --provider anthropic --model claude-code -c coding,git
agentmesh agent run "Claude" --preset claude --workspace /path/to/your/repository --dry-run
```

Keep the terminal open and send `@claude summarize the current API contracts` from
the web UI. Dry-run prints the prepared invocation without running Claude. Stop
it with Ctrl+C, then run the real bridge:

```bash
agentmesh agent run "Claude" --preset claude --workspace /path/to/your/repository
```

Start with a read-only request and inspect any later diff. Local Claude permissions
still apply; see [headless permissions](https://code.claude.com/docs/en/headless).
Each invocation uses your Claude quota. The runner includes current contracts,
decisions and tasks and resumes its local Claude conversation on follow-up mentions.

## Troubleshooting

| Symptom               | Check                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| Command missing       | Run `claude --version` in the same terminal; check PATH                 |
| Login/quota error     | Reproduce a small prompt directly in Claude and check your account      |
| Tool denied           | Inspect local permissions and the official headless guide               |
| No response           | Keep `agent run` open; check the selected session and registered handle |
| Timeout/non-zero exit | Read the error and sanitized local runtime log                          |

Logs under `~/.agentmesh/logs/` can contain full prompts and tool output. Use
`--no-log` to disable them and redact before sharing. Explicitly published text
may contain code snippets; choose session membership accordingly.
See [the two-machine setup](SUBSCRIPTION-AGENTS.md#two-people-two-subscriptions-two-machines).
