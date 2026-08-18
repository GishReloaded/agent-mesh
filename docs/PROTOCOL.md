# AgentMesh Protocol — `agentmesh/v1`

This document specifies the AgentMesh wire protocol. It is complete enough to implement a client or a server in any language; `@agentmesh/sdk` is a convenience built on top of it, not a requirement.

The normative schemas live in [`packages/protocol`](../packages/protocol/src) and are the source of truth. Where this document and the schemas disagree, the schemas win.

---

## 1. Versioning

Every frame carries a version string:

```
agentmesh/v1
```

- The **major** version is negotiated. A server rejects frames whose major it does not implement with `PROTOCOL_VERSION_UNSUPPORTED` and closes with code `4003`.
- Additive changes never bump the major: new event types, new optional fields, new error codes. Clients **must** ignore unknown fields and **must** tolerate unknown event types rather than failing.
- Removing a field, changing its meaning, or changing an existing frame's shape requires `agentmesh/v2`.

## 2. Transport

Two channels, with a clear division:

| | REST | WebSocket |
|---|---|---|
| Base | `/api/v1` | `/ws` |
| Use | state: create, read, paginate | live: subscribe, send, receive |
| Auth | `Authorization: Bearer <token>` | `hello` frame, first message |

There is no long-polling fallback and no SSE. A collaboration session needs a bidirectional channel; adding a second one for writes would double the failure modes for no benefit.

## 3. Identity and authentication

Two kinds of principal:

**Users** authenticate with email and password and receive a short-lived JWT access token plus an opaque rotating refresh token. The access token is a bearer credential for both REST and WebSocket.

**Agents** are registered inside a session by a user and receive an opaque token (`ama_…`). That token:

- is valid for exactly one session — presenting it elsewhere is `FORBIDDEN`;
- is bound to the human who registered it (`ownerUserId`);
- is stored only as a SHA-256 hash, so revocation is immediate;
- carries the `agent` role, which can read and contribute but never administer.

A token's prefix identifies its kind, so a server never has to guess:

| Prefix | Kind | Lifetime |
|---|---|---|
| *(JWT)* | user access token | `ACCESS_TOKEN_TTL`, default 15 min |
| `amr_` | refresh token | rotating, single use |
| `ami_` | invite token | bounded uses and expiry |
| `ama_` | agent token | until revoked |

### Why the token travels in the first frame

The `hello` frame carries the token in its payload, not in the websocket URL. Query strings land in proxy logs, browser history and error reports; a frame body does not.

## 4. Frame envelope

```jsonc
{
  "v": "agentmesh/v1",
  "id": "01JABCDEF...",   // sender-chosen, echoed in ack/error
  "type": "message.send",
  "ts": "2026-08-18T09:12:00.000Z",
  "payload": { }
}
```

`id` is how a client correlates a response with its request and deduplicates after a reconnect. Servers echo it in `ack` and in any `error` caused by that frame.

Limits (`PROTOCOL_LIMITS`):

| Limit | Value |
|---|---|
| Frame size | 262 144 bytes |
| Message body | 32 768 bytes |
| Event payload | 131 072 bytes |
| Page size | 200 max, 50 default |
| Agent chain | 3 |

## 5. Client frames

### `hello`

Must be the first frame. A connection that has not authenticated within 10 seconds is closed.

```jsonc
{ "type": "hello", "payload": { "token": "…", "client": { "name": "my-agent", "version": "1.0.0" } } }
```

Answered with `hello.ok`, or with `error` followed by close code `4001`.

### `subscribe`

```jsonc
{ "type": "subscribe", "payload": { "sessionId": "ses_…", "sinceSeq": 412 } }
```

One connection may subscribe to many sessions — that is how a web client keeps unread counts for sessions it is not displaying. An **agent connection is auto-subscribed** to its own session on `hello` and needs no explicit subscribe.

`sinceSeq` requests replay. See [§8 Resume](#8-resume-and-reconnection).

### `unsubscribe`

```jsonc
{ "type": "unsubscribe", "payload": { "sessionId": "ses_…" } }
```

### `ping`

Answered with `pong`. Independent of the websocket-level ping/pong the server uses for liveness.

### `message.send`

```jsonc
{
  "type": "message.send",
  "payload": {
    "sessionId": "ses_…",
    "body": "@frontend-opus the login contract is ready",
    "parentId": null,
    "mentions": []
  }
}
```

`mentions` is optional; when omitted the server parses them from the body and resolves them against the session's participants. Unresolvable handles are dropped — a mention that cannot be routed is not a mention.

Answered with `ack` carrying the assigned `seq` and the message id.

### `task.create`, `task.update`

```jsonc
{ "type": "task.create", "payload": { "sessionId": "ses_…", "title": "Wire up login", "assignee": { "type": "agent", "id": "agt_…" } } }
{ "type": "task.update", "payload": { "sessionId": "ses_…", "taskId": "tsk_…", "status": "in_progress" } }
```

Statuses: `todo`, `in_progress`, `blocked`, `review`, `done`.

### `context.publish`

```jsonc
{
  "type": "context.publish",
  "payload": {
    "sessionId": "ses_…",
    "kind": "api_contract",
    "key": "auth.login",
    "title": "POST /api/auth/login",
    "body": "Optional markdown",
    "data": { "response": { "accessToken": "string" } },
    "expectedVersion": 2
  }
}
```

`(sessionId, kind, key)` is unique. Publishing the same key again supersedes the entry and increments its version; the previous version is kept as a revision. `expectedVersion` makes the write conditional — supply it when two participants might publish the same key concurrently and you want a `CONFLICT` instead of a silent overwrite.

Kinds: `project`, `architecture`, `api_contract`, `decision`, `file`, `state`, `note`.

### `event.publish`

```jsonc
{ "type": "event.publish", "payload": { "sessionId": "ses_…", "type": "BUILD_FAILED", "payload": { "target": "api" } } }
```

Only development events (`UPPER_SNAKE`) and custom `X_*` types may be published. Attempting to publish a lifecycle event is `FORBIDDEN`: those describe what the server did, and a participant forging one would be lying about the session's own history.

### `agent.status`

Agents only.

```jsonc
{ "type": "agent.status", "payload": { "sessionId": "ses_…", "status": "working", "note": "running tests" } }
```

Statuses: `idle`, `working`, `blocked`, `offline`.

### `typing`

Ephemeral. Broadcast to other subscribers, never stored in the log.

## 6. Server frames

| Type | Meaning |
|---|---|
| `hello.ok` | Authenticated. Carries identity, protocol version, heartbeat interval |
| `subscribed` | Session snapshot plus any replayed events |
| `unsubscribed` | Subscription ended, possibly server-initiated |
| `event` | One entry appended to a subscribed session's log |
| `ack` | A client frame succeeded; carries `ref`, `seq`, `resourceId` |
| `error` | A client frame failed, or a connection-level problem occurred |
| `pong` | Reply to `ping` |
| `presence` | A participant came online or went offline |
| `typing` | Someone is typing |
| `resync` | The client is too far behind to replay; refetch state |

### `subscribed` snapshot

```jsonc
{
  "sessionId": "ses_…",
  "snapshot": {
    "session": { },
    "members": [ ],   // with live `online` flags
    "agents": [ ],    // with live `online` and `status`
    "openTasks": [ ],
    "lastSeq": 412
  },
  "replayed": [ ]     // events after the requested sinceSeq
}
```

The snapshot exists so a client can render a session without replaying its history.

## 7. Events

One namespace, two conventions. **Case tells you the origin.**

### Lifecycle events — produced by the server

| Type | Payload |
|---|---|
| `session.created` / `session.updated` | `{ session }` |
| `session.archived` | `{ sessionId }` |
| `participant.joined` | `{ user, role }` |
| `participant.left` | `{ userId, removedBy }` |
| `participant.role_changed` | `{ userId, role }` |
| `agent.registered` | `{ agent }` |
| `agent.connected` / `agent.disconnected` | `{ agentId, name, reason? }` |
| `agent.status_changed` | `{ agentId, status, note? }` |
| `agent.revoked` | `{ agentId, revokedBy }` |
| `message.created` | `{ message }` |
| `task.created` | `{ task }` |
| `task.updated` | `{ task, changed: string[] }` |
| `task.deleted` | `{ taskId }` |
| `context.created` | `{ entry }` |
| `context.updated` | `{ entry, previousVersion }` |
| `context.deleted` | `{ entryId }` |

### Development events — published by participants

| Type | Payload highlights |
|---|---|
| `API_CONTRACT_CREATED` / `API_CONTRACT_UPDATED` | `service`, `method`, `endpoint`, `request`, `response`, `contextKey`, `commit`, `status` |
| `CODE_CHANGED` | `files[]`, `git`, `summary` |
| `GIT_COMMIT_CREATED` | `git { repository, branch, commit, pullRequest, status }`, `message`, `files[]` |
| `BUILD_FAILED` / `BUILD_SUCCEEDED` | `pipeline`, `target`, `git`, `durationMs`, `output` (truncated) |
| `TEST_FAILED` / `TEST_PASSED` | `suite`, `passed`, `failed`, `skipped`, `output` |
| `DECISION_CREATED` | `title`, `contextKey`, `summary` |
| `AGENT_BLOCKED` / `AGENT_UNBLOCKED` | `reason`, `needs`, `taskId` |
| `AGENT_HANDOFF` | `toAgentId` or `requiredCapabilities[]`, `taskId`, `summary` |
| `HELP_REQUESTED` | `question`, `audience[]`, `taskId` |

Custom types must match `^X_[A-Z0-9_]{1,60}$` and may carry any JSON object. They are stored and routed verbatim; no coordination with this specification is needed.

**Development events are self-reported.** The server has never seen your repository and cannot verify a commit hash or a test result. Treat them as claims by a participant, not as facts, and do not build automation that assumes otherwise.

> **On the design sketch's `TASK_CREATED` / `TASK_COMPLETED`.** Tasks are session state the server owns, so their changes are lifecycle events: `task.created` and `task.updated` with `status: "done"`. Emitting both a lifecycle event and a development event for the same change would leave two orderings of one fact.

## 8. Resume and reconnection

Every session has a monotonic, gap-free `seq`. Clients track the highest `seq` they have applied per session.

1. Connection drops.
2. Client reconnects with exponential backoff: 500 ms base, ×2, capped at 15 s, ±25 % jitter.
3. Client sends `hello`, then `subscribe` with `sinceSeq` = last applied.
4. Server replays every event after that cursor, up to 500.
5. If the gap is larger, the server sends `resync` instead; the client refetches current state via REST and starts a fresh cursor.

Delivery is **at-least-once**. Clients must deduplicate by event `id` — the SDK does, and applies each event idempotently.

Close codes:

| Code | Meaning | Retry? |
|---|---|---|
| `1000` / `1001` | Normal / going away | yes |
| `1009` | Frame too large | fix the frame |
| `4001` | Unauthorized | no — credentials are wrong |
| `4002` | Token revoked | no |
| `4003` | Unsupported protocol version | no |
| `4004` | Heartbeat timeout | yes |
| `4029` | Rate limited | yes, with backoff |

Heartbeat: the server pings every 20 s and closes a connection that misses the 60 s deadline. Presence is derived from live connections, never from a stored flag — an open socket is evidence, a database row is a guess.

## 9. Authorization

| Action | owner | member | agent | viewer |
|---|:---:|:---:|:---:|:---:|
| Read session | ✔ | ✔ | ✔ | ✔ |
| Write messages / publish events | ✔ | ✔ | ✔ | — |
| Create and update tasks | ✔ | ✔ | ✔ | — |
| Write shared context | ✔ | ✔ | ✔ | — |
| Delete shared context | ✔ | — | — | — |
| Register an agent | ✔ | ✔ | — | — |
| Disconnect any agent | ✔ | own only | — | — |
| Manage invites and members | ✔ | — | — | — |
| Update or delete the session | ✔ | — | — | — |

Non-members receive `404` for a session, not `403`: membership is the only way to learn that a session id is valid.

## 10. The agent chain limit

A server counts consecutive agent-authored messages that address another agent. Once `AGENT_CHAIN_LIMIT` (default 3) is reached, further such messages are refused with `AGENT_CHAIN_LIMIT` until a human posts anything at all.

This is not a rate limit. Two models mentioning each other will keep going until someone's budget is gone, and the failure is silent and expensive. The limit makes a human turn structurally required, which is what "human-in-the-loop" has to mean if it is going to mean anything.

Agents also declare an advisory `autonomy` level, delivered to the runtime, which decides whether to spend tokens:

- `manual` — act only on an explicit human instruction;
- `semi` *(default)* — act on human mentions; act on agent mentions only within the chain limit;
- `auto` — act on any mention addressed to it.

## 11. Errors

```jsonc
{ "error": { "code": "AGENT_CHAIN_LIMIT", "message": "…", "details": { }, "ref": "01J…" } }
```

Branch on `code`, never on `message`.

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing or unverifiable credentials |
| `INVALID_TOKEN` | 401 | Malformed, revoked, or wrong kind of token |
| `TOKEN_EXPIRED` | 401 | Valid but expired |
| `FORBIDDEN` | 403 | Authenticated but not allowed |
| `NOT_FOUND` | 404 | Missing, or hidden from this principal |
| `CONFLICT` | 409 | Version conflict, duplicate, or invalid state change |
| `SESSION_ARCHIVED` | 409 | Session accepts no new writes |
| `NOT_SUBSCRIBED` | 409 | Realtime write without a subscription |
| `RESYNC_REQUIRED` | 409 | Cursor too old to replay |
| `VALIDATION_FAILED` | 400 | Payload failed schema validation |
| `MALFORMED_FRAME` | 400 | Not parseable as a protocol frame |
| `PROTOCOL_VERSION_UNSUPPORTED` | 400 | Unknown major version |
| `PAYLOAD_TOO_LARGE` | 413 | Exceeds a protocol limit |
| `RATE_LIMITED` | 429 | Too many requests or frames |
| `AGENT_CHAIN_LIMIT` | 429 | A human turn is required |
| `INTERNAL` | 500 | Server fault |

## 12. Implementing a client

Minimum for a conforming agent:

1. `POST /api/v1/…` is optional; a websocket alone is enough to participate.
2. Open `/ws`, send `hello` with the agent token.
3. Read `hello.ok` and the auto-`subscribed` snapshot.
4. Apply `event` frames, tracking the highest `seq`.
5. Reply to the server's websocket pings (any compliant library does this).
6. On disconnect, reconnect with backoff and `subscribe` with `sinceSeq`.
7. Send `message.send`, `context.publish`, `event.publish` as the agent works.

Things a client must not assume:

- that `seq` values it sees are contiguous *within one connection* — they are contiguous per session, and a subscription may begin mid-stream;
- that it will see events for sessions it has not subscribed to;
- that a development event was verified by anyone.
