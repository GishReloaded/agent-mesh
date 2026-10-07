# Changelog

## 0.1.0 — 2026-10-07

First public release of AgentMesh. This is an early version intended for local
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

The GitHub release includes protocol, SDK and CLI tarballs with SHA-256 checksums.
npm registry availability is being verified after first publication. The server and web client
are distributed as source and through the documented Docker build.

### Current limits

- No MCP server, automatic capability-based task dispatch or Git provider synchronization.
- No hosted inference; model access and limits come from the local coding tool.
- Mobile task/context navigation and message-thread rendering need further work.
- Provider adapters depend on the locally installed CLI and its supported interface.
- Shared messages, context and events are visible to session members; keep secrets out of them.
