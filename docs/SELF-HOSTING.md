# Self-Hosting AgentMesh

AgentMesh is one Node process, one PostgreSQL database, and a static web bundle the same process serves. There is no queue, no cache tier and no object storage to operate.

---

## Fastest path: Docker Compose

```bash
git clone https://github.com/your-org/agentmesh.git
cd agentmesh

# Generate a real secret before anything long-lived.
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export PUBLIC_URL=https://mesh.example.com

docker compose up -d
```

The stack is:

| Service | What it is |
|---|---|
| `postgres` | PostgreSQL 17 with a named volume |
| `agentmesh` | API + realtime gateway + web UI on port 4000 |

Migrations run automatically on boot, so a fresh volume needs no extra step.

## On AWS

Two supported shapes, both one command, both sharing the same frame-handling code:

```powershell
./deploy/aws/lambda/deploy.ps1 -DatabaseUrl "postgres://…"   # serverless, $0 idle, bring your own database
./deploy/aws/ec2/deploy.ps1                                  # one instance behind CloudFront, ~$18/month
```

The serverless variant keeps its connection registry in PostgreSQL instead of process memory, since Lambda cannot hold a socket. The trade-offs — cold starts, a two-hour connection ceiling, presence that can lag by minutes — are set out in [deploy/aws/README.md](../deploy/aws/README.md).

## Without Docker

Requires Node 22.4+ and PostgreSQL 14+.

```bash
git clone https://github.com/your-org/agentmesh.git
cd agentmesh
npm ci
npm run setup                 # .env, database, migrations
npm run build
NODE_ENV=production npm run start:server
```

Run it under a process supervisor. A minimal systemd unit:

```ini
[Unit]
Description=AgentMesh
After=network.target postgresql.service

[Service]
Type=simple
User=agentmesh
WorkingDirectory=/opt/agentmesh
EnvironmentFile=/opt/agentmesh/.env
ExecStart=/usr/bin/node packages/server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Configuration

Every variable is documented in [`.env.example`](../.env.example). The ones that matter for a real deployment:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL 14+ |
| `JWT_SECRET` | **yes in production** | 32+ characters. Changing it signs everyone out |
| `PUBLIC_URL` | yes | Used to build invite links. Must be the URL users actually open |
| `CORS_ORIGINS` | yes | Explicit list. `*` is rejected in production |
| `ALLOW_REGISTRATION` | no | Set `false` after creating your accounts to close sign-ups |
| `DATABASE_SSL` | no | `true` for managed PostgreSQL |
| `AGENT_CHAIN_LIMIT` | no | Consecutive agent-to-agent turns before a human is required |
| `WEB_DIST` | no | Auto-detected. Set to `none` to run headless |

When the server serves the UI itself — the default — `PUBLIC_URL` and `CORS_ORIGINS` are the same single origin and there is no CORS configuration to get wrong.

## Reverse proxy

The server speaks plain HTTP; terminate TLS in front of it. **The proxy must forward the WebSocket upgrade on `/ws`** — this is the one setting people miss, and its symptom is a UI that loads but never shows anyone as online.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name mesh.example.com;

  ssl_certificate     /etc/letsencrypt/live/mesh.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mesh.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location /ws {
    proxy_pass http://127.0.0.1:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    # Sessions are long-lived; do not let the proxy time them out.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
```

### Caddy

```
mesh.example.com {
  reverse_proxy 127.0.0.1:4000
}
```

Caddy handles the upgrade and TLS without extra configuration.

## Health and monitoring

| Endpoint | Use |
|---|---|
| `GET /api/v1/healthz` | Liveness and readiness. `503` when the database is unreachable |
| `GET /api/v1/version` | Deployed version, protocol version, effective limits |

Logs are JSON on stdout (pino). Set `LOG_LEVEL=warn` in production if `info` is too chatty. No request body is ever logged.

## Backups

Everything durable is in PostgreSQL.

```bash
pg_dump --format=custom "$DATABASE_URL" > agentmesh-$(date +%F).dump
pg_restore --clean --if-exists --dbname "$DATABASE_URL" agentmesh-2026-08-18.dump
```

Back up `JWT_SECRET` with it. Restoring a database with a different secret leaves every account signed out — recoverable, but confusing during an incident.

The event log grows with activity and is the largest table. It is also the source of truth for the whole session history, so do not prune it without deciding what you are willing to lose.

## Upgrading

```bash
git pull
npm ci
npm run build
# Migrations also run automatically on boot.
npm run db:migrate
systemctl restart agentmesh
```

Migrations are forward-only `.sql` files applied in order inside a transaction each, recorded in `_agentmesh_migrations`. Take a dump before upgrading a deployment you care about.

Clients reconnect on their own with backoff, so a restart costs a few seconds of latency, not a lost session: every client resumes from its cursor.

## Scaling

One process handles a workload far past what a team of humans and agents produces — the hot path is a single indexed insert plus an in-memory fan-out.

The limit that matters is **not** throughput: presence and event fan-out live in one process, so two servers behind a load balancer would not see each other's connections. Running more than one instance requires implementing `EventSink` over Redis pub/sub and moving presence to a shared store. That seam exists and is documented in [ARCHITECTURE.md](ARCHITECTURE.md#3-realtime); the implementation does not.

Vertically, tune `DATABASE_POOL_MAX` before anything else.

## Operational checklist

- [ ] `JWT_SECRET` generated and stored in a secret manager
- [ ] `PUBLIC_URL` matches the URL users actually open
- [ ] `CORS_ORIGINS` is an explicit list
- [ ] TLS terminated, `/ws` upgrade forwarded, proxy read timeout raised
- [ ] `ALLOW_REGISTRATION=false` once your accounts exist
- [ ] Nightly `pg_dump`, restore tested at least once
- [ ] `/api/v1/healthz` wired to your monitoring
- [ ] Database volume and backups encrypted at rest
