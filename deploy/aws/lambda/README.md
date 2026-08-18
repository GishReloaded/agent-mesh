# AgentMesh on AWS Lambda

Two Lambda functions and two API Gateway APIs. Nothing is billed while idle, and you bring your own PostgreSQL.

```
        HTTP API ($default stage)                WebSocket API (prod stage)
        https://xxxx.execute-api…                wss://yyyy.execute-api…/prod
                 │                                          │
                 ▼                                          ▼
        ┌──────────────────┐                    ┌──────────────────────┐
        │  agentmesh-http  │                    │    agentmesh-ws      │
        │  REST + web UI   │                    │  $connect/$default/  │
        │  (Fastify)       │                    │  $disconnect         │
        └────────┬─────────┘                    └──────────┬───────────┘
                 │                                         │
                 └──────────────┬──────────────────────────┘
                                ▼
                        your PostgreSQL
                  (sessions, event log, and the
                   websocket connection registry)
```

---

## How the realtime part works here

This is the part that differs from every other deployment, so it is worth understanding before you operate it.

On a normal server, open sockets live in one process. Presence is "is there a socket", and broadcasting is a method call. On Lambda the socket belongs to API Gateway and the function is created and destroyed around every frame, so both facts have to be written down:

| | Self-hosted | Lambda |
|---|---|---|
| Connection registry | `Map` in memory | `ws_connections` / `ws_subscriptions` tables |
| Fan-out | `socket.send` | `PostToConnection` per subscriber |
| Presence | socket is open | a row seen within the last 12 minutes |
| Dead connections | `close` event | HTTP 410 from the management API, then the row is deleted |
| Heartbeat | server ping every 20 s | API Gateway idle timeout, 10 minutes |

The registry lives in the database you already have rather than in DynamoDB, so this adds no service to operate.

**Frame handling itself is the same code** — `packages/server/src/realtime/commands.ts` is shared by both transports, so the two deployments cannot drift into different protocols.

### Consequences you should know about

- **A connection lasts at most 2 hours** (API Gateway's hard limit) and drops after 10 minutes of silence. Clients reconnect and resume from their cursor, so nothing is lost — this is exactly what resume-from-cursor was built for — but expect reconnects in the logs.
- **Cold starts** add roughly a second to the first request after idling. For chat that is noticeable but not broken.
- **Presence is eventually correct.** `$disconnect` is not guaranteed, so a dropped client may show online for up to 12 minutes.
- **Every frame is a database round trip** to look up the connection. Keep the database close to the region.

## Database

Not part of this stack, deliberately: you said you would host it, and a database inside the stack would bill around the clock.

Anything speaking PostgreSQL 14+ works. Prefer one that tolerates many short-lived connections — Neon, Supabase and RDS with a modest pool all do. The connection string must be reachable from Lambda, which means either a public endpoint or the functions placed in your VPC (this template does not do VPC attachment; adding it also requires a NAT gateway, which is not free).

```
postgres://user:password@host:5432/agentmesh?sslmode=require
```

## Deploy

```powershell
./deploy/aws/lambda/deploy.ps1 -DatabaseUrl "postgres://user:pass@host:5432/agentmesh?sslmode=require"
```

The connection string and a generated `JWT_SECRET` are stored in SSM Parameter Store, so later deploys need no arguments:

```powershell
./deploy/aws/lambda/deploy.ps1
```

The script builds the bundles, uploads them to S3, updates the CloudFormation stack, and applies migrations against the database directly. Migrations run from your machine rather than a Lambda on purpose: two cold starts racing to migrate the same schema is a bad way to find out about locking.

Then open the printed URL and create your account. Afterwards close public sign-ups:

```powershell
./deploy/aws/lambda/deploy.ps1 -AllowRegistration false -SkipBuild
```

Tear it all down — the database, the S3 bucket and the stored secrets are left alone:

```powershell
./deploy/aws/lambda/deploy.ps1 -Destroy
```

### Doing it by hand

If you would rather not run the script, it is three commands plus migrations:

```bash
node deploy/aws/lambda/build.mjs
cd dist-lambda && zip -r ../agentmesh-lambda.zip . && cd ..
aws s3 cp agentmesh-lambda.zip s3://<bucket>/lambda/agentmesh.zip

aws cloudformation deploy \
  --stack-name agentmesh \
  --template-file deploy/aws/lambda/template.yaml \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameter-overrides CodeBucket=<bucket> CodeKey=lambda/agentmesh.zip \
    DatabaseUrl='postgres://…' JwtSecret='<64 hex chars>'

DATABASE_URL='postgres://…' npm run db:migrate
```

## Testing before you deploy

The bundles can be invoked locally against a real database, including the websocket path against a stub management API:

```powershell
$env:DATABASE_URL='postgres://…'
node deploy/aws/lambda/build.mjs
node deploy/aws/lambda/smoke.mjs
```

```
ok   GET /api/v1/version -> 200
ok   POST /api/v1/auth/register -> 201
ok   hello authenticates -> hello.ok
ok   subscribe returns a snapshot -> subscribed
ok   message.send is acknowledged -> ack
ok   the message is fanned out -> event
```

This is worth running after any change to the realtime layer. An ESM bundle of Fastify either loads in a Node 22 runtime or it does not, and CloudWatch is a slow place to learn which.

## Cost

Everything here is pay-per-use with a free allowance:

| Service | Free allowance | Realistic bill for two people |
|---|---|---|
| Lambda | 1M requests + 400,000 GB-s per month, perpetual | $0 |
| HTTP API | 1M requests/month for 12 months | cents |
| WebSocket API | 1M messages + 750,000 connection-minutes for 12 months | cents |
| S3 | a few MB of bundles | under $0.05 |
| CloudWatch Logs | 5 GB ingest free | $0 at `info` |
| SSM Parameter Store | standard parameters are free | $0 |

The database is the only thing with a floor, and it is yours.

Watch the connection-minutes if you leave agents connected around the clock: an agent parked in a session for a month is roughly 43,000 connection-minutes on its own.

## Operating it

```powershell
aws logs tail /aws/lambda/agentmesh-http --follow
aws logs tail /aws/lambda/agentmesh-ws --follow
```

| Symptom | Likely cause |
|---|---|
| 500 on every request | Database unreachable from Lambda, or `DATABASE_URL` wrong. The HTTP log says which |
| Site loads, nobody appears online | The WebSocket API URL is not reaching clients. Check `GET /api/v1/version` reports `realtimeUrl` |
| `hello` works, later frames say "send a hello frame first" | The `ws_connections` row is gone — usually the connection went stale, or migrations were not applied |
| Everything is slow on the first message | Cold start. Expected |
| Duplicate presence entries | Stale rows; they age out after 12 minutes |

Stale connection rows are cleaned when a frame fails with 410 and when presence is computed. There is no scheduled sweep, because an EventBridge rule invoking a Lambda on a timer would be a cost with no user-visible benefit at this scale — the staleness window already handles it.

## What this does not do

- **No VPC attachment.** Lambda reaches the database over the public internet with TLS. Putting the functions in a VPC to reach a private database needs a NAT gateway, which is about $32/month.
- **No custom domain.** The URLs are the generated `execute-api` ones. `REALTIME_MANAGEMENT_ENDPOINT` exists for when you add one to the WebSocket API.
- **No scheduled connection sweep.** See above.
- **No provisioned concurrency.** That would remove cold starts and add a standing bill.
