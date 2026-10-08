# @gish_reloaded/tandryx-protocol

The wire contract for [Tandryx](https://github.com/Tandryx/tandryx) — `tandryx/v1`.

This package contains no transport, no storage and no provider-specific code. It is the single definition of what an Tandryx session looks like, shared by the server, the SDK, the CLI and the web client, so any third-party implementation can be checked against the same schemas.

Install the protocol types and schemas:

```bash
npm install @gish_reloaded/tandryx-protocol
```

Source and GitHub-release tarballs are alternative installation paths; see the
[project README](https://github.com/Tandryx/tandryx#installation).

```ts
import {
  PROTOCOL_VERSION,      // "tandryx/v1"
  clientFrameSchema,     // zod schema for every client frame
  parseEventPayload,     // validate an event payload against its type
  parseMentions,         // resolve @handles against participants
  can, SessionRole, Permission,
  TandryxError, ErrorCode,
} from '@gish_reloaded/tandryx-protocol';
```

What is in here:

| Module | Contents |
|---|---|
| `version` | Protocol version, negotiation helper, hard limits |
| `primitives` | Ids, roles, actors, capabilities, task statuses, context kinds, git and file references |
| `entities` | Session, member, agent, message, task, context entry, invite |
| `events` | Lifecycle and development event catalogues with per-type payload schemas |
| `ws` | Frame envelope and every client/server frame |
| `rest` | Request and response schemas for the REST API |
| `permissions` | The role capability matrix |
| `mentions` | Handle derivation and mention resolution |
| `errors` | `TandryxError`, stable error codes, HTTP status mapping |

The specification is in [docs/PROTOCOL.md](https://github.com/Tandryx/tandryx/blob/main/docs/PROTOCOL.md). Where the document and these schemas disagree, the schemas win.

Apache-2.0.
