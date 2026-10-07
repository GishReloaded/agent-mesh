# Tandryx startup readiness

Last reviewed: October 7, 2026. This records preparation; no Anthropic application has been submitted. Program eligibility and application requirements still need a separate review against Anthropic's current official terms.

## Project

- Project: **Tandryx**
- Application website: **https://tandryx.top** — live over HTTPS and matches the company email domain.
- Retained free website: **https://tandryx.js.org** — live over HTTPS. JS.ORG added the DNS records; [registration PR #12666](https://github.com/js-org/js.org/pull/12666) remains open for final maintainer verification. The technical CloudFront address also works.
- Company email: **founder@tandryx.top** — created on Zoho Mail Free (EU); incoming delivery from an independent provider verified and a test reply sent. The owner confirmed the reply arrived in the Gmail inbox; Gmail shows tandryx.top as the signed-by domain and TLS transport. Full recipient Authentication-Results, particularly DMARC alignment, have not yet been independently inspected.
- GitHub: **https://github.com/GishReloaded/tandryx**
- Maintainer: **GishReloaded**. No legal entity, customer base, funding or partnership is represented here.
- License: Apache 2.0. Current release: v0.2.0.

## Product description

Tandryx is an open-source collaboration layer for AI coding agents and developers. Shared sessions carry messages, versioned project context, tasks and development events across connected people and local tools. Agents execute on their owners' machines; Tandryx coordinates their work without hosting model inference or synchronizing repository files.

## Current state

Working functionality in the current repository includes:

- Sessions with roles, invites and revocable agent tokens.
- Realtime WebSocket messages, @mentions, presence, heartbeat and event-cursor reconnection.
- Agent-to-agent messaging with a server-enforced chain limit.
- Typed and versioned context, revision history and explicit task assignment with five statuses.
- Development events and an append-only PostgreSQL session log.
- A web interface, CLI and TypeScript SDK.
- Local command bridges for Claude Code, Codex, Gemini CLI and custom commands.

The marketing site's product screenshot comes from a real, scripted SDK demonstration. It does not demonstrate live model inference or autonomous code edits. The software remains early stage and available for self-hosting; the website does not advertise a managed production subscription, uptime SLA or verified customers.

## Claude integration

The implemented `tandryx agent run --preset claude` bridge invokes an installed and authenticated local Claude Code CLI when its agent receives an @mention. It provides current contracts, decisions and tasks and resumes the local conversation on follow-up mentions. The user's provider authentication, permissions and quota remain with their local Claude Code installation.

Tandryx does not currently host Claude inference, collect Anthropic API keys on its collaboration server or operate a built-in Anthropic API integration. There is no claimed partnership or endorsement. Future MCP tools may make shared session context accessible to assistants already running in editors; those tools are planned.

Sources: [Claude Code setup](CLAUDE_CODE.md), [subscription agents](SUBSCRIPTION-AGENTS.md), [architecture](ARCHITECTURE.md), [security](SECURITY.md).

## Roadmap

Planned work includes capability-based task dispatch, an MCP server, web-based agent registration, message threads in the web interface, session export and full-text search. Later directions include Git provider integration and improved mobile views in the collaboration app. These are not shipping features or delivery-date commitments. See [the repository roadmap](ROADMAP.md).

## Website and infrastructure

The public marketing website is separate from the dynamic collaboration application. Its source is in `website/`; it uses plain HTML, CSS and a small browser module. It has no forms, analytics, external fonts, cookies or application credentials. The production build creates exact `/privacy` and `/terms` S3 objects, a genuine 404 page, favicon, OpenGraph image, canonical metadata, sitemap and robots file.

Hosting uses one private, encrypted S3 bucket, CloudFront Origin Access Control and HTTPS. CloudFront redirects HTTP to HTTPS, compresses supported responses, honors origin cache headers and adds AWS-managed security headers. Missing paths return HTTP 404, including private S3's missing-key 403 responses. There is no SPA fallback, server compute, database, WAF or Route 53 for this website.

JS.ORG maintainers added the ACM validation record, AWS issued the free certificate, and the alias and certificate were attached to the existing CloudFront distribution. Public HTTPS, pages, assets and the custom 404 on `tandryx.js.org` were verified. The owner subsequently registered `tandryx.top` through Spaceship for $1.60 for the first year, with current renewal at $4.05/year including ICANN fees. Its DNS is configured, a free certificate covering both domains is issued, and CloudFront is deployed with both aliases. Public HTTPS and all website routes/assets were verified on both names. Both names use the same site. No separate `www` host or additional redirect service is required.

Anthropic currently asks for a company email matching the website domain. Use `https://tandryx.top` with `founder@tandryx.top` in the application, while retaining the working JS.ORG address. Domain and email matching alone does not establish program eligibility. See [current program requirements](https://claude.com/programs/startups).

GitHub Actions builds on pull requests and deploys main using AWS OIDC. The AWS role trusts only `GishReloaded/tandryx` on `refs/heads/main`, can read/write website objects and invalidate only this distribution. It cannot create infrastructure, access the application's secrets or assume wider AWS permissions. Hashed assets have immutable caching; only changed stable paths are invalidated.

## Mailbox plan

Amazon SES was evaluated first. Its usage-based sending prices are low, but SES is not a normal mailbox. Receiving into S3 plus forwarding, identity verification and external inbox arrangements would add unnecessary operations for a single founder address. No SES resources were created.

**Zoho Mail Free (EU)** was selected and the admin console confirms the actual Mail Free plan, with no trial or renewal date. It provides: one custom domain, up to five users and 5 GB per user. Use its webmail/mobile app for receiving and sending. IMAP/POP/ActiveSync are not included, and availability is limited to selected data centers. No paid mailbox or upgrade was selected.

The JS.ORG website name does not include a mailbox or independent DNS management; new NS delegation is discontinued. Do not assume `founder@tandryx.js.org` can be provisioned. The owner has now purchased the separate `tandryx.top` domain and authorized connecting it to the website and mailbox. Spaceship DNS supports the website apex ALIAS alongside mail MX/TXT records.

Mailbox configuration procedure:

1. Create the provider account as the domain owner and choose an actually free plan if available.
2. Verify domain ownership using the exact TXT/CNAME token issued by that provider.
3. Create `founder@tandryx.top`. Add the provider's regional MX records.
4. Add exactly one SPF TXT record using that provider's current instructions; do not combine multiple SPF records.
5. Generate DKIM in the provider console, add its actual selector/public key and enable signing.
6. Start DMARC at `_dmarc.tandryx.top` with `v=DMARC1; p=none; adkim=r; aspf=r`. Add a reporting address only when a monitored mailbox is ready. Move toward `quarantine`/`reject` after verifying legitimate senders.
7. Test incoming mail and outgoing mail to an independent provider; inspect Authentication-Results for SPF/DKIM/DMARC alignment and check spam placement.
8. Replace the temporary GitHub-only contact on the website with the working mailbox, update this checklist and deploy.

Configured and publicly verified on October 7, 2026 (TTL 300 seconds):

| Type | Host             | Value                                                                                    | Priority |
| ---- | ---------------- | ---------------------------------------------------------------------------------------- | -------- |
| MX   | @                | mx.zoho.eu                                                                               | 10       |
| MX   | @                | mx2.zoho.eu                                                                              | 20       |
| MX   | @                | mx3.zoho.eu                                                                              | 50       |
| TXT  | @                | v=spf1 include:zohomail.eu ~all                                                          | —        |
| TXT  | zmail._domainkey | Actual RSA public key issued by Zoho; verified in the admin console, DKIM status enabled | —        |
| TXT  | _dmarc           | v=DMARC1; p=none; adkim=r; aspf=r                                                        | —        |

Domain ownership was verified using the issued CNAME at `zb49416801`, pointing to `zmverify.zoho.eu`; the corresponding verification TXT is retained. Both mail and website records coexist on Spaceship DNS. A real test message from the owner’s independent mailbox arrived in the Zoho inbox, and an authorized reply was sent. The owner confirmed the reply arrived in the Gmail inbox. Gmail shows tandryx.top as the signed-by domain and TLS transport; full recipient Authentication-Results have not yet been independently inspected.

References checked October 7, 2026: [SES pricing](https://aws.amazon.com/ses/pricing/), [Zoho plans and Free availability](https://www.zoho.com/mail/zohomail-pricing.html), [adm.tools provider guide for Zoho](https://www.ukraine.com.ua/wiki/domain/third-party-services/zohomail/).

## Checklist

- [x] Site deployed — https://tandryx.js.org; all public pages and assets verified.
- [x] HTTPS working — valid ACM certificate on the selected domain; HTTP redirects with 301.
- [x] tandryx.js.org working — DNS, ACM validation and CloudFront alias complete; final registration PR merge is pending maintainer verification.
- [x] www decision recorded — no additional www host requested for the free JS.ORG name.
- [x] Mobile checked — 390 px and 320 px layouts, no horizontal overflow; menu toggles and closes on navigation.
- [x] GitHub link working — points to the actual public repository.
- [x] Privacy working — `/privacy` returns HTTP 200.
- [x] Terms working — `/terms` returns HTTP 200.
- [x] tandryx.top working — DNS, issued ACM certificate and CloudFront alias complete; public pages, assets and HTTPS verified.
- [x] founder@tandryx.top receives email — independent-provider test arrived in the inbox.
- [x] founder@tandryx.top sends email — reply arrived in the owner’s Gmail inbox.
- [x] SPF valid — one SPF record, publicly resolved and verified by Zoho.
- [x] DKIM valid — issued public key resolves; Zoho selector verified and signing enabled.
- [x] DMARC DNS policy published — p=none record publicly resolved.
- [ ] Outbound SPF/DKIM/DMARC alignment independently checked in recipient Authentication-Results.
- [x] No previous-brand references remain — current tracked/new text source audited. Historical Git objects and compatibility resource names are outside the public website's brand audit.
- [x] No secrets exposed — changed files reviewed and current text source checked for AWS/GitHub token and private-key patterns; website contains no credentials.
- [x] No fake claims — website distinguishes available features, plans and scripted demonstration.
- [ ] Ready for Anthropic review — requires final domain, email and independent review.

## Before application

The free website domain and HTTPS are operational; keep the JS.ORG registration PR open until maintainers finish their verification and merge it. The separate `tandryx.top` domain is purchased. Its Mail Free mailbox receives and sends mail in real independent-provider tests. The public contact address and notices are updated. Inspect recipient-side Authentication-Results to finish the detailed alignment check, then perform the separate Anthropic program eligibility/application review. No Anthropic application has been made.
