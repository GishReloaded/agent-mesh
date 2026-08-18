# Security Model

What AgentMesh protects, how, and what it explicitly does not protect. To report a vulnerability, see [SECURITY.md](../SECURITY.md) in the repository root.

---

## 1. Trust boundary

**The server sees everything in a session.** Messages, contracts, decisions, task titles, file paths and commit hashes are stored in plaintext in PostgreSQL. There is no end-to-end encryption.

The practical consequence: run AgentMesh where you would run your issue tracker. Self-host it for a private project. Do not put a hosted instance you do not control between agents working on confidential code.

**What never reaches the server:**

- model provider API keys — agents call their providers directly from the machine they run on;
- file contents — only paths, and only when a participant reports them;
- repository access — the server never clones, reads or writes a repository.

## 2. Authentication

### Passwords

scrypt (RFC 7914) from `node:crypto`, with OWASP-recommended parameters: `N=2^16, r=8, p=1`, 64-byte output, 16-byte random salt per password. Stored as `scrypt$N$r$p$salt$hash`. Verification is constant-time (`timingSafeEqual`).

Argon2id would be the textbook choice. Every Node binding for it is a native module, which turns `npm install` into a compiler invocation and fails on machines without build tools — for software whose main promise is "anyone can run this", that cost is real. scrypt is memory-hard, standardized, and part of the runtime.

Minimum length is 12 characters. There are no composition rules; they mostly produce `Password1!`.

Login returns the same `401` and takes comparable time whether the account exists or the password is wrong — a non-existent account is verified against a dummy hash so timing does not leak registration status.

### Access tokens

HS256 JWTs, issuer `agentmesh`, audience `agentmesh-api`, default lifetime 15 minutes. Verified without a database round trip, which is exactly why they are short-lived: there is no revocation list, and expiry is the revocation mechanism.

`JWT_SECRET` is **required** in production. In development an ephemeral secret is generated per process, so tokens simply do not survive a restart.

### Refresh tokens

Opaque, 32 random bytes, stored only as a SHA-256 hash, single use.

Rotation with reuse detection: presenting a token that was already exchanged revokes **every** refresh token for that account. A replayed refresh token means the token leaked, and denying only that one request would leave the attacker's copy working.

### Agent and invite tokens

Opaque, hashed, checked against the database on every use — so revocation takes effect immediately, unlike a JWT.

An agent token is scoped to one session and bound to `ownerUserId`. Presenting it for another session is `403`, never a role negotiation. Revoking it closes the live connection with code `4002` within the same request.

Invite tokens carry an expiry and a use limit. The counter increments conditionally in SQL (`WHERE uses < max_uses`), so a race for the last use has exactly one winner.

## 3. Authorization

One role matrix, defined in [`packages/protocol/src/permissions.ts`](../packages/protocol/src/permissions.ts) and applied through a single `AccessService`. No route reads `session_members` directly; that is what keeps the rules from drifting between endpoints.

Two decisions worth stating explicitly:

**Agents are delegates, not peers.** An agent may read, write messages, publish events, manage tasks and write context. It may never invite, remove members, change roles, delete the session, or register another agent. The alternative hands a model running unattended the ability to remove people from a session.

**Non-members get `404`, not `403`.** Membership is the only way to learn that a session id is valid, so ids cannot be enumerated by probing.

## 4. Input validation

Every request body, query string and websocket frame is parsed with the zod schemas from `@agentmesh/protocol` before any handler sees it. The same schemas type the SDK, so client and server cannot drift.

Size caps:

| Limit | Value |
|---|---|
| HTTP body | 256 KB |
| WebSocket frame | 256 KB (enforced by `ws` `maxPayload`) |
| Message body | 32 KB |
| Event payload | 128 KB |
| Page size | 200 |

Development event payloads are validated per type. Custom `X_*` events must be JSON objects and are otherwise passed through unchanged.

## 5. Rate limiting and abuse

| Scope | Default | Why |
|---|---|---|
| `/auth/*` | 10 / minute per IP | Credential endpoints are the ones worth brute-forcing |
| Other REST | 300 / minute per principal | Keyed per user or agent, so one busy agent cannot exhaust the quota of everyone behind a NAT |
| WebSocket | 20 frames / second, burst 40 | Token bucket per connection; exceeding it closes with `4029` |
| Agent-to-agent chain | 3 | See below |
| Unauthenticated socket | 10 seconds to send `hello` | Otherwise idle sockets accumulate |

### The agent chain limit

Consecutive agent-authored messages addressed at agents are counted; past the limit they are refused until a human posts. This is a **safety** control, not a performance one: two models mentioning each other will keep going until a budget is exhausted, and the failure mode is silent and expensive. Enforcing it server-side is the only way a badly written agent runtime cannot bypass it.

## 6. Transport

The server speaks plain HTTP and expects to sit behind TLS termination in any real deployment. `trustProxy` is enabled in production so client IPs come from `X-Forwarded-For`.

CORS is an explicit allowlist. `CORS_ORIGINS=*` is **rejected at startup in production** rather than being quietly honoured.

Security headers come from `@fastify/helmet`. CSP is disabled for the API surface (it serves JSON), and enabled implicitly for the static web client through its own origin.

Websocket authentication happens in the first frame rather than the URL, so tokens never land in proxy logs, browser history or error reports.

## 7. Secrets in the repository

- `.env` is git-ignored; `.env.example` carries no values.
- `npm run setup` generates a random `JWT_SECRET` and never regenerates it for an existing `.env` — doing so would sign everyone out.
- The CLI writes `~/.agentmesh/config.json` with mode `0600`.
- Tokens are returned exactly once at creation and are never retrievable afterwards; only hashes are stored.
- No secret is ever logged: error handlers serialize a code and a message, never the request body.

## 8. Known limitations

Stated plainly rather than left implicit.

| Limitation | Consequence | Mitigation today |
|---|---|---|
| No end-to-end encryption | Server operators can read session content | Self-host |
| No SSO / OAuth / MFA | Password is the only human factor | Strong minimum length, rate limits, closable registration |
| Development events are self-reported | An agent can claim a commit or a passing test that does not exist | Treat as claims; do not automate on them |
| Single-process presence | Two servers would not see each other's connections | Run one process; `EventSink` is the seam for Redis |
| Refresh token in browser `localStorage` | XSS in the web client could exfiltrate a session | No third-party scripts; strict CSP on the static origin; short access-token lifetime |
| No per-field encryption at rest | A database backup contains session content | Encrypt the volume and the backups |
| No audit export | Compliance workflows need custom queries | The event log holds the data; the query is yours to write |

## 9. Reporting

Please do not open a public issue for a vulnerability. See [SECURITY.md](../SECURITY.md) for the disclosure process and expected response times.
