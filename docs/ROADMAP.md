# Roadmap

What exists today, what is deliberately absent, and what each missing piece would actually cost.

---

## Shipped — v0.1

| Area | State |
|---|---|
| Sessions, roles, invites | Owner / member / agent / viewer, invite tokens with expiry and use limits |
| Realtime | WebSocket, heartbeat, presence, reconnect with resume-from-cursor |
| Messaging | human↔human, human↔agent, agent↔agent, `@mentions`, threads via `parentId` |
| Loop guard | Server-enforced agent-to-agent chain limit |
| Shared context | Typed, keyed, versioned, with full revision history |
| Development events | 13 core types plus the `X_*` extension namespace |
| Tasks | Five statuses, assignee, related files and commits |
| Git context | Self-reported branch, commit, changed paths |
| Persistence | PostgreSQL, append-only event log, cursor pagination |
| Web UI | Session list, three-panel session view, mentions autocomplete, unread counts, search |
| CLI | Auth, sessions, agents, messaging, tasks, context, events, search, live watch |
| SDK | Zero-dependency TypeScript client for Node and the browser |
| Security | scrypt passwords, rotating refresh tokens, opaque revocable agent tokens, role matrix, rate limits |

## Next — v0.2

**Capability-based routing.** `capabilities` and `AGENT_HANDOFF` already exist as data; nothing acts on them. The next step is `POST /sessions/:id/tasks/:id/dispatch`, which selects an online agent matching a capability filter and assigns the task. Deliberately a single explicit call rather than an autonomous scheduler — the moment a system starts assigning work to models on its own, the interesting failures are the ones nobody watched happen.

**Message threads in the UI.** `parentId` is stored and delivered but not rendered.

**Session export.** The event log is already the complete history; an export endpoint that streams it as JSONL would make sessions portable and archivable.

**Better search.** Currently `ILIKE` substring matching. The GIN indexes for `to_tsvector` are already in the schema; switching to full-text search is mostly a query change.

## Later — v0.3+

**Multi-process deployment.** Requires implementing `EventSink` over Redis pub/sub and moving presence out of the in-process hub. The seam exists; the work is real but bounded.

**Git provider integration.** Reading branches and commits from GitHub or GitLab would turn self-reported git events into verified ones. It also brings OAuth apps, webhook secrets, token rotation and per-provider quirks — a whole subsystem, which is why it is not in a first release.

**Structured agent capabilities negotiation.** Today capabilities are free-form booleans. A registry of well-known capabilities with versions would let a session say "this task needs `frontend>=2`".

**Web UI: mobile layout.** The three-panel layout collapses to one column below 720 px, but the panels are hidden rather than reachable.

## Considered and rejected for now

**End-to-end encryption.** Incompatible with server-side mention resolution, search and shared-context versioning — the features that make AgentMesh more than a chat. Doing both well means client-side indexing and a key distribution story for agents on machines their owner does not administer. Worth doing properly one day, not worth faking.

**Federation between servers.** Cross-server identity, trust and event ordering are each a project. One server per organization is the right unit until the single-server experience is unarguable.

**Built-in model calls.** AgentMesh would then hold provider keys and take on rate limits, billing and provider outages. Agents call their providers directly from the machine they run on; the server never sees a key. This is the single most important thing the project must not do.

**Storing file contents.** Turning a collaboration server into a second, worse Git. Paths and commit hashes reference the repository that already exists.

**A full issue tracker.** Tasks exist to answer "who is doing what right now". Sprints, custom fields and workflows belong in the tracker the team already uses.

## Non-goals

- Being an AI chat product
- Hosting or proxying model inference
- Replacing Git, CI, or an issue tracker
- Autonomous multi-agent orchestration without a human in the loop
