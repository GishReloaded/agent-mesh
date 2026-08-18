# Deploying AgentMesh on AWS

One EC2 instance running the server and PostgreSQL in containers, behind CloudFront for HTTPS and WebSocket. One command up, one command down.

---

## Why not Lambda

If your other projects are Lambda + S3, this will look like the odd one out. The reason is architectural, not stylistic.

AgentMesh is a **stateful realtime server**. Its `Hub` holds open WebSocket connections in memory, derives presence from whether a socket is alive, and fans events out to subscribers in-process. Lambda has no long-lived process and cannot hold a socket, so none of that can run there as written.

A serverless port is possible, and it is a rewrite rather than a repackaging:

| Piece | Today | On Lambda |
|---|---|---|
| Connections | in-process `Map` in `Hub` | API Gateway WebSocket API + a DynamoDB connection table |
| Fan-out | direct `socket.send` | `PostToConnection` per connection, per event |
| Presence | derived from live sockets | DynamoDB rows with TTL, and a heartbeat to refresh them |
| Heartbeat | server ping every 20 s | API Gateway idle timeout (10 min) and its 2-hour connection cap |
| Database | one pool, one process | RDS Proxy, or connection exhaustion under concurrency |
| Latency | in-memory | a cold start on the path of every chat message |

The protocol already survives that model — resume-from-cursor exists precisely so a dropped connection costs nothing — so the port is feasible. It is days of work on `packages/server/src/realtime/*`, plus Aurora Serverless v2 or RDS Proxy billing around the clock, and it makes the "clone and run" path harder to keep working.

What S3 *is* used for here: shipping the source archive to the instance. What CloudFront is used for: HTTPS without owning a domain, which is the part that actually solves remote access.

If you want the serverless port as a real piece of work, it belongs on the roadmap as its own project.

## What gets created

| Resource | Purpose |
|---|---|
| EC2 `t4g.small` + 20 GB gp3 | Server and PostgreSQL containers |
| Elastic IP | Stable origin address |
| Security group | Port 80 **only** from CloudFront's published ranges; SSH only if you ask for it |
| CloudFront distribution | HTTPS with a `*.cloudfront.net` certificate, WebSocket proxying |
| IAM role | Read exactly one S3 object, plus SSM Session Manager for shell access |
| S3 bucket | Holds the source archive, private and encrypted |

### Cost

Rough monthly figures for `eu-north-1`, on-demand, at the traffic two people and a few agents produce:

| Item | ~USD / month |
|---|---|
| t4g.small | 12 |
| 20 GB gp3 | 2 |
| Elastic IP (attached) | 4 |
| CloudFront | 0 — the free tier covers 1 TB egress and 10M requests |
| S3 | under 0.10 |
| **Total** | **~18** |

Stopping the instance still bills the volume and the Elastic IP. `-Destroy` removes everything except the S3 bucket.

## Before you start

**Do not deploy with root credentials.** Root access keys cannot be restricted by any policy, and a leak means the whole account including billing. Create an IAM user once, then use it for everything:

```powershell
aws iam create-user --user-name agentmesh-deploy
aws iam attach-user-policy --user-name agentmesh-deploy `
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name agentmesh-deploy
# put the returned keys in a named profile:
aws configure --profile agentmesh
$env:AWS_PROFILE = 'agentmesh'
```

Then delete the root keys in the console: **IAM → Security credentials → Access keys → Delete**. Bootstrapping IAM is the one job root is for.

`AdministratorAccess` is broad; scoping it to CloudFormation, EC2, S3, IAM and CloudFront is better if you are willing to iterate on a policy.

## Deploy

```powershell
./deploy/aws/deploy.ps1
```

```bash
./deploy/aws/deploy.sh          # macOS, Linux, WSL
```

The script packages `HEAD` with `git archive` — so committed files only, never your `.env` or `node_modules` — uploads it, resolves the current Amazon Linux 2023 AMI, and deploys the stack.

First run takes **10–20 minutes**: CloudFront provisioning is most of it, and the instance builds the project on boot. The stack finishes before the site answers, so poll:

```powershell
curl https://dxxxxxxxx.cloudfront.net/api/v1/healthz
```

Then open the URL and create your account.

### Close sign-ups afterwards

The URL is public. As soon as you and your collaborators have accounts:

```powershell
./deploy/aws/deploy.ps1 -AllowRegistration false
```

### Options

```powershell
./deploy/aws/deploy.ps1 -InstanceType t4g.medium        # more room for heavy agents
./deploy/aws/deploy.ps1 -KeyName mykey -SshCidr 203.0.113.4/32
./deploy/aws/deploy.ps1 -StackName agentmesh-staging    # a second environment
./deploy/aws/deploy.ps1 -Destroy                        # remove everything
```

SSH is optional because Session Manager works without it:

```powershell
aws ssm start-session --target i-0123456789abcdef0
```

## Shipping a new version

```powershell
git commit -am "feat: ..."
./deploy/aws/deploy.ps1
```

This uploads the new archive, but **CloudFormation will not restart the instance** — it has no reason to, since nothing in its definition changed. Rebuild in place:

```powershell
aws ssm start-session --target <instance-id>
sudo -i
cd /opt/agentmesh
aws s3 cp s3://agentmesh-deploy-<account>-<region>/agentmesh-src.tar.gz . && tar -xzf agentmesh-src.tar.gz
docker compose -f deploy/aws/docker-compose.prod.yml --env-file .env up -d --build
```

Migrations run automatically when the server starts.

## Backups

Everything durable is in the `agentmesh-data` volume.

```bash
# on the instance
docker compose -f deploy/aws/docker-compose.prod.yml exec -T postgres \
  pg_dump -U agentmesh --format=custom agentmesh > /tmp/agentmesh.dump
aws s3 cp /tmp/agentmesh.dump s3://agentmesh-deploy-<account>-<region>/backups/$(date +%F).dump
```

Back up `/opt/agentmesh/.env` too — it holds `JWT_SECRET`, and restoring without it signs everyone out.

Snapshotting the EBS volume on a schedule (AWS Backup, or a DLM policy) is the low-effort alternative.

---

# Working together: the exact commands

Say the deployment printed `https://d111111abcdef8.cloudfront.net`. Substitute yours.

## You — set up the session

```powershell
cd D:\Projects\AgentMesh
npm run build
npm link -w @agentmesh/cli

agentmesh login --url https://d111111abcdef8.cloudfront.net
#   choose "create an account" in the browser first, or use: agentmesh login --register

agentmesh session create "our-project"
agentmesh session invite --role member --uses 5
#   copy the token - it is shown once
```

Send your collaborator the URL and the invite token.

## You — attach your agent

Using the subscription you already pay for, no API key:

```powershell
agentmesh agent presets
agentmesh agent register "Claude" --provider anthropic --model claude-code -c coding,git,terminal
agentmesh agent run "Claude" --dry-run --workspace D:\Projects\our-project
#   looks right? drop --dry-run:
agentmesh agent run "Claude" --workspace D:\Projects\our-project -v
```

## Your collaborator — join

They need Node 22.4+ and a clone. Their subscription and their working copy stay on their machine.

```bash
git clone <repository> && cd agentmesh
npm install && npm run build
npm link -w @agentmesh/cli

agentmesh login --url https://d111111abcdef8.cloudfront.net --register
agentmesh session join <invite-token>
```

## Your collaborator — attach their agent

```bash
npm i -g @openai/codex
codex                    # "Sign in with ChatGPT" - their subscription

agentmesh agent register "GPT" --provider openai --model codex -c coding,git,backend
agentmesh agent run "GPT" --preset codex --workspace ~/code/our-project
```

If they only want to participate as a human, they can skip the clone entirely and use the web UI.

## Both of you — work

In the browser at the deployment URL, or from the terminal:

```bash
agentmesh send "@gpt design the users endpoint, then publish the contract"
agentmesh watch --events
agentmesh context list
agentmesh task list
```

The habit that makes this worth using: have agents publish contracts and decisions into **shared context**, not only into chat.

```bash
agentmesh context publish api_contract users.list "GET /api/users" \
  --data '{"response":{"items":[{"id":"string","email":"string"}],"nextCursor":"string|null"}}'
```

The other side's agent then reads the current version as data instead of guessing from a conversation. `agentmesh context list` shows what is on record; every change keeps its history.

## Sanity checks

| Symptom | Check |
|---|---|
| Site does not answer | `aws ssm start-session --target <id>`, then `tail -f /var/log/agentmesh-bootstrap.log` |
| Loads, but nobody shows online | WebSocket is not reaching the origin. Confirm the CloudFront behaviour forwards all headers and caching is disabled |
| `login` fails from the CLI | Use the full `https://` URL, no trailing slash |
| Agent connects then drops | `agentmesh agent list` for status; the runner's terminal shows the reason |
| Invite rejected | Single-use by default; issue another with `--uses 5` |
