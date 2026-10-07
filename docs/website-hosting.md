# Tandryx website hosting

## Cost decision

Use one static site in **S3 Standard + CloudFront OAC + free, non-exportable ACM**. The chosen free website name is `tandryx.js.org`; JS.ORG maintains its DNS. No fixed compute, NAT, load balancer, API Gateway, Lambda, edge function, WAF, Route 53, paid CI service, access logs, versioning, replication or extra site copy is required.

The current $0/month CloudFront flat-rate plan was evaluated. It requires a WAF association, limits custom configuration and bundles services not needed here. The simpler pay-as-you-go distribution has no fixed monthly charge and benefits from the recurring CloudFront free allowance. Other distributions share that account/organization allowance; this is an estimate for the website's incremental usage, not a cap on the entire AWS account bill.

### ESTIMATED AWS COST

Assumptions: under 10 MB of source/deployed assets, 1,000–10,000 visits/month, under 5 GB/month CDN transfer, up to 100,000 origin GETs and roughly 1,000 deployment PUTs/month. Current initial deployed payload is under 1 MB. Conservative request counts allow for CDN cache misses across locations.

| Service         | Estimated monthly cost                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| S3              | ~$0.01–0.05; allow ~$0.10 for more requests/deployments                                                |
| CloudFront      | ~$0 within the shared 1 TB transfer / 10 million requests monthly free allowance                       |
| ACM             | $0 for the non-exportable public certificate integrated with CloudFront                                |
| Other           | $0: IAM, OIDC, CloudFormation and OAC have no separate resource fee; no paid ancillary service created |
| Estimated total | **~$0.01–0.10/month** under these assumptions                                                          |

S3 US East (N. Virginia) reference rates are $0.023/GB-month, $0.005/1,000 PUTs and $0.0004/1,000 GETs. S3-to-CloudFront data transfer is free. Up to 1,000 invalidation paths/month are free; changed stable files use only a few paths per deployment. If the shared free allowance is already consumed, for example 5 GB of US/European CloudFront transfer plus 100,000 HTTPS requests would add roughly $0.53 at reference rates. Higher traffic, bots and account-wide usage can change the bill; pay-as-you-go is not a hard spending cap. Do not add or upgrade resources costing $5+/month without the owner's explicit approval.

Pricing references checked October 7, 2026: [CloudFront pay-as-you-go/free-tier FAQ](https://aws.amazon.com/cloudfront/faqs/), [flat-rate restrictions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html), [S3 pricing](https://aws.amazon.com/s3/pricing/), [ACM pricing](https://aws.amazon.com/certificate-manager/pricing/), [invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html).

## Build and preview

```sh
npm run website:test
npm run website:build
npm run website:preview
```

The builder uses Node.js only and adds no build dependencies. Preview at `http://localhost:4178`. `website/dist` is generated and ignored. Editable logo and social artwork are SVG; the social PNG and product WebP are committed exports so CI needs no native image dependency.

## Infrastructure

CloudFormation source: `website/aws.yaml`. Initial provisioning used:

```sh
aws cloudformation create-stack --stack-name tandryx-website \
  --template-body file://website/aws.yaml \
  --capabilities CAPABILITY_NAMED_IAM --region us-east-1
```

The stack creates one private SSE-S3 bucket, OAC, distribution, bucket policy, GitHub OIDC provider and narrow deployment role. No certificate is attached until domain validation succeeds. The domain's certificate is requested separately in us-east-1 with DNS validation and export disabled so pending domain ownership cannot block the technical-domain deployment.

If reusing the template in a different account that already has the GitHub OIDC provider, set `CreateGitHubOidc=false`. Keep this parameter unchanged for the current stack: removing its provider could disrupt roles sharing it.

## Domain connection — DNS configured

The owner selected **tandryx.js.org** instead of buying a domain. JS.ORG provides a free subdomain for JavaScript ecosystem projects through a registration pull request. Tandryx has a published TypeScript SDK, protocol package and Node.js CLI; the website links to the actual npm packages and examples. JS.ORG permits other hosting providers, so the existing AWS site stays in place. See [registration and content requirements](https://github.com/js-org/js.org#other-providers) and [service terms](https://js.org/terms.html).

The request adds only this alphabetically ordered line to `cnames_active.js`:

```js
  "tandryx": "d38num53uhx947.cloudfront.net", // noCF
```

`noCF` requests DNS-only resolution without Cloudflare proxying. A source and deployed `CNAME` file also records the intended name; AWS does not process that file automatically. [Registration PR #12666](https://github.com/js-org/js.org/pull/12666) remains open: maintainer `indus` confirmed adding both DNS records and will merge after verifying the hosted site. Keep the request open until that review completes.

ACM certificate ARN: `arn:aws:acm:us-east-1:478681635233:certificate/ea110f9d-5aa9-4583-aa56-4cefb9dcd3af`. It covers only `tandryx.js.org`, is non-exportable, and costs $0 with CloudFront.

JS.ORG maintainers added this **DNS-only** validation CNAME. Both authoritative nameservers returned the exact requested value, and ACM issued the certificate on October 7, 2026. Keep the record permanently for certificate renewal. TTL 300 seconds or the provider default is suitable.

| TYPE  | NAME                                               | VALUE                                                              | TTL |
| ----- | -------------------------------------------------- | ------------------------------------------------------------------ | --- |
| CNAME | `_a0540782c902720754c3a54d6a18724a.tandryx.js.org` | `_82c936a281006a012efddf3b3d5c6b41.wzccmgtwzk.acm-validations.aws` | 300 |

The registration PR requests this additional validation record in its body; it does not insert an unrelated record into the one-line CNAME change. A future replacement certificate can use the retained validation record; always verify its current status and record values.

After ACM became **ISSUED**, the existing stack was updated with `CertificateArn`, `DomainName=tandryx.js.org` and `IncludeWww=false`, preserving `CreateGitHubOidc=true`. The reviewed change set modified only the existing CloudFront distribution with no replacement or additional resources. JS.ORG's website CNAME is `tandryx.js.org -> d38num53uhx947.cloudfront.net`. Public HTTPS on the new domain was verified on October 7, 2026: all pages and linked assets return 200, HTTP redirects with 301, and a nonexistent route returns the custom HTML 404.

No `www.tandryx.js.org` name, certificate SAN or redirect is requested. Adding another name later requires its own approval and certificate coverage. No additional AWS redirect service is needed.

## GitHub Actions

`.github/workflows/website.yml` builds/checks pull requests and deploys pushes to main. Repository variables:

- `WEBSITE_BUCKET`
- `WEBSITE_DISTRIBUTION_ID`
- `WEBSITE_DEPLOY_ROLE_ARN`

These are public resource identifiers, not secrets. No AWS keys are stored in GitHub. Only the deployment job receives a short-lived OIDC session; the IAM trust requires the exact repository and main branch. Permissions are limited to GetObject/PutObject in the website bucket and CreateInvalidation on its distribution. There is no infrastructure management, application secret access or object deletion permission.

This renamed repository uses GitHub's **immutable OIDC subject**, verified through the repository's OIDC settings API. Its exact trusted subject is `repo:GishReloaded@42474995/tandryx@1338785076:ref:refs/heads/main`, with audience `sts.amazonaws.com`. Both owner and repository IDs are included. Do not replace it with a name-only subject or wildcard. On future renames/transfers, read the current `sub_claim_prefix` from `GET /repos/GishReloaded/tandryx/actions/oidc/customization/sub` and update the trust explicitly. See [GitHub's immutable subject reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims).

Deploy manually with authenticated AWS CLI credentials:

```sh
WEBSITE_BUCKET=<bucket> WEBSITE_DISTRIBUTION_ID=<id> node website/deploy.mjs
```

PowerShell: set those names with `$env:WEBSITE_BUCKET` and `$env:WEBSITE_DISTRIBUTION_ID` before running Node.

The deploy script compares content digests, uploads assets before HTML and invalidates only changed stable URLs, never `/*`. It retains previous hashed assets so cached old documents remain valid. These are small asset revisions, not duplicated sites. The deployment manifest contains only filenames/digests/cache metadata and no credentials. Infrastructure changes require an owner-controlled AWS session; deployment Actions cannot change IAM or the distribution configuration.

## Email

Mailbox selection and SPF/DKIM/DMARC steps are in [startup readiness](anthropic-startup-readiness.md#mailbox-plan). JS.ORG registration does not provide a mailbox or independent DNS administration. New NS delegation is discontinued, so custom mail is not assumed available on this free website name. No SES infrastructure or paid mailbox has been created. A separately owned domain remains an option if a branded mailbox is required.

### Additional domain selected — registration pending

The owner selected `tandryx.top` through Spaceship on October 7, 2026. The reviewed cart contains only one year of domain registration and free WHOIS privacy: $1.40 plus the $0.20 ICANN fee, or $1.60 before any applicable taxes. Current renewal is $3.85 plus $0.20, or $4.05/year. Availability and future prices are not guaranteed. Registration and payment are still pending; this is not yet a live website or mailbox address. See [registrar pricing](https://www.spaceship.com/domains/gtld/top/).

`AdditionalDomainName` in the CloudFormation template allows a second domain to use the existing distribution and bucket. Its default is empty, so the current deployment is unchanged. A free non-exportable ACM certificate covering **both** `tandryx.js.org` and `tandryx.top` has been requested in `us-east-1`: `arn:aws:acm:us-east-1:478681635233:certificate/c65e835f-a883-4ad8-a2e4-770c0835f303`. It is pending DNS validation and is not attached to CloudFront. The existing JS.ORG validation record matches this certificate and must remain in place. After ownership is confirmed, add this new validation record through the owner's DNS:

| TYPE  | NAME                                            | VALUE                                                              |
| ----- | ----------------------------------------------- | ------------------------------------------------------------------ |
| CNAME | `_597ba81fc80e1616be976fe9686af21c.tandryx.top` | `_749cd4cc9016d1a517730d6c841dec09.wzccmgtwzk.acm-validations.aws` |

Attach only an issued certificate, set `AdditionalDomainName=tandryx.top`, and keep `DomainName=tandryx.js.org`, `IncludeWww=false` and `CreateGitHubOidc=true`. Review a change set before applying it; no extra bucket, distribution, paid DNS or compute is required.

Serve the same website directly on both names. For a company mailbox such as `founder@tandryx.top`, specify `https://tandryx.top` in the Anthropic application so the website and email domains match its [published requirement](https://claude.com/programs/startups). Configure the website through an apex ALIAS and email through MX/SPF/DKIM/DMARC records. Zoho Mail Free is the first mailbox candidate, but its regional availability must be confirmed during signup before treating the mailbox as free or operational. No trial or paid mailbox has been selected.

## Live resources

CloudFormation stack: `tandryx-website` in `us-east-1`.

| Resource                    | Identifier                                                     |
| --------------------------- | -------------------------------------------------------------- |
| Private S3 bucket           | `tandryx-website-478681635233-us-east-1`                       |
| CloudFront distribution     | `E2Y8A4H8ZSCKC5`                                               |
| Technical website address   | **https://d38num53uhx947.cloudfront.net**                      |
| Public website address      | **https://tandryx.js.org**                                     |
| GitHub OIDC deployment role | `arn:aws:iam::478681635233:role/tandryx-website-github-deploy` |
| Domain certificate          | `ea110f9d-5aa9-4583-aa56-4cefb9dcd3af`, us-east-1, issued      |

JS.ORG has activated this website record:

| TYPE  | NAME             | VALUE                           | TTL |
| ----- | ---------------- | ------------------------------- | --- |
| CNAME | `tandryx.js.org` | `d38num53uhx947.cloudfront.net` | 300 |

The website record directs traffic; the separate validation CNAME proves domain control to ACM. Both are required for direct CloudFront hosting with HTTPS.

Verified October 7, 2026: home, Privacy, Terms, robots, sitemap and all linked assets return HTTP 200; a nonexistent route returns the custom HTML page with HTTP 404. HTTP redirects to HTTPS with 301, text responses use Brotli compression and managed security headers are present. Direct S3 access returns 403. Website source passed link/metadata/build checks and desktop/mobile browser review. Current text source audit found no previous-brand strings or AWS/GitHub token/private-key patterns.

The technical CloudFront address remains available while the free domain request is reviewed. JS.ORG is a voluntary service with no ownership or availability guarantee for the subdomain; it has no registration or renewal charge.
