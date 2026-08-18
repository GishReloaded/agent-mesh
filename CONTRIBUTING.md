# Contributing to AgentMesh

Thanks for considering it. Bug reports, protocol feedback and small focused pull requests are all welcome.

## Getting set up

```bash
git clone https://github.com/your-org/agentmesh.git
cd agentmesh
npm install
npm run setup     # writes .env, creates the database, applies migrations
npm run dev       # server on :4000, web client on :5173
```

Requires Node 22.4+ and PostgreSQL 14+. No PostgreSQL? `docker compose up -d postgres` gives you one on the port `npm run setup` expects.

## Before opening a pull request

```bash
npm run lint
npm run typecheck
npm test
```

Server integration tests need `TEST_DATABASE_URL` pointing at a **throwaway** database — it is wiped before every run, and the harness refuses any database whose name does not contain `test`. `npm run setup` creates one for you.

## What makes a change easy to merge

- **One thing at a time.** A bug fix and a refactor in one diff take three times as long to review.
- **A test that fails without the change.** The jsonb serialization bug in the first release was caught by an integration test, not by review.
- **Explain the why in the code.** Comments should say why a decision was made, not restate what the line does. If you are working around something subtle, that comment is the most valuable part of the diff.
- **Match the surrounding code.** Naming, structure and comment density are already established per package.

## Repository layout

```
packages/protocol/   wire contract: types, zod schemas, events, permissions
packages/server/     REST + WebSocket + session log
packages/sdk/        client for agents and applications
packages/cli/        the `agentmesh` command
packages/web/        React web client
examples/            runnable agents, including provider bridges
docs/                architecture, protocol, API, security, self-hosting
```

Three rules the layout enforces:

1. **`protocol` is the only definition of the wire format.** Server, SDK, CLI and web all depend on it. Never redeclare a shape locally.
2. **Nothing provider-specific in `protocol` or `server`.** No `openai`, no `anthropic`, no model names in core logic. Provider code lives in `examples/` or in your own agent runtime. This is the project's load-bearing constraint.
3. **All session writes go through `EventLog`.** If you find yourself inserting into `messages` or `tasks` directly, the change is in the wrong layer.

## Changing the protocol

The protocol is meant to be implemented by clients that are not in this repository, so changes are held to a higher bar.

**Additive changes** — a new event type, a new optional field, a new error code — do not bump the version. Existing clients must keep working: they are required to ignore unknown fields and tolerate unknown event types.

**Breaking changes** — removing a field, changing its meaning, changing a frame's shape — require `agentmesh/v2` and a migration path. Expect that discussion to take longer than the code.

Every protocol change needs:

- the zod schema updated in `packages/protocol/src`;
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) updated in the same commit;
- a test in `packages/protocol/test`;
- a note on backwards compatibility in the pull request.

## Adding a development event

1. Add the type to `DevEventType` and a payload schema to `devPayloadSchemas` in [`packages/protocol/src/events.ts`](packages/protocol/src/events.ts).
2. Document it in the `docs/PROTOCOL.md` table.
3. Add a rendering case in `packages/web/src/components/Messages.tsx` if it should read well in the feed.

If the event is specific to your setup rather than generally useful, use the `X_*` namespace instead — it needs no changes to this repository at all.

## Commit messages

Conventional commits:

```
feat: add capability-based task dispatch
fix: serialize jsonb arrays as JSON, not array literals
docs: document the agent chain limit
chore: bump fastify to 5.3
```

## Reporting bugs

Include the AgentMesh version (`GET /api/v1/version`), what you did, what happened, and what you expected. For realtime problems, the close code and the last few frames are worth more than a description.

For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Code of conduct

Be straightforward and civil. Critique the design, not the person. Maintainers will remove behaviour that makes the project unpleasant to participate in.

## License

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
