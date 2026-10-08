# Deploying Tandryx on AWS

Two supported shapes. They run the same code — the realtime frame handling in `packages/server/src/realtime/commands.ts` is shared — and differ only in where connections are kept.

| | [lambda/](lambda/) | [ec2/](ec2/) |
|---|---|---|
| Shape | Two Lambda functions + two API Gateways | One EC2 instance behind CloudFront |
| Database | Yours, anywhere | PostgreSQL container on the same box |
| Idle cost | $0 | ~$18/month |
| Cold start | ~1 s after idling | none |
| Connection lifetime | 2 h max, 10 min idle timeout | unlimited |
| Presence accuracy | up to 12 min stale | immediate |
| Setup | one script, no server to operate | one script, a server to patch |

**Choose `lambda/`** if you already run a database somewhere and want nothing billed while idle.

**Choose `ec2/`** if you want a plain long-lived server, immediate presence, and no per-frame database round trip.

## Before either one

**Do not deploy with root credentials.** Root access keys cannot be restricted by any policy, and a leak means the whole account including billing. Create an IAM user once — bootstrapping IAM is the one job root is for:

```powershell
aws iam create-user --user-name tandryx-deploy
aws iam attach-user-policy --user-name tandryx-deploy `
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
aws iam create-access-key --user-name tandryx-deploy

aws configure --profile tandryx
$env:AWS_PROFILE = 'tandryx'
```

Then delete the root keys in the console: **IAM → Security credentials → Access keys → Delete**.

`AdministratorAccess` is broad. Scoping it to CloudFormation, Lambda, API Gateway, S3, IAM, SSM and CloudWatch is better if you are willing to iterate on a policy.

---

# Working together: the exact commands

Say the deployment printed `https://abc123.execute-api.eu-north-1.amazonaws.com`. Substitute yours.

## You — set up the session

```powershell
cd D:\Projects\Tandryx
npm run build
npm link -w @gish_reloaded/tandryx-cli

tandryx login --url https://abc123.execute-api.eu-north-1.amazonaws.com --register
tandryx session create "our-project"
tandryx session invite --role member --uses 5
#   copy the token - it is shown once
```

Send your collaborator the URL and the invite token.

## You — attach your agent

Using the subscription you already pay for, no API key:

```powershell
tandryx agent presets
tandryx agent register "Claude" --provider anthropic --model claude-code -c coding,git,terminal
tandryx agent run "Claude" --dry-run --workspace D:\Projects\our-project
#   looks right? drop --dry-run:
tandryx agent run "Claude" --workspace D:\Projects\our-project -v
```

## Your collaborator — join

Their subscription and their working copy stay on their machine. Node 22.4+ and a clone.

```bash
git clone https://github.com/Tandryx/tandryx.git && cd tandryx
npm install && npm run build
npm link -w @gish_reloaded/tandryx-cli

tandryx login --url https://abc123.execute-api.eu-north-1.amazonaws.com --register
tandryx session join <invite-token>
```

## Your collaborator — attach their agent

```bash
npm i -g @openai/codex
codex                    # "Sign in with ChatGPT" - their subscription

tandryx agent register "GPT" --provider openai --model codex -c coding,git,backend
tandryx agent run "GPT" --preset codex --workspace ~/code/our-project
```

Someone who only wants to take part as a human can skip the clone entirely and use the web UI at the deployment URL.

## Both of you — work

In the browser, or from a terminal:

```bash
tandryx send "@gpt design the users endpoint, then publish the contract"
tandryx watch --events
tandryx context list
tandryx task list
```

The habit that makes this worth using: agents publish contracts and decisions into **shared context**, not only into chat.

```bash
tandryx context publish api_contract users.list "GET /api/users" \
  --data '{"response":{"items":[{"id":"string","email":"string"}],"nextCursor":"string|null"}}'
```

The other side's agent then reads the current version as data instead of inferring it from a conversation.

## Close the door afterwards

The URL is public and anyone can sign up until you say otherwise:

```powershell
./deploy/aws/lambda/deploy.ps1 -AllowRegistration false -SkipBuild
```
