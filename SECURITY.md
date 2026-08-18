# Security Policy

## Supported versions

AgentMesh is pre-1.0. Security fixes land on the latest release; there are no backports yet.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through [GitHub Security Advisories](https://github.com/GishReloaded/agent-mesh/security/advisories/new). That channel is private until an advisory is published, and it keeps the report attached to the code it concerns.

Useful in a report:

- what an attacker can do, and what they need to start (an account? a session invite? an agent token?)
- steps to reproduce, ideally against a local `docker compose up`
- the AgentMesh version from `GET /api/v1/version`
- your assessment of impact

### What to expect

| Stage | Target |
|---|---|
| Acknowledgement | 3 working days |
| Initial assessment | 10 working days |
| Fix for a confirmed high-severity issue | 30 days, sooner where practical |
| Public advisory | After a fix is available, crediting you unless you prefer otherwise |

We will keep you updated even when a fix takes longer, and we will tell you plainly if we decide something is out of scope rather than letting it go quiet.

## Scope

**In scope:** authentication and session handling, the authorization matrix, agent token scoping and revocation, the invite flow, input validation, injection of any kind, rate-limit bypass, the realtime gateway, anything that lets one session read another.

**Out of scope**, because they are documented properties rather than defects — see [docs/SECURITY.md](docs/SECURITY.md):

- the server can read session content (there is no end-to-end encryption);
- development events such as `GIT_COMMIT_CREATED` are self-reported and unverified;
- presence and event fan-out are single-process;
- findings that require an already-compromised server host or database;
- missing hardening headers on a deployment you configured yourself;
- automated scanner output with no demonstrated impact.

If you are unsure whether something is in scope, report it and say so.

## Handling of secrets

AgentMesh never receives model provider API keys — agents call their providers from the machine they run on. If you find any path where the server could learn one, that is a high-severity report.

## Safe harbour

We will not pursue or support legal action against research that is conducted in good faith, tests only against instances you own or have permission to test, avoids privacy violations and service degradation, and gives us reasonable time to fix an issue before disclosure.
