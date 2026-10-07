# Gemini CLI in Tandryx

The preset runs your local Gemini CLI in prompt mode. Authentication and quota
belong to that local installation.

Follow [official Gemini CLI docs](https://geminicli.com/docs/), authenticate, and
check `gemini --version` / `gemini --help`. This preset expects `--prompt` support.
Try a small prompt directly before connecting Tandryx.

```bash
tandryx login --url http://localhost:4000
tandryx session create "Gemini collaboration"
tandryx agent register "Gemini" --provider google --model gemini -c coding,git
tandryx agent run "Gemini" --preset gemini --workspace /path/to/your/repository --dry-run
```

Send `@gemini summarize the project context` from the web UI to inspect the prepared
prompt. Stop dry-run with Ctrl+C, then launch:

```bash
tandryx agent run "Gemini" --preset gemini --workspace /path/to/your/repository
```

The terminal must stay open. The shared brief is supplied on each invocation;
this preset does not use Codex's persistent controls or Claude's streaming parser.
Start read-only and keep the local tool's permissions appropriate to the workspace.

For a missing executable, check PATH. For login, quota or permission errors,
reproduce the prompt in Gemini directly. If flags differ, inspect
`tandryx agent run --help` and use a custom command. Redact logs before sharing.
See [subscription-backed agents](SUBSCRIPTION-AGENTS.md) for queues and two-machine setup.
