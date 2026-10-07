# Tandryx website hosting

## Cost decision

Use one static site in **S3 Standard + CloudFront OAC + free, non-exportable ACM**. DNS stays with adm.tools. No fixed compute, NAT, load balancer, API Gateway, Lambda, edge function, WAF, Route 53, paid CI service, access logs, versioning, replication or extra site copy is required.

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

## Domain connection — owner action

**Do not buy a domain or change DNS automatically.** The intended address is `tandryx.com`. The .com registry returned no registration on October 7, 2026; only the registrar can confirm availability at checkout. If a different name is chosen, update site metadata, sitemap, robots, redirect, docs and request a matching certificate before connecting it.

ACM certificate ARN: `arn:aws:acm:us-east-1:478681635233:certificate/4707a54e-66fc-431d-8f81-3f2c4507330e`.

After purchase, first add the validation records below in adm.tools. TTL: **300 seconds**, or the lowest allowed value if 300 is unavailable. NAME is shown in full; adm.tools' Subdomain field usually expects the relative portion, so omit the trailing `.tandryx.com` there. Keep validation CNAMEs permanently for automatic renewal.

| TYPE  | NAME                                                | VALUE                                                              | TTL |
| ----- | --------------------------------------------------- | ------------------------------------------------------------------ | --- |
| CNAME | `_c132517acf0a863d5884aca99f940dd4.tandryx.com`     | `_49eadfb318d810efff5dd36a7f1648f8.wzccmgtwzk.acm-validations.aws` | 300 |
| CNAME | `_0409cdf6dd01ef605d13bf69001d7070.www.tandryx.com` | `_043c6130d9fcd3ac6cf8c2c0fe0cafdb.wzccmgtwzk.acm-validations.aws` | 300 |

Validation requests can time out if DNS is not added promptly; check current ACM status and re-request if needed before relying on these values.

Once ACM is **ISSUED**, update the existing stack with `CertificateArn` and `DomainName=tandryx.com`, preserving all other parameters, and wait for CloudFront to finish deploying. Only then add the apex ALIAS and www CNAME listed under the live resources section below. Do not copy CloudFront's IP addresses into A records; they can change. Remove conflicting A/AAAA/ALIAS records only for those exact website names, preserving mail and verification records.

The provider documents [ALIAS support for the apex](https://www.ukraine.com.ua/wiki/domain/management/dns-records-types/alias/). Root CNAME is inappropriate; ALIAS permits separate mail TXT/MX records. DNS names remain on adm.tools; there is no Route 53 hosted zone.

The prepared `www` redirect runs in the browser, preserves path/query/fragment and uses the apex canonical metadata. It is not HTTP 301 and requires JavaScript. An HTTP 301 cannot be implemented using private S3/OAC and CloudFront configuration alone. An optional CloudFront Function would be needed for a server-side redirect; its current 2 million monthly free invocations and small excess usage price make it inexpensive, but it is unnecessary for this first static launch and has not been provisioned.

## GitHub Actions

`.github/workflows/website.yml` builds/checks pull requests and deploys pushes to main. Repository variables:

- `WEBSITE_BUCKET`
- `WEBSITE_DISTRIBUTION_ID`
- `WEBSITE_DEPLOY_ROLE_ARN`

These are public resource identifiers, not secrets. No AWS keys are stored in GitHub. Only the deployment job receives a short-lived OIDC session; the IAM trust requires the exact repository and main branch. Permissions are limited to GetObject/PutObject in the website bucket and CreateInvalidation on its distribution. There is no infrastructure management, application secret access or object deletion permission.

Deploy manually with authenticated AWS CLI credentials:

```sh
WEBSITE_BUCKET=<bucket> WEBSITE_DISTRIBUTION_ID=<id> node website/deploy.mjs
```

PowerShell: set those names with `$env:WEBSITE_BUCKET` and `$env:WEBSITE_DISTRIBUTION_ID` before running Node.

The deploy script compares content digests, uploads assets before HTML and invalidates only changed stable URLs, never `/*`. It retains previous hashed assets so cached old documents remain valid. These are small asset revisions, not duplicated sites. The deployment manifest contains only filenames/digests/cache metadata and no credentials. Infrastructure changes require an owner-controlled AWS session; deployment Actions cannot change IAM or the distribution configuration.

## Email

Mailbox selection and SPF/DKIM/DMARC steps are in [startup readiness](anthropic-startup-readiness.md#mailbox-plan). No SES infrastructure or paid mailbox has been created. Exact provider verification and DKIM values must come from the selected account after domain purchase.

## Live resources

CloudFormation stack: `tandryx-website` in `us-east-1`.

| Resource                    | Identifier                                                                |
| --------------------------- | ------------------------------------------------------------------------- |
| Private S3 bucket           | `tandryx-website-478681635233-us-east-1`                                  |
| CloudFront distribution     | `E2Y8A4H8ZSCKC5`                                                          |
| Technical website address   | **https://d38num53uhx947.cloudfront.net**                                 |
| GitHub OIDC deployment role | `arn:aws:iam::478681635233:role/tandryx-website-github-deploy`            |
| Domain certificate          | `4707a54e-66fc-431d-8f81-3f2c4507330e`, us-east-1, pending DNS validation |

After the validated certificate is attached to CloudFront, add these website records:

| TYPE  | NAME              | VALUE                           | TTL |
| ----- | ----------------- | ------------------------------- | --- |
| ALIAS | `@` (tandryx.com) | `d38num53uhx947.cloudfront.net` | 300 |
| CNAME | `www`             | `d38num53uhx947.cloudfront.net` | 300 |

These two records direct traffic; the two validation CNAMEs above prove domain ownership. They serve different purposes and all four are needed. Keep mail MX/TXT/DKIM records independent.

Verified October 7, 2026: home, Privacy, Terms, robots, sitemap and all linked assets return HTTP 200; a nonexistent route returns the custom HTML page with HTTP 404. HTTP redirects to HTTPS with 301, text responses use Brotli compression and managed security headers are present. Direct S3 access returns 403. Website source passed link/metadata/build checks and desktop/mobile browser review. Current text source audit found no previous-brand strings or AWS/GitHub token/private-key patterns.

The technical CloudFront address is free to use with this distribution and works before domain purchase. Free `github.io` project addresses are another option, but domain-branded mail requires ownership of the chosen domain. Some verified student programs offer a domain for one year; registration renewal then costs money. Do not assume a free first year means a permanently free domain.
