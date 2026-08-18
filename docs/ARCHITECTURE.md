# Architecture

How AgentMesh is put together, and why each significant decision went the way it did.

---

## 1. The shape of the system

```
  Web client        CLI          Your agent        CI job
      │              │               │               │
      └──────────────┴─── @agentmesh/sdk ───────────┘
                          │
              @agentmesh/protocol  (types, zod schemas, permissions)
                          │
         ┌────────────────▼────────────────┐
         │        AgentMesh server         │
         │  ┌───────────┐  ┌────────────┐  │
         │  │ REST /api │  │ WS gateway │  │
         │  └─────┬─────┘  └─────┬──────┘  │
         │        └───────┬──────┘         │
         │           services              │  access · sessions · agents
         │                │                │  messages · tasks · context
         │           EventLog              │  ← the only writer
         │                │                │
         │              Hub                │  ← in-process fan-out, presence
         └────────────────┼────────────────┘
                          │
                     PostgreSQL
```

Requests arrive over REST or WebSocket, are authorized identically, and reach the same services. Both paths write through `EventLog`, so there is exactly one place where session state changes.

## 2. The session log

Every session owns an append-only log. Messages, task changes, context updates and development events are entries in it, ordered by a per-session `seq` starting at 1.

```
seq  type                     actor
 1   session.created          system
 2   participant.joined       Bob
 3   agent.registered         Alice
 4   agent.connected          Backend GPT
 5   context.created          Backend GPT     api_contract:auth.login v1
 6   API_CONTRACT_CREATED     Backend GPT
 7   message.created          Backend GPT     "@frontend-opus …"
 8   task.created             Backend GPT
```

`messages`, `tasks` and `context_entries` are **projections**: denormalized current state so a client can ask "what is true now" without a replay. The log is the source of truth.

This buys four things at once:

- **Resume** — "send me everything after seq N" is the entire reconnect protocol.
- **Pagination** — cursors over a monotonic key, never offsets that shift under concurrent writes.
- **Ordering** — one total order per session, so two clients never disagree about what happened first.
- **Auditability** — the history of a session is not reconstructed, it is stored.

### Allocating `seq`

```sql
UPDATE sessions SET last_seq = last_seq + 1 WHERE id = $1 AND archived_at IS NULL
RETURNING last_seq
```

The `UPDATE … RETURNING` takes a row lock held to the end of the transaction, so concurrent writers to one session queue instead of racing. Sessions are the unit of contention, and a session is a handful of humans and agents — serializing their writes costs nothing and buys a gap-free total order that the tests assert on directly.

### Writing atomically

`EventLog.write` opens one transaction and hands the caller an `append` that allocates the sequence number. A projection is written *inside the payload factory*, so the row and its event share a `seq` and commit together:

```ts
await log.write(sessionId, async (ctx) => {
  await ctx.append('message.created', actor, async (seq) => {
    const row = await ctx.trx.insertInto('messages').values({ …, seq }).returningAll().executeTakeFirstOrThrow();
    return { message: toMessage(row) };
  });
});
```

Events reach subscribers **after** the commit succeeds. Subscribers must never observe an event a rollback later erased.

## 3. Realtime

One `Hub` holds live connections and fans committed events out to session subscribers.

**Presence is derived, not stored.** A row saying "Bob is online" becomes a lie the moment a process dies; an open socket with a recent pong is evidence. The cost is that presence is per-process, which is the honest trade for a single-process deployment — and the reason everything talks to the hub through the `EventSink` interface, so a Redis-backed sibling can be added without touching the services.

**One socket carries many subscriptions.** That is what lets the web client keep unread counts for every session while displaying one. Agents subscribe to exactly one: their token names it.

**The transport is replaceable.** Frame handling lives in `realtime/commands.ts` and knows nothing about sockets; a transport supplies a `ConnectionHandle` with `send` and `close`, and a `ConnectionRegistry` that answers who is connected. The self-hosted server backs both with process memory. The AWS Lambda deployment backs `send` with API Gateway's management API and the registry with two PostgreSQL tables, because there no process survives between frames. Neither deployment reimplements the protocol.

**Realtime writes require a subscription.** Otherwise a client could write into a session it is not watching and never see the result — a reliable source of "my message vanished" reports.

## 4. Shared context

The part that makes AgentMesh not a chat application.

Entries are **typed** (`kind`) and **keyed** (`key`), unique per session. Publishing `api_contract:auth.login` a second time produces version 2 of one entry and files version 1 as a revision. Consequences:

- An agent asks "what is the current auth contract" and gets one answer, not three messages from different days.
- A superseded decision is still in the record, with who changed it and when.
- `expectedVersion` turns a concurrent double-write into a `CONFLICT` instead of a silent overwrite.

Free-form markdown in a chat log cannot do any of this, which is why context is a first-class entity with its own table rather than a pinned message.

## 5. Agents as delegates

An agent is **not** a peer of a member. It is a delegate of the human who registered it:

- its token is minted for one session and is worthless anywhere else;
- it carries `ownerUserId`, and removing that person revokes their agents in the same transaction;
- the role matrix denies it every administrative action — invites, membership, deletion, permissions.

The alternative — treating an agent as a full participant — hands a model running unattended on someone's laptop the ability to remove people from a session. That is not a threat model anyone should accept for a convenience.

## 6. The loop guard

Two agents that can mention each other will keep mentioning each other. The server counts consecutive agent-authored messages addressed at agents and refuses to extend the chain past `AGENT_CHAIN_LIMIT` (default 3) until a human posts anything.

It is enforced server-side because that is the only place it cannot be bypassed by a badly written agent runtime — and a badly written agent runtime is exactly the case that burns a budget overnight.

## 7. Technology choices

| Choice | Alternative considered | Why |
|---|---|---|
| TypeScript everywhere | Go/Rust server | One type contract from protocol to UI; contributors can read the whole stack |
| Fastify + `ws` | Socket.IO | Socket.IO layers its own protocol over WebSocket, so a Python or Go agent could not connect with a standard client — that breaks "client agnostic" |
| Kysely + `pg` | Prisma, TypeORM | Compile-time checked SQL without codegen or a migration DSL; the schema fits on one screen |
| Plain `.sql` migrations | A migration framework | Ten tables do not need a framework; a runner in 80 lines is auditable |
| zod schemas in `protocol` | Hand-written validators | One definition validates the server, types the SDK, and documents the protocol |
| scrypt (`node:crypto`) | Argon2id | Every Node Argon2 binding is native: `npm install` becomes a compiler invocation and fails without build tools. scrypt is memory-hard, standardized, and ships with the runtime |
| `jose` for JWT | Hand-rolled HMAC | Small, pure JS, correct |
| React + Vite, no UI kit | Next.js, MUI | An SPA needs no SSR; a bespoke 400-line stylesheet beats a megabyte of component library |
| SDK with zero runtime deps | `ws` + `axios` | Node 22+ and browsers have `fetch` and `WebSocket`; the SDK then works in both without bundler workarounds |

## 8. Database schema

```
users ──────< session_members >────── sessions ──< invites
  │                                      │
  └──< refresh_tokens                    ├──< agents (owner_user_id → users)
                                         │
                                         ├──< events            ← source of truth
                                         ├──< messages          ┐
                                         ├──< tasks             ├ projections
                                         └──< context_entries   ┘
                                                  │
                                                  └──< context_revisions
```

Notable constraints:

- `events (session_id, seq)` primary key — the ordering guarantee, enforced by the database.
- `context_entries (session_id, kind, key)` unique — one current version per key, structurally.
- `agents (session_id, name)` unique — mentions must resolve to one agent.
- `agents.owner_user_id` cascades from `users` — a delegation cannot outlive its principal.
- `sessions.owner_id` is `ON DELETE RESTRICT` — a session never becomes ownerless.

All JSON columns are `jsonb` and written through one helper, because node-postgres serializes a JavaScript array as a PostgreSQL *array literal* rather than JSON — a subtle corruption that an integration test caught during development.

## 9. What this design does not do

Stated plainly, so the README makes no false claims:

- **No horizontal scaling of the self-hosted server.** The in-process hub means two instances would not see each other's connections. The `ConnectionRegistry` seam is what the serverless deployment already swaps out — see `realtime/pgRegistry.ts` — and where a Redis-backed implementation would go.
- **No autonomous orchestration.** Capabilities are declared, stored and queryable; nothing routes work by them. `AGENT_HANDOFF` exists as an event so a runtime can implement routing above the protocol.
- **No repository access.** The server stores paths, branches and commit hashes as claims. It never reads a repository, and file contents are never stored.
- **No end-to-end encryption.** A self-hosted server sees session content. Treat the deployment boundary as the trust boundary.
- **No federation.** One server, one set of sessions.

Each of these is a real limit, not a "coming soon". [docs/ROADMAP.md](ROADMAP.md) describes what lifting them would involve.
