# Changelog

## 0.2.0 — 2026-10-07

- Rename the project, GitHub repository, interface, documentation and visual assets to Tandryx.
- Publish `@gish_reloaded/tandryx-protocol`, `@gish_reloaded/tandryx-sdk` and `@gish_reloaded/tandryx-cli`; the installed command is `tandryx`.
- Use `tandryx/v1` frames, `TandryxError`, `TandryxSession`, `TANDRYX_*` environment variables and `.tandryx` CLI configuration.
- Update browser storage keys, token issuer/audience, Docker resources and AWS deployment templates consistently.

Upgrade the server, web client, SDK and CLI together. Sign in again after upgrading;
existing tokens and saved browser/CLI authentication use a different namespace.
Existing database contents and uploaded avatars do not need a schema migration.
Keep connection strings and deployment resource identifiers pointed at existing
resources until those resources have been migrated; changing a template alone
does not rename a running database, Docker volume or AWS stack.

## 0.1.0 — 2026-10-07

First public release of Tandryx. This is an early version intended for local
evaluation, small self-hosted teams and integration feedback.

- Shared sessions with membership roles, invitations and revocable agent tokens.
- REST and WebSocket protocol with an ordered PostgreSQL event log and cursor-based replay.
- Versioned context for API contracts, decisions and project state; lightweight tasks and development events.
- TypeScript protocol package, SDK, CLI and React web client.
- Local Claude Code, Codex App Server and Gemini CLI adapters using each developer's own login.
- Codex activity, approval controls and context information in the shared session UI.
- Participant colours and uploaded avatars.
- Docker setup, self-hosting documentation, AWS deployment examples and CI.
- Repeatable scripted demo, integration guides and isolated package-install verification.
- Align fresh Node setup with Docker database credentials and preserve existing configuration on reruns.
- Update dependencies flagged by npm audit, including static serving, query builder, routing and development-tool dependencies.
- Reset realtime state on account changes, ignore stale auth refreshes and return to pending invites after sign-in.

### Distribution

The original GitHub release is retained as a historical archive. Current npm
package names and installation instructions are in the 0.2.0 release notes.
The server and web client are distributed as source and through the documented
Docker build.

### Current limits

- No MCP server, automatic capability-based task dispatch or Git provider synchronization.
- No hosted inference; model access and limits come from the local coding tool.
- Mobile task/context navigation and message-thread rendering need further work.
- Provider adapters depend on the locally installed CLI and its supported interface.
- Shared messages, context and events are visible to session members; keep secrets out of them.
