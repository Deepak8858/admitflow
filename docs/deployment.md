# AdmitFlow deployment and SQLite cutover

This runbook describes the infrastructure and release tooling. No AWS resources have been deployed or provider accounts live-verified by this implementation.

## Placement and architecture

Use **AWS Singapore (`ap-southeast-1`) with Neon Singapore (`aws-ap-southeast-1`)**. The reviewed Neon region list includes Singapore and does not list Mumbai. Verify current service/instance availability when choosing the actual account and region. Cloudflare R2's APAC location hint is a placement preference, not an India-residency guarantee.

```text
Browser -> DNS -> HTTPS ALB -> Next.js standalone /api/health + application
                              | WorkOS AuthKit
                              | Neon pooled runtime connection
                              | private R2 object storage
                              | tenant-authorized provider APIs
                              + private TLS Valkey / BullMQ

ECS worker -> durable Neon jobs/outbox -> BullMQ -> Meta / OpenAI / ElevenLabs / Calendar
One-off ECS migration task -> Neon direct migration connection
```

`infra/app.ts` synthesizes `AdmitFlow-staging` as an **offline fixture only** by default, not an approved deployment. Production requires the explicit scoped account, region, two custom role ARNs and verified bootstrap-owned `tenantKeyArn` described below. Synthesis does not look up accounts, networks, certificates, keys or secrets, and does not build Docker images. `infra/stack.ts` defines:

| Resource | Baseline | Operational consideration |
| --- | --- | --- |
| VPC | Two AZs; two public and two isolated subnets; no NAT gateway | Tasks have public IPv4 addresses for Neon/R2/provider egress. Web ingress is ALB-only on 3000; worker/migration tasks have no ingress. Egress allows HTTPS, PostgreSQL and the private queue. |
| ALB | Public HTTPS 443; HTTP redirects to the configured domain | Existing issued ACM certificate required in the same region. Only the configured hostname forwards to web targets. Health checks use `/api/health`; idle timeout is 120 seconds. |
| Web service | Fargate Linux x86-64, 0.25 vCPU / 1 GiB, one task | Next standalone on Node 24. Deployment circuit breaker and container health check enabled. |
| Worker service | Fargate Linux x86-64, 0.25 vCPU / 1 GiB, one task | Actual `scripts/worker.ts` bundled to `dist/worker.mjs`. Independent desired count; 120-second stop timeout and signal forwarding for queue draining. |
| Migration task definition | Fargate 0.25 vCPU / 512 MiB | Uses the worker image with `node dist/migrate.mjs`. Runs only when explicitly launched; no migration runs at web/worker startup. |
| ECR | One immutable-tag repository, scan-on-push | Web/worker task definitions pin digests, not `latest`. Untagged images expire after seven days; keep tagged rollback releases until deliberately retired. |
| Valkey | Node-based ElastiCache 7.2, `cache.t4g.small`, one primary | Isolated subnets, TLS required, AUTH, encryption at rest, custom `valkey7` parameter group with `maxmemory-policy=noeviction`, three days of snapshots. Single-node baseline has no automatic failover. |
| Secrets | Existing JSON application secret; generated queue AUTH secret | ECS injects specific JSON keys; the application secret itself is not created or populated by CDK. The queue password is never a plaintext task environment value. |
| KMS | Reference to an existing, rotation-enabled bootstrap-owned tenant key | No production key/alias resource or CloudFormation retention policy. Web/worker grants and boundaries name its exact ARN. The application supplies `organizationId` as encryption context. Preserve the key independently with Neon backups. |
| Logs/alarms | 30-day web, worker, migration and Valkey engine log groups | CPU/memory, unhealthy targets, target 5xx, worker failures, queue memory and eviction alarms. Optional existing SNS topic for notification delivery. |

For a more resilient deployment, synthesize/deploy with `-c highAvailability=true`: the default web count becomes two and Valkey gains a replica with Multi-AZ automatic failover. The worker still defaults to one. The baseline does not configure autoscaling, Fargate Spot, Container Insights, NAT gateways, VPC endpoints or an application S3 bucket. Files stay in **R2**. Scoped production synthesis forbids file/Docker assets and uses a compact inline template, not an ordinary CDK administrator bootstrap.

### Cost drivers

Obtain a regional estimate using the actual AWS account, Neon plan and provider usage. Main drivers are Fargate vCPU/memory runtime, ALB hours/capacity units, public IPv4 addresses, Valkey node-hours and snapshots, ECR image retention/scanning, CloudWatch ingestion/retention/alarms, Secrets Manager, KMS requests, AWS outbound data transfer, Neon compute/storage/history, R2 storage/operations, and provider API usage. R2's lack of egress-bandwidth charges does not remove applicable AWS networking charges. Multi-AZ replicas and extra task replicas add recurring capacity. Retained keys, secrets, log groups, images and final queue snapshots can continue to incur charges after stack removal.

## Configuration contract

Start from `.env.example`. Keep real values in `.env.local` for local work and in the existing Secrets Manager JSON secret for ECS. Do not place secret values in CDK context, CloudFormation parameters, image build arguments, image layers or release logs. ECS uses IAM task/execution roles; application containers do not need AWS access-key environment variables.

### Application secret

`infra/application-secret.example.json` is the exact selected-key shape. Fill it through your secret-management process, outside the repository. **Every selected key must exist**: ECS fails task startup for a missing JSON key. Optional provider values may be empty strings, and an unconfigured `BILLING_PLANS_JSON` is the string `[]`. It must be a string containing JSON, not a nested array, because it becomes an environment variable.

- Web gets runtime DB/R2/AI/speech/Calendar keys plus WorkOS, Meta, SaaS billing and optional cron/state-signing keys.
- Worker gets runtime DB/R2/AI/speech/Calendar keys plus `BILLING_RAZORPAY_KEY_ID`, `BILLING_RAZORPAY_KEY_SECRET` and `BILLING_PLANS_JSON` for independent subscription reconciliation. Web shares those billing selectors; the billing webhook secret/account-ID selector and WorkOS API key remain web-only. Tenant Meta/Calendar/admission-payment credentials come from KMS-encrypted Neon connection records.
- Schema migration task gets only `DATABASE_URL_UNPOOLED` from the application secret.
- `DATABASE_URL_UNPOOLED` is never injected into web or worker tasks.
- If the existing secret uses a customer-managed KMS key, pass its ARN with `-c appSecretKmsKeyArn=...`. This grants the execution roles access to that existing key. Use a secret and key in the deployment region/account.
- Secret rotation does not update the environment of running ECS tasks. Replace both services' tasks after rotating application secrets. Queue AUTH rotation also requires an ElastiCache AUTH-token update; do not rotate that secret independently of the engine.
- `WORKOS_WEBHOOK_SECRET` is reserved for signed WorkOS event wiring; enable its handler before registering a webhook. Resend/Sentry placeholders are documented as planned configuration and are not injected or implemented by this stack.

The provider implementation is evolving alongside this tooling. When adding a new environment variable, update `.env.example`, the selected keys in `infra/stack.ts`, and the JSON template together. The current names for platform SaaS billing are **`BILLING_RAZORPAY_*` and `BILLING_PLANS_JSON`**; institute admission-payment credentials are separate tenant connections.

### Public build-time configuration

Next inlines these values into the web build:

- `NEXT_PUBLIC_META_APP_ID`
- `NEXT_PUBLIC_META_CONFIG_ID`
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI`

Pass them when building the **web** target. Runtime CloudFormation `MetaAppId`, `MetaConfigId` and `DomainName` must match the image's values. Changing only an ECS environment variable does not rewrite compiled browser code. Rebuild the web image for a changed Meta app/config ID or WorkOS callback/domain. Public identifiers are not secret credentials; Meta app secrets and access tokens never become build arguments.

CDK sets `APP_BASE_URL=https://<DomainName>`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://<DomainName>/callback`, and the server-side `META_APP_ID` alias. Use a distinct web image for staging if public configuration differs from production. The worker bundle keeps runtime environment lookups rather than inlining them.

### Queue configuration

The Node worker expects `REDIS_URL`. ECS injects `REDIS_PASSWORD` as a secret and supplies `REDIS_HOST`, `REDIS_PORT` and `REDIS_TLS=true`. `infra/entrypoint.mjs` assembles the escaped `rediss://` URL in memory, removes the separate password field from its child's environment, and forwards SIGTERM/SIGINT. It also rejects missing production DB configuration so containers cannot silently fall back to local SQLite.

Use a local Redis/Valkey `REDIS_URL` when running `npm run worker` directly. Production queue nodes are private and have no externally reachable endpoint. BullMQ needs `noeviction`: capacity exhaustion should cause observable errors, not silent eviction of work. Neon durable records remain the recovery source after queue loss. Reconcile ambiguous provider attempts before retrying; restoring a queue or database is not proof that a message was never delivered.

### Receipt RLS rollout

Migration `0013_event_receipt_rls` forces tenant RLS on `event_receipts`. Deploy the tenant-paged worker with this migration: the old contextless recovery scan cannot see receipts under the restricted runtime role. Recovery pages ID-only `organization_routes`, attempts at most two due receipts per tenant across ten tenants per tick, advances past empty/failing tenants, and wraps to revisit capped backlogs. Existing claims, expired-lease retries and financial idempotency remain unchanged. Runtime must not be superuser or have `BYPASSRLS`.

Legacy receipts with null `organization_id` are retained but hidden from all runtime tenant contexts. Do not guess their ownership or delete/reassign them automatically. Any repair requires a separately authorized migration/import-role investigation and verified tenant attribution.

### Provider prerequisites

- **Neon:** pooled connection for a runtime role with required DML grants and no `BYPASSRLS`; direct connection for a separate schema/import role. Use certificate verification in PostgreSQL TLS settings, for example `sslmode=verify-full`. The SQLite importer requires the migration role to have `BYPASSRLS` so it can detect ID collisions across all tenants. Total runtime connections are roughly `DATABASE_POOL_SIZE × task count`, plus deployment overlap, imports and migrations.
- **WorkOS:** configure the exact callback, sign-out/application origins, organizations, verified users, active memberships and supported role slugs. Provision/migrate real identities through WorkOS separately. The SQLite importer verifies them; it does not create identities, organizations or invitations, or copy local passwords/sessions.
- **Meta:** configure Embedded Signup for Business-app coexistence, the public app/config IDs, app secret and signed webhooks. WhatsApp webhook is `/api/webhooks/whatsapp`; Lead Ads webhook is `/api/webhooks/meta-leads`. Coexistence requires eligible accounts and the correct Meta onboarding configuration; deployment alone does not enable it. Per-institute access tokens and sender/Page mappings are held in encrypted connection records.
- **R2:** create/use a private bucket and bucket-scoped API credentials. Set browser CORS for the exact application origins and the upload methods/headers the API returns, including `Content-Type`, `x-amz-meta-admitflow-workspace` and `x-amz-meta-admitflow-file`. Expose `ETag` if needed by the client. The app derives the R2 endpoint with SDK region `auto`; do not substitute AWS S3 credentials or make the bucket public.
- **OpenAI/ElevenLabs:** optional platform keys or institute-specific keys. Models, usage budgets, reply mode and voice choices are institute settings. Meta remains the WhatsApp transport; ElevenLabs handles speech.
- **Knowledge retrieval:** `KnowledgeVectorEnabled` / `KNOWLEDGE_VECTOR_ENABLED` defaults to `false` (full-text). Enable only after installing the reviewed optional pgvector migration and configuring the embedding provider; embedding requests add provider usage costs.
- **Google Calendar:** OAuth callback is `/api/integrations/google/callback`. Refresh tokens and calendar IDs are per institute. `GOOGLE_OAUTH_STATE_SECRET` can be a dedicated random key or fall back to the WorkOS cookie key.
- **Razorpay:** configure existing approved plans and the platform subscription webhook `/api/webhooks/billing`. Keep platform SaaS credentials separate from institute admission-collection merchants. Plan prices are read from the configured provider plans rather than invented by infrastructure.

## Local verification

**19 September release repairs:** `npm run verify` passed 236 application tests, 14 infrastructure tests, both typechecks, Next/service builds, tooling checks and the ten-migration dry run (exit 0). Fresh browser verification passed 38/38 in 13.0 minutes (exit 0). Workflow lint and redacted Git-history/source scans passed; production audit is clean, with the same four moderate dev-only advisories in the full audit. Repaired-commit Linux CI and CodeRabbit review remain pending. See [current evidence](verification.md#current-release-repair-evidence--19-september); the following counts describe earlier runs.

**18–19 September subscription evidence:** uninterrupted isolated `--all` passed 175 application tests, 8 infrastructure tests, project/infra TypeScript, Next build, five service bundles, operational syntax/help checks and the eight-migration dry run, exit 0. Final browser rerun passed all 37 tests in 21.3 minutes, exit 0; final TypeScript passed after test-only timing corrections. Earlier failures/interruption are retained, not counted as passes. Subscription/access repairs have local regression evidence; independent access-review sign-off, multi-replica/provider staging, capacity work and live deployment remain pending. No lint script/pass exists. See [full provenance](verification.md).

From the repository root, use `node scripts/verify.mjs --subscriptions` for focused subscription/intake regressions plus project typecheck, `node scripts/verify.mjs --access` for team-access/connected-service checks, or `npm run verify:payments` for payment regressions plus typecheck; then `npm run verify` for application/infra tests, project/infra typechecks, Next build, service bundles, operational syntax/CLI checks and database-free migration dry run. `node scripts/verify.mjs --build` resumes infra/build/tooling stages without repeating tests. Check port 3100/process ownership before `npm run verify:browser`; it uses disposable browser SQLite. The verifier strips inherited provider settings and blanks template-named variables without editing `.env.local`; this is environment isolation, not a network sandbox.

Lower-level commands below do not provide that environment isolation. On Windows, verify the parent before commands that create outputs:

```powershell
Test-Path -LiteralPath "H:\new-app" -PathType Container
Test-Path -LiteralPath "H:\new-app\infra" -PathType Container
node node_modules/typescript/bin/tsc -p infra/tsconfig.json --pretty false
npm run test:infra
npm run db:migrate -- --dry-run
npm run build:services
node --check dist/worker.mjs
```

The tests use temporary SQLite fixtures and in-memory PostgreSQL/PGlite, including repository round-trips. They do not contact WorkOS, Neon or AWS. The schema dry run validates every journaled migration and rejects unjournaled SQL without connecting to PostgreSQL.

Validated on 12 September 2026 after the queue dependency updates: all **8 tooling tests** passed; scoped worker/infrastructure TypeScript checking, service bundles, bundle syntax/CLI checks, BullMQ imports/message serialization, and offline CDK synthesis passed. The migration dry run and PostgreSQL fixture replay include all **five** journaled migrations through `0004_lead_view_dates.sql`. This verification covers the service/tooling scope rather than a browser or full Next application build.

For strictly offline synthesis without even invoking the AWS-aware CDK CLI, execute the app directly:

```powershell
Test-Path -LiteralPath "H:\new-app\infra" -PathType Container
$env:CDK_OUTDIR = "infra/cdk.out"
node --import tsx infra/app.ts
```

The existing package command is also supported:

```powershell
npm run infra:synth -- --no-lookups --no-notices --output infra/cdk.out -c stage=staging -c region=ap-southeast-1
```

No AWS credentials or parameter values are needed to construct the template. CDK uses explicit two-AZ names instead of availability-zone lookups. Validate those AZ names in the intended account before deployment. CDK synthesis cannot verify certificate status, permissions, image contents, DNS, quotas or actual regional engine availability.

### Scoped production synthesis and bootstrap gates

Review [the IAM bootstrap runbook](../infra/iam/README.md) before attaching any policies. The production stack uses six explicitly named workload roles with separate bootstrap-owned permission boundaries. Boundary policies cap, but do not grant, access; JSON secret selectors do not isolate IAM access to individual fields.

Offline production synthesis uses the fixed public contract plus the **actual verified key ARN**, not credentials. Supply `ADMITFLOW_TENANT_KEY_ARN` from the approved nonsecret bootstrap record; never copy the synthetic test ARN into production configuration:

```powershell
if ([string]::IsNullOrWhiteSpace($env:ADMITFLOW_TENANT_KEY_ARN)) { throw 'Supply the verified bootstrap-owned key ARN first' }
$env:CDK_CONTEXT_JSON = (@{
  stage = 'prod'; account = '543777713748'; region = 'ap-southeast-1'
  deployRoleArn = 'arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-deploy'
  cloudFormationExecutionRoleArn = 'arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-cfn-exec'
  tenantKeyArn = $env:ADMITFLOW_TENANT_KEY_ARN
} | ConvertTo-Json -Compress)
$env:CDK_OUTDIR = 'infra/cdk.out-prod'
node --import tsx infra/app.ts
```

Both custom role ARNs are mandatory: the installed BootstraplessSynthesizer otherwise falls back to conventional CDK roles. `tenantKeyArn` must be an exact single-region UUID key ARN in the fixed account/region, not an alias, wildcard, multi-region key ID or padded string. This validates syntax only, not resource provenance or configuration. The synthesizer rejects assets and templates larger than 51,200 UTF-8 bytes; there is no automatic S3 upload fallback. Clear or restore these synthesis environment variables before running other CDK projects.

The tenant key and fixed alias are created/configured by the separately scoped non-root bootstrap process in the [IAM runbook](../infra/iam/README.md#tenant-key-bootstrap-and-cleanup). Creation omits tags; setup authorizes only the returned key ARN. Verify metadata, tags, rotation and alias, remove the temporary bootstrap key-policy grant while exact-key IAM permission remains, read back the final policy, then detach setup permissions. IAM detachment alone cannot revoke a direct key-policy grant. Production uses `Key.fromKeyArn`, which is a CDK external reference **not a CloudFormation resource import**; it emits no KMS Key/Alias resources and routine CFN has no KMS permissions. Stack rollback/deletion leaves this bootstrap-owned key and alias untouched. Never create a replacement or delete a key automatically after an uncertain operation; retain historical ciphertext access and key recovery evidence with backups.

The application stack no longer owns an account-wide Logs resource policy. A separately approved non-root bootstrap operator must install and read back `admitflow-prod-valkey-logs`, using the reviewed `valkeyLogDeliveryPolicy()` artifact or equivalent IAM bundle document, then detach its account-level write permission. Preserve unrelated policies. Routine CloudFormation receives no PutResourcePolicy/DeleteResourcePolicy authority.

**Deployment remains blocked** until real AWS policy validation, MFA role assumption, provider readiness and resource-provider behavior are verified. Validate the separate KMS bootstrap sequence and its final policy cleanup without granting administration of unrelated keys; independently verify the native cache parameter-group and snapshot naming/tagging against their fail-closed IAM prefixes. `CacheParameterGroupName` returns the actual generated name after creation; it is not configurable as a fixed physical name. Passing offline tests is not permission to bypass these gates, start paid builds or perform cloud writes.

## Images and release procedure

### GitHub review, CI and Depot image publishing

The private repository is `Deepak8858/admitflow`. The first application import is submitted for review in PR #1 against a minimal baseline; do not merge until the review scope, skipped paths and findings have been checked. CodeRabbit requires repository installation/authorization and an eligible review plan. Posting `@coderabbitai full review` requests review of the PR diff, not unchanged baseline files or guaranteed coverage of every file.

`.github/workflows/ci.yml` runs on PRs to `main` and pushes to `main`: isolated application/infra verification, browser fixtures, redacted Git-history secret scanning, actionlint workflow validation and a production lockfile audit. Actions and downloaded scanning/linting tools are pinned. actionlint's optional ShellCheck/Pyflakes integrations are disabled; it does not lint application TypeScript. PR jobs receive no deployment/provider credentials and checkout does not persist its token. There is still no application lint gate. The current private GitHub account plan rejected branch-protection access; these checks are visible but not enforced as required merge checks. Keep merging operator-controlled unless the account gains the necessary protection features.

Depot remote container builds support GitHub personal repositories using OIDC; Depot-managed GitHub Actions runners require a GitHub organization. This setup therefore uses GitHub-hosted CI jobs and Depot for image building, not all-Depot compute. Dedicated Depot project `0xd1td4lmf` (`admitflow`) was created in the existing `voiceforge` Depot organization. Its returned cache policy is 25 GiB with seven-day retention, despite requesting 5 GiB; account-wide cache usage/billing must be checked before builds. No build or subscription purchase was started during setup.

`.github/workflows/publish-images.yml` is **manual-only and currently disabled** by repository variable `BUILDS_APPROVED=false`. It only accepts `main`, requires the operator to type `PUBLISH`, and verifies a successful main-push CI run for the exact commit before obtaining AWS credentials or building images. It publishes an immutable web/worker pair and a 90-day release-manifest artifact; it does not deploy ECS, apply migrations or change DNS. Configure and verify deployment separately through the initial-release procedure below. Manual invocation and the opt-in variable are operational safeguards, not protection against a repository administrator changing workflows.

Before enabling publishing:

- In the Depot project's settings, add GitHub OIDC trust for user `Deepak8858`, repository `admitflow`, restricted to `refs/heads/main` where supported. Confirm the actual trust configuration and account usage allowance; creating the project alone does not grant workflow access.
- Set `AWS_PUBLISH_ROLE_ARN` to a non-root role trusted only for GitHub issuer `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`, and subject `repo:Deepak8858/admitflow:ref:refs/heads/main`. Use a separate bootstrap/deployment identity. The image publisher needs ECR authorization plus upload/PutImage/DescribeImages for only the intended ECR repository; it needs no Secrets Manager reads, ECS deployment, IAM PassRole or database credentials.
- Set `ECR_REPOSITORY` from the reviewed stack output after bootstrap. `AWS_ACCOUNT_ID`, `DEPOT_PROJECT_ID` and the digest-pinned `NODE_IMAGE` are nonsecret repository variables. Recheck the official Node image digest and vulnerability status before release; resolving a digest is not a container vulnerability audit.
- Set optional public `NEXT_PUBLIC_META_APP_ID` and `NEXT_PUBLIC_META_CONFIG_ID` to the configured provider identifiers. The callback is fixed to `https://admitflow.incfrog.ai/callback`; match runtime and WorkOS configuration.
- Only after provider prerequisites, current costs and build allowance are approved, set `BUILDS_APPROVED=true`. Keep AWS access keys and all provider credentials out of repository secrets/build arguments. GitHub and Depot OIDC provide short-lived access.
- Inspect image scan results and execute container smoke tests before applying the manifest's digest pair. A completed image-publishing job is not production-deployment success. Tagged ECR images survive the untagged-image lifecycle policy; retain known-good rollback tags deliberately.

### Package integration

`package.json` and `package-lock.json` include the deployment tooling and a direct, pinned `esbuild@0.28.2` development dependency. The scoped TypeScript configuration checks both infrastructure and the actual worker entry point against the installed queue APIs.

Available package commands:

```json
{
  "scripts": {
    "test": "tsx --test tests/*.test.ts",
    "db:migrate": "tsx scripts/migrate.ts",
    "db:import-sqlite": "tsx scripts/migrate-sqlite.ts",
    "build:services": "node infra/build.mjs",
    "test:infra": "tsx --test infra/tests/*.test.ts"
  }
}
```

`npm test` runs the existing `tests/*.test.ts` suite; `npm run test:infra` runs the additional tooling tests. Service builds write to root `dist/` by default. Root `dist/` and `cdk.out/`, plus infrastructure-local build/test outputs, have ignore rules.

### Dependency audit — 12 September 2026

Rechecked 17 September with `npm audit --omit=dev --package-lock-only --ignore-scripts` and the full lockfile audit: **0 production vulnerabilities**, **4 moderate development-only findings**, unchanged advisory chain below. No install, force-fix or downgrade was performed.

- `npm audit --omit=dev`: **0 vulnerabilities** after upgrading BullMQ to **5.81.5** and ioredis to **5.11.1** within their compatible 5.x lines. BullMQ's former `uuid@9` dependency was removed, resolving [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). Its declared `cron-parser@4.9.0` dependency is included in the clean production audit.
- Full `npm audit`: **4 moderate dev-only findings** from one older esbuild advisory, [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99), through `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils → esbuild@0.18.20`. This concerns the affected esbuild development server's cross-origin responses. The service bundler uses the separate direct `esbuild@0.28.2` dependency.
- The current stable Drizzle Kit, **0.31.10**, still declares that loader chain. npm suggests downgrading to 0.18.1, which is outside the selected compatible toolchain. The dev-only finding remains documented pending an appropriate upstream release; avoid exposing the affected development server. Production migrations use `tsx` plus the Drizzle ORM migrator.
- Dependency resolution retains Next **16.3.5**, React/React DOM **19.3.0**, and React Table **8.21.3**. Re-run the audits for each release because advisory data can change independently of the lockfile.

### Build

`Dockerfile` uses Node 24 Debian slim, `npm ci` from the existing lockfile, a non-root runtime user, Next standalone for web, and a separately bundled worker with production npm dependencies. External packages remain external to retain BullMQ scripts, PDF assets and native modules. `.dockerignore` excludes environments, SQLite files/backups, caches and build outputs. Supply a reviewed Node 24 base-image digest through `NODE_IMAGE` in the actual release pipeline.

Example build commands for a Docker-enabled release host (PowerShell; public values only):

```powershell
Test-Path -LiteralPath "." -PathType Container
docker build --platform linux/amd64 --target web --build-arg "NEXT_PUBLIC_META_APP_ID=$env:NEXT_PUBLIC_META_APP_ID" --build-arg "NEXT_PUBLIC_META_CONFIG_ID=$env:NEXT_PUBLIC_META_CONFIG_ID" --build-arg "NEXT_PUBLIC_WORKOS_REDIRECT_URI=$env:NEXT_PUBLIC_WORKOS_REDIRECT_URI" -t admitflow-web:release .
docker build --platform linux/amd64 --target worker -t admitflow-worker:release .
```

The web runtime command is `node server.js`, with `.next/static` and `public` copied beside standalone output. The worker runtime command is `node dist/worker.mjs`. Service bundle entry points also include `dist/migrate.mjs`, `dist/migrate-sqlite.mjs`, `dist/payments.mjs` and `dist/preflight.mjs`; verify those artifacts in the rebuilt worker image alongside the complete `drizzle/` journal. All five bundles built on 17 September, and the new operational CLIs passed syntax/help smoke checks; Docker image execution is still pending. Never substitute `next start` for the standalone runtime command.

### Initial deployment and subsequent releases

1. Complete the scoped non-root IAM bootstrap and all documented authorization gates, precreate the reviewed Valkey log policy, configure/verify the bootstrap-owned tenant key and alias (including final key-policy cleanup and setup-permission detachment), and verify Neon roles, private R2 bucket, production WorkOS app, issued same-region ACM certificate and existing JSON application secret. Use the same actual tenant key ARN in production context and workload boundaries. Do not run ordinary administrator CDK bootstrap. These external setup operations are outside synthesis.
2. For a new stack, deploy with **both desired counts zero** to create ECR and infrastructure before images exist. The digest parameters still require a syntactically valid `sha256:<64 hex characters>` placeholder; no image is pulled with zero tasks. Supply real digests before increasing counts.
3. Build web/worker for Linux amd64, authenticate Docker to the output ECR repository using the release identity, tag each image with a unique immutable release tag, push, and resolve its digest. Keep the public build configuration with the release manifest. Do not push from this offline implementation environment.
4. Update CloudFormation with the real `WebImageDigest` and `WorkerImageDigest`, keeping counts at zero for initial migration/cutover. Review IAM/network changes and the image scan in the release environment.
5. Run the one-off migration task or the local migration command with the direct migration role. Wait for task completion and check its exit code/log stream before starting services. A successful `ecs run-task` response only means the task was submitted.
6. If migrating SQLite, complete the rehearsal/cutover below while source and target application writers are stopped.
7. Run configuration preflight for each role, start web, verify the configured hostname, `/api/health` and `/api/ready`, authenticate with WorkOS, and exercise tenant boundaries and private R2 uploads. Start worker after reviewing held/reconciliation work and confirming provider configuration. Readiness is not a substitute for these live integration checks.
8. Use the reviewed, exact-scope [DNS procedure below](#application-dns-preview-and-apply) to publish the application alias only after release acceptance. Ensure the application origin, WorkOS callback and provider URLs agree. For SSE, send heartbeats more frequently than the ALB idle timeout.

### Application DNS preview and apply

`scripts/release-dns.mjs` is specific to account `543777713748`, Singapore `ap-southeast-1`, public zone `Z07524403BCACLCZ72JOD` (`incfrog.ai`) and `admitflow.incfrog.ai`. It cannot publish apex, wildcard, WWW, mail, WorkOS, R2 or arbitrary operator-supplied targets. It does not request certificates or provision infrastructure. No DNS or AWS resource has been created by the implementation/tests.

**Identity and permissions:** install/configure AWS CLI v2 separately. Supply an explicit named profile assuming `arn:aws:iam::543777713748:role/admitflow/bootstrap/admitflow-prod-bootstrap`; the tool verifies the corresponding STS assumed-role ARN and account before resource reads. The current `default` profile is ROOT and must not be used. Root, IAM users, other roles/accounts, omitted profiles and profiles named `default`/`root` are rejected. The deployment/CloudFormation execution roles are not DNS operators. Obtain separately reviewed phase-specific operator permissions; never grant broad administrator permissions to bypass a denial. AWS CLI loads the selected local profile through its normal secure authentication flow; the script neither opens credential files nor prints provider errors. It strips inherited AWS credentials, custom endpoints and unrelated application settings from subprocesses, fixes the AWS region, disables endpoint overrides and automatic retries, and limits each CLI call to 30 seconds. Review the profile's own role/source configuration and use temporary credentials.

The runtime uses `sts:GetCallerIdentity`, `route53:GetHostedZone`, paginated `ListResourceRecordSets`, exact `acm:DescribeCertificate`, and (application phase) `elasticloadbalancing:DescribeLoadBalancers`, `DescribeListeners`, `DescribeTargetGroups`, `DescribeTargetHealth`, and `ecs:DescribeServices`. Apply additionally needs exact-zone `route53:ChangeResourceRecordSets` restricted to CREATE and reviewed names/types, plus `GetChange`. The script's checks do not replace IAM policy review. ELB read actions may require broader resource scope where AWS does not support ARN scoping.

**1. Certificate validation precedes infrastructure HTTPS.** Under separately approved non-root access, the lead must first paginate Singapore's certificate inventory and inspect matching certificate metadata. Reuse an eligible exact-domain Amazon-issued certificate when available. Only if no reusable matching certificate exists, separately approve/request a certificate for exactly `admitflow.incfrog.ai`, DNS validation, no wildcard or extra SANs. Record the actual returned ARN; do not invent ARN suffixes or validation tokens. Wait for ACM to return its real DNS validation CNAME. Requesting a certificate is deliberately not a DNS-tool action.

Preview is the default: it makes read-only AWS and DNS queries, not an offline dry run. It verifies the public zone/NS delegation and AWS-returned exact-domain certificate, then inventories all zone records (including child NS delegations and conflicting routing-policy records). The only validation change permitted is the actual ACM CNAME with TTL 300. Matching records no-op; different TTLs/values/routing policies are conflicts, not automatic repairs. Store review files under ignored `.data` (protected operator ACLs on Windows). The destination must not already exist.

```powershell
# Only after approval and secure named-profile setup. These variables contain public metadata, not credentials.
New-Item -ItemType Directory -Force .data | Out-Null
node scripts/release-dns.mjs --profile $env:ADMITFLOW_DNS_PROFILE --phase validation --certificate-arn $env:ADMITFLOW_CERTIFICATE_ARN --plan .data/dns-validation.json
```

Inspect the file's exact contract, identity, desired CNAME, changes and fingerprint. Keep the reviewed fingerprint independently in the release record; do not automatically read/copy it from an unreviewed file into apply. Within 15 minutes, repeat the same options and explicitly confirm that fingerprint:

```powershell
$reviewedFingerprint = Read-Host 'Paste the independently reviewed plan SHA-256'
node scripts/release-dns.mjs --profile $env:ADMITFLOW_DNS_PROFILE --phase validation --certificate-arn $env:ADMITFLOW_CERTIFICATE_ARN --plan .data/dns-validation.json --apply --confirm $reviewedFingerprint
```

Apply re-reads identity, zone, certificate, delegation and all records; any inventory/target drift blocks mutation and requires a fresh preview in a new file. Changes are CREATE-only, in one Route53 batch: never UPSERT or DELETE. Wait for the returned change ID to become INSYNC. Public CNAME verification is reported separately and **does not establish ACM issuance**. Separately wait for ACM `ISSUED` and verify the complete certificate ARN/domain/region before passing it to the stack. Retain the validation CNAME for ACM renewal; do not remove it during application rollback.

**2. Application alias follows release acceptance.** Complete migration exit-status checks, web/worker startup, private queue TLS/auth/progress, configured production WorkOS/R2/provider checks, tenant isolation, backup/restore and rollback evidence first. Retain a nonsecret, reviewed release-acceptance record containing image/task-definition identities and these outcomes. `--accept-release` takes its SHA-256 as an explicit operator acknowledgment; the tool does not read/validate that record and the hash is not independent proof of provider acceptance.

The application phase additionally requires an issued certificate valid for more than 24 hours; the actual named `admitflow-prod-alb` must be an active internet-facing application ALB in the expected account/region, with HTTPS 443 using that certificate. Its named web target group must belong to that ALB and all registered targets must be healthy. Both exact web/worker ECS services must have nonzero stable completed deployments. Direct HTTPS checks connect to the returned ALB DNS name with application SNI/Host, normal certificate verification, and bounded `/api/health` and hosted `/api/ready` JSON checks before publishing an alias. These checks do not prove worker progress or external-provider readiness.

```powershell
# Hash only the already-reviewed, nonsecret acceptance record; retain the record alongside release evidence.
$acceptanceHash = (Get-FileHash -Algorithm SHA256 $env:ADMITFLOW_RELEASE_ACCEPTANCE_FILE).Hash.ToLowerInvariant()
node scripts/release-dns.mjs --profile $env:ADMITFLOW_DNS_PROFILE --phase application --certificate-arn $env:ADMITFLOW_CERTIFICATE_ARN --accept-release $acceptanceHash --plan .data/dns-application.json
# Review this new plan independently before continuing.
$reviewedFingerprint = Read-Host 'Paste the independently reviewed application plan SHA-256'
node scripts/release-dns.mjs --profile $env:ADMITFLOW_DNS_PROFILE --phase application --certificate-arn $env:ADMITFLOW_CERTIFICATE_ARN --accept-release $acceptanceHash --plan .data/dns-application.json --apply --confirm $reviewedFingerprint
```

The IPv4 baseline permits only an A alias for the exact application name, using the actual ALB canonical hosted-zone ID and DNS name with target-health evaluation. AAAA is included only when AWS reports `dualstack`; that mode derives the documented `dualstack.` prefix from the verified ALB DNS name for both aliases. IPv6-only mode is not supported by this release contract. Any conflicting app record, including stale AAAA on an IPv4 ALB, blocks rather than being overwritten. Existing apex/site/mail and unrelated subdomains are preserved; only their inventory digest is stored, not their record contents.

**Submission, verification and recovery:** an INSYNC result means Route53 accepted/propagated the change, not that public DNS, TLS, authentication or the whole release is ready. The tool separately compares resolver-visible CNAME/alias addresses and performs public TLS/health/readiness checks. Validation output explicitly leaves certificate issuance unchecked. DNS verification uses the machine's configured recursive resolver; it is not worldwide propagation evidence. ALB address rotation/caching may conservatively report UNVERIFIED even with a correct alias. Independently verify authoritative delegation, multiple public resolvers, TLS and the user-facing release flows. Exit 2 means submission remains pending or public verification is unverified; it must not be treated as a failed write suitable for blind replay.

The Route53 wait is bounded to 60 polls with five-second intervals plus bounded API latency. A write timeout, missing change ID or polling failure can leave an uncertain applied change: inspect actual records/change status under the same scoped operator before generating a new plan. Never retry mutation blindly. A fresh no-op plan can recheck public DNS/TLS after propagation. Records/targets are checked again on apply, but Route53 provides no compare-and-swap for the whole zone: serialize DNS operators and deployments through review/apply, and retain the submitted change ID. CREATE conflicts protect existing same-type records; concurrent changes to other record types or delegation cannot be made atomically conditional. An acknowledgment/hash is an operator safeguard, not a security boundary against someone who can edit this script or assume broader IAM permissions.

Offline coverage: `infra/tests/release-dns.test.ts` uses only injected AWS/network mocks and is included by existing `test:infra` and isolated `verify` globs. `node scripts/release-dns.mjs --help` and `node --check scripts/release-dns.mjs` do not contact providers. Do not run ordinary preview/apply as an offline test. No extra dependency, package-script or workflow change is required.

References: [Route53 paginated record inventory](https://docs.aws.amazon.com/cli/latest/reference/route53/list-resource-record-sets.html), [ACM certificate metadata](https://docs.aws.amazon.com/cli/latest/reference/acm/describe-certificate.html), [ELB alias and dualstack behavior](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-to-elb-load-balancer.html).

Required CloudFormation inputs:

| Parameter | Value |
| --- | --- |
| `DomainName` | Application FQDN, without scheme/path |
| `CertificateArn` | Existing issued ACM ARN in the stack region |
| `AppSecretArn` | Complete existing JSON secret ARN, including its six-character suffix |
| `WebImageDigest`, `WorkerImageDigest` | `sha256:...` digests in the output ECR repository |
| `MetaAppId`, `MetaConfigId` | Public values matching the web build; may be empty during unconnected staging |
| `MetaApiVersion` | Defaults to the source's `v23.0`; use the reviewed supported Meta version |
| `KnowledgeVectorEnabled` | `false` by default; optional vector indexing/retrieval after its migration is ready |
| `WebDesiredCount`, `WorkerDesiredCount` | Both zero during bootstrap/cutover; baseline one each afterwards |
| `CacheNodeType` | Defaults to `cache.t4g.small`; choose from supported regional node types |

Contexts are `stage`, `region`, `highAvailability=true`, optional `appSecretKmsKeyArn`, and optional `alarmTopicArn`. Production additionally requires the exact `account`, `deployRoleArn`, `cloudFormationExecutionRoleArn` contract and actual verified `tenantKeyArn` above. The tenant key ARN is synthesis context, not a CloudFormation parameter. Nonproduction synthesis is an offline fixture and rejects deployment account/role and tenant-key inputs; it retains its fixture-created key. A separately reviewed staging deployment design is required before provisioning staging resources. Keep environments' databases, secrets, buckets and provider configurations separate.

### Schema migrations

```powershell
node --import tsx scripts/migrate.ts --dry-run
# DATABASE_URL_UNPOOLED comes from the secure environment or .env.local.
node --import tsx scripts/migrate.ts
```

`scripts/migrate.ts` uses Drizzle's PostgreSQL migrator and `drizzle/meta/_journal.json`, not a hardcoded table count or a filename loop. It requires the direct URL, rejects a Neon pooler hostname, takes a session advisory lock, checks already-applied timestamps/hashes against the release, applies pending SQL, verifies history again, and closes its connection. It rejects edited history and a database newer than the release. It uses five-minute statement and ten-second lock timeouts; review long-running data/index migrations separately. `.env.local` loading does not override an injected environment value.

For ECS, use `MigrationTaskDefinitionArn`, `ClusterName`, `TaskSubnetIds`, and `MigrationSecurityGroupId` from stack outputs. Launch as Fargate with `awsvpcConfiguration`, the output public subnets, the migration security group and `assignPublicIp=ENABLED`. Wait for `STOPPED`, inspect the migration container's exit code, and read `/admitflow/<stage>/migration`. Migration tasks need internet egress to Neon and AWS image/log/secret endpoints; they are not placed in the isolated cache subnets.

### Subscription rollout and recovery

Apply the complete 14-entry journal through `0013_event_receipt_rls.sql` before starting new readers/writers, including native timestamp conversion, intake retention and forced receipt RLS. Snapshots are included; SQL owns custom constraints, triggers and RLS. This is not a safe mixed-policy deployment: stop/drain old web, worker and cron dispatchers before enabling the release, and use the tenant-paged payment worker described in [receipt RLS rollout](#receipt-rls-rollout). An older version can bypass restrictions or acknowledge intake without durable retention. Do not roll back to it merely because it can read the schema.

- Trial identity is the immutable WorkOS organization ID, not a workspace row or browser field. New hosted provisioning grants exactly 168 elapsed hours once. Migration grants the same interval from one migration timestamp only to eligible unlinked legacy trial institutes without recorded billing history; linked/history-bearing/ambiguous institutes receive no new grant. Review mappings and eligibility in staging before applying. Creating a different WorkOS organization is a separate anti-abuse boundary.
- Preserve `institute_trials` independently of workspace backups/imports. Workspace deletion does not remove this ledger; its trigger prevents grant resets, unconsumption and ordinary row deletion. Restoring a pre-grant or pre-consumption backup is not permission to issue another trial. Reconcile grants/consumption with retained history while writers are stopped; ordinary SQLite aggregate imports are not a ledger restoration mechanism.
- Active permission requires verified provider status, verification freshness under five minutes and a future current billing-period end. Charge dates and checkout return URLs do not prove paid coverage. Persisted past-due/terminal states restrict immediately; stale/malformed/unavailable verification fails closed for paid work. Billing and authorized existing-data/safety work remain available.
- Supply both services with the shared billing key/plan selectors before startup. Worker reconciliation runs independently every 60 seconds in bounded organization-route pages (default 10, maximum 20), in addition to paid-action freshness checks. This is not a guarantee that every institute is polled every minute. Monitor `Subscription reconciliation failures` and `Subscription reconciliation unavailable`. Basic readiness does not validate optional billing credentials or provider connectivity.
- Billing recovery does not automatically restart blocked old AI/campaign work. Review current consent, ownership, inbound turn and provider uncertainty before explicit retry/new scheduling. A provider request authorized and dispatched before cancellation cannot be recalled; never resend an uncertain operation.
- Owners/admins review **Settings → Billing → Deferred enquiries** after access returns. Each explicit import handles up to 25 events, not necessarily 25 new enquiries; it rechecks connection identity, entitlement and quotas transactionally and creates no automated replies/campaigns. Connection-mismatched events remain retained; restore the verified original connection or arrange separately reviewed reconciliation, never rewrite receipt bindings to force import. Use **Review from beginning** for retained earlier entries after resolving their blocker.
- `intake_inbox` contains validated WhatsApp events/fetched Meta forms, bounded to 128 KiB per payload. Migration `0011_intake_retention.sql` establishes a 30-elapsed-day receipt deadline, shortened to seven elapsed days after import when earlier. Readers/importers enforce the deadline even if cleanup is unavailable; expired unimported content cannot be recovered. Cleanup sets raw payloads to NULL and keeps receipt IDs/digests, original timestamps, provider/tenant bindings and keyed contact safety holds. Imported CRM leads/messages have a separate lifecycle. Never delete receipts or lift expired holds merely to clear a backlog; tenant deletion remains a separate cascade.

### Intake retention operations and backup restore

Stop/drain older web, worker and cron writers before applying the complete release journal, including `0010_native_instants.sql`, `0011_intake_retention.sql`, `0012_whatsapp_subscription_operations.sql` and `0013_event_receipt_rls.sql`. Native instant preflight rejects invalid legacy values without rewriting them; investigate safe table/column counts in an isolated migration rehearsal. Do not round timestamps or fabricate history to pass migration. Existing receipt digests/expiry are backfilled before erasure. Live intake remains gated on a populated upgrade rehearsal, completed legacy-contact backfill, finite backup settings and a successful scrubbed restore rehearsal.

Both web and worker require `INTAKE_CONTACT_KEYS`, a secret string containing a JSON array of one to four distinct base64-encoded 32-byte cryptographically random keys. Generate/store these through secret management, never in repository files, logs or chat. The first key signs new tenant-scoped contact digests. Rotation prepends a new key while retaining all referenced historical keys; replace both services together. Existing keyed receipts are immutable and cannot be rekeyed after raw contact erasure. Do not drop a referenced key; missing versions fail closed for held contacts. The four-key bound is not permission to discard older references: arrange separately reviewed lifecycle work before exceeding it. Legacy clear-text contact keys have a transitional read path and must be converted before cutover.

The worker runs one non-overlapping sweep per minute, at most ten tenant pages per sweep and 100 receipts plus 100 redundant Meta metadata events per tenant. This is not a promise of per-tenant minute-level erasure; capacity and backlog age must be monitored. Tenant locks serialize cleanup with imports/replays. `Intake retention failures` and `Intake retention unavailable` require investigation. Expiry blocks use regardless of sweep lag; erasure from storage follows successful cleanup. Only intake-related Meta event copies are cleared, not payment, access or provisioning ledgers.

Use the runtime role and securely injected configuration for the operator command:

```sh
npm run intake:retention -- --workspace <UUID>
npm run intake:retention -- --workspace <UUID> --limit 500 --apply
```

Default inspection prints counts and a workspace ID only; `--apply` irreversibly scrubs a bounded page and upgrades legacy contact keys. Repeat inspection/apply for every tenant until `expiredPayloads`, `legacyContactKeys` and `expiredMetadata` are zero. `expiredHolds` intentionally remains nonzero when unresolved history exists; it is not permission to restart automation. The worker image includes `node dist/intake-retention.mjs` for the same operation. Do not use the schema-only migration task for keyed backfill: it deliberately lacks runtime secrets.

Application redaction does **not** erase old database backups, branches, exports or snapshots. Before live intake, record and approve a finite Neon recovery window and the deletion/lifecycle settings for every backup/export copy; no provider backup retention has been verified by this implementation. Restrict backup access, expire obsolete branches/copies and preserve required key versions in protected secret recovery. On restore, keep web/worker/cron and provider callbacks stopped; apply the current journal, restore required keys, run bounded scrubbing for every tenant, verify zero expired raw payloads and legacy keys, and separately reconcile payment/provisioning/dispatch evidence before starting services. A pre-erasure backup must never become an unsanitized live rollback target.

Production Next responses add host-only `Strict-Transport-Security: max-age=86400`. Validate HTTPS and the issued certificate on the actual hostname before serving that release. No `includeSubDomains` or preload policy is enabled; local development has no HSTS header.

Rehearse legacy upgrade, new provisioning, restore, provider outage, late callback and cancellation/dispatch orderings with the intended Neon roles and provider accounts. Local PGlite, mocked providers and offline secret-selector checks do not establish those deployment results.

### Organization provisioning recovery

Migration `0008_org_provisioning.sql` adds the durable, actor/WorkOS-client-scoped ledger with forced RLS and immutable request/history constraints. Preserve it through backup/restore, independently of tenant workspace data. Drain old unfenced onboarding writers before rollout; restoring a database does not rewind WorkOS.

- Onboarding **Check status** reconciles positive evidence without repeating dispatched writes. Organization identity must match the server-owned external ID and operation/actor/client metadata. Membership confirmation requires the exact actor/organization and a single active owner membership, including the recorded membership ID when known.
- A confirmed organization may proceed to the first owner-membership dispatch. Once organization or membership dispatch is recorded, absence, timeout, explicit failure or elapsed time never grants another dispatch. A crash between the marker and network call can intentionally leave setup blocked.
- Mismatched identity/membership evidence sets a sticky review flag, even if another request concurrently advances the phase. Later successful reads cannot clear that flag. Do not rename/rebind the operation, reactivate an inactive membership, reset dispatch markers or delete ledger rows.
- **Open institute** separately refreshes the session after revalidating ownership. Session failure is not creation failure: retry Open or sign in again. Explicit acknowledgement of verified completion is required before another create intent; it is not an operator reset.
- There is no operator-clear CLI. For unresolved/review-required outcomes, preserve nonsecret operation identifiers and evidence, quiesce all old/current writers that could resume, inspect the exact WorkOS organization and all membership statuses, and obtain a separately reviewed reconciliation. Missing objects are not proof that a write never occurred. Never publish credentials or raw provider payloads in the incident record.

### Connection and intake recovery

Migration `0009_connection_binding.sql` enforces a tenant/connection/service/provider-identity composite foreign key for intake and requires disconnected rows to have no secret. It retains organization-deletion cascades but prevents deleting or rebinding a referenced connection. An orphaned legacy receipt makes the migration fail transactionally; stop rollout, preserve the receipt and investigate original identity. Never fabricate a connection, rewrite a receipt or delete intake to make migration pass.

- Disconnect retains UUID/provider identity and deferred/imported receipts and removes stored credentials and active routing. Pending WhatsApp subscription routing and durable operation evidence are preserved; signed callbacks on a pending route return retryable 503. OpenAI/ElevenLabs retain an institute opt-out from platform credentials, and every explicit non-connected state denies fallback.
- Reconnect only after verifying the original WhatsApp phone-number/Business Account or Meta Page. Different-account transfer is not implemented. WhatsApp **Check subscription** reconciles positive evidence without replaying the write or activating the connection; deliberate reconnect separately revalidates access and current intent. See the [WhatsApp recovery runbook](whatsapp-provider-review.md).
- Verification captures the connection version before provider calls and checks it inside serialized persistence. WhatsApp also uses a durable revision/operation fence, including disconnect during first-time setup; late success may preserve provider evidence but cannot activate stale intent. Refresh rather than blindly replaying stale responses.
- Disconnect is not credential revocation, provider unsubscription or recall of dispatched operations. A recorded WhatsApp subscription dispatch is never automatically repeated after uncertainty, restart or elapsed time. Other absent non-AI/speech rows do not cancel first-time setup. Revoke compromised credentials through the provider separately.
- After reconnect and entitlement recovery, explicitly import still-unexpired retained batches; no automatic campaigns/replies are scheduled. The approved 30-day/seven-day retention policy is implemented, but live activation still requires the [migration, key-backfill and backup/restore gates](#intake-retention-operations-and-backup-restore). Never delete receipt identities or safety holds to force recovery.

## SQLite importer

### Rehearsal

The importer targets the local `workspaces(id, data)` JSON aggregate and inventories registration references from `users(email, workspace_id)`. It never queries password hashes or session tokens. A **full SQLite backup** does contain the original authentication tables, so keep the backup/report directory private. New directories/files use owner-only modes where supported; use equivalent inherited ACLs on Windows.

```powershell
Test-Path -LiteralPath "H:\new-app\.data" -PathType Container
node --import tsx scripts/migrate-sqlite.ts --source .data/admitflow.sqlite
# After preparing real identity mappings in a private file:
node --import tsx scripts/migrate-sqlite.ts --source .data/admitflow.sqlite --mapping .data/workos-mapping.json
```

**Default behavior is backup + offline dry run.** `--dry-run` is optional. Each run creates a new `.data/migration-backups/import-*/snapshot.sqlite` and `report.json`; `--backup-dir` changes that parent. It opens the source read-only, uses Node's SQLite backup API so committed WAL content is included, checks the backup's integrity, calculates SHA-256, and reads the frozen backup. It never creates an empty source database or overwrites an old backup. Dry runs do not connect to PostgreSQL, WorkOS, AWS or other providers.

The report classifies demo/registered/unregistered workspaces, records counts and exact INR totals in integer-paise strings, lists unresolved owner labels, duplicate normalized phones, invalid IDs/amounts and missing references. It excludes full aggregate content, passwords, sessions, provider credentials and message bodies. Demo workspaces are always excluded. Use repeated `--workspace UUID` options to import an explicit subset. Invalid/missing mappings produce a blocked report and a nonzero CLI exit.

### Explicit WorkOS mapping

Use `infra/workos-mapping.example.json` as the format guide; its placeholders intentionally cannot be applied. The private mapping file contains:

- Exact original `workspaceId`, existing `workosOrganizationId`, and the existing designated owner's `ownerWorkosUserId`.
- Each verified user's `workosUserId`, actual `workosMembershipId`, name, email, role and active/inactive status.
- `legacyMemberId` for **every already-persisted member record**, preserving that original ID. Omit only when the source genuinely has no member record; then the real WorkOS membership ID becomes the local member ID.
- `ownerLabels` identifying the legacy labels mapped to that member. Assignments receive the explicit immutable member ID and verified display name; names alone never create or claim identities.
- `legacyEmails` only when an explicitly reviewed old registration email differs from the verified WorkOS email.
- `historicalOwnerLabels` for retired/unassignable labels that should remain historical with null owner IDs and no invented membership. Use the literal `Unassigned` for already-unassigned records.

Each workspace maps to one distinct WorkOS organization. Every registered SQLite user needs a corresponding mapping. On `--apply`, read-only WorkOS API calls verify organization existence, user ID, verified email, display name, membership ID, organization, role and status before any database writes. Local password hashes are not assumed compatible with WorkOS; perform the supported identity migration or verified activation flow separately. All local sessions require reauthentication.

### Apply and recovery

Stop source writers, scheduled/cron dispatch and both target ECS services for the cutover. Apply the full reviewed Drizzle journal to the target first. Keep the Neon restore point and SQLite backup available.

```powershell
Test-Path -LiteralPath "H:\new-app\.data" -PathType Container
# Direct migration role and WORKOS_API_KEY are supplied securely, never as CLI arguments.
node --import tsx scripts/migrate-sqlite.ts --source .data/admitflow.sqlite --mapping .data/workos-mapping.json --apply
```

Apply uses the existing `db/client` and `db/repository` exports. It takes the same global migration lock, validates the applied Drizzle history, requires cross-tenant visibility for collision checks, preflights the entire selection, and creates each workspace in its repository transaction. It does not overwrite an existing tenant or silently merge IDs. After every commit it reloads and compares a canonical fingerprint of persisted IDs, fields, relationships, timestamps and money, and checkpoints the report.

Intentional transformations are recorded in the report:

- Receipt/refund amounts are converted from rupees to **exact paise**, with no fractional-paise rounding. Amounts exceeding the current PostgreSQL `integer` range are blocked for a reviewed schema change. Aggregate totals use `BigInt`. Current `leads.value` remains integer rupees because that is its existing schema contract.
- Receipt references are uppercased by the existing repository; case-insensitive duplicates are blocked.
- Sequence execution and AI replies are paused; active campaigns become paused; pending/processing jobs and queued outbound messages become `reconcile`. Original IDs/timestamps/history remain in the backup. Provider state must be reviewed before explicitly resuming any work.
- WorkOS membership projections and owner-ID assignments follow the reviewed mapping. Existing member IDs are preserved. Derived knowledge indexes/chunks can be regenerated by the repository; they did not exist in the original aggregate.
- Session/response projections are omitted. File metadata is imported only with its existing object keys; this command does not upload/copy R2 file bytes. Validate those objects in the intended private bucket before cutover.
- Workspaces carrying stored provider ciphertext are blocked for a separate reviewed rekey/reconnect migration, rather than silently importing credentials that the destination key cannot decrypt.

Imports are **atomic per workspace, not across the entire selection**. If a later workspace fails, keep services stopped and inspect the checkpoint report. A rerun with `--apply --resume` skips only already-imported workspaces whose full persisted fingerprint and WorkOS route match the frozen input and mapping. It refuses changed tenants, different routes or colliding record IDs; there is no force-overwrite option. Use an unchanged source/backup and mapping for recovery.

Before switching traffic, compare counts, receipt/refund/net totals, campaign membership, appointments/timestamps, original IDs and explicit staff assignments. Rehearse with a separate Neon branch and real staging WorkOS organizations. Take the final backup after the write freeze: an online rehearsal backup alone does not define a cutover point.

## Operations and rollback

- `/api/health` is now cheap process liveness with `Cache-Control: no-store`; ALB/container probes intentionally remain on it. ECS also replaces ALB-unhealthy tasks, so wiring transient database failures into that probe can create restart churn.
- `/api/ready` reports only generic ready/not-ready and local/hosted mode, with HTTP 200/503 and no-store. Hosted readiness validates required web configuration and uses a bounded `select 1` through a separate max-one-connection pool, with single-flight probing and a five-second cache. Budget up to one extra database connection per web process. Release/dependency monitoring must check readiness separately; it does not probe WorkOS, queue, KMS, R2 or payment providers.
- `npm run preflight -- --role web` (also `worker` or `migration`) validates configuration without network calls and prints variable names/reasons, never values. It quietly loads `.env.local` without overriding injected values. Successful configuration checks do not verify credentials, grants, schema, key access or provider connectivity.
- CloudWatch alarm resources exist without subscribers by default. Pass an existing `alarmTopicArn` and configure its delivery/subscriptions for actual alert notifications. Monitor worker logs and sustained outbox delay as well as CPU and queue memory. Basic ECS metrics do not prove progress of every job.
- Deploy backward-compatible expand/contract schema changes. Roll back application task definitions to the previous **recorded image digests** only when compatible with the current schema. The migration runner deliberately has no automatic down-migration or history rewrite.
- For a database restore, stop dispatch first. Neon restore/history availability depends on the chosen plan. A database restore does not rewind WorkOS, R2, provider delivery, payments or KMS key state. Reconcile those systems and held/ambiguous jobs before restarting the worker.
- Preserve the tenant KMS key and necessary historical key access. Losing it makes encrypted tenant credentials in restored Neon data unreadable. Do not delete retained resources as a substitute for a reviewed rollback.
- If returning to SQLite, use the defined pre-cutover write boundary and its coherent backup. Once production accepts new writes, reverting to an old SQLite snapshot requires reconciliation of that delta rather than merely changing a connection URL.

### Team access recovery

Hosted team changes use the existing `event_receipts` row `team:access:<workspace UUID>`, provider `workos_access`; no migration is added. Random tokens fence actual auth/team projections and invitation/seat callbacks. Access transactions hold the organization lock only for local validation/persistence, not during WorkOS calls. The application WorkOS client explicitly disables SDK retries and uses a 15-second fetch timeout; aborting a fetch does not undo an external write or bound remote processing.

- `prepared` means no write has been dispatched under that phase; its 120-second lease can be replaced. Late holders cannot dispatch or project using the replaced token.
- `dispatched` records the intended membership/invitation postcondition before invocation. It never expires into another write. Competing team operations receive 409; the target of a membership change cannot authenticate during uncertainty.
- After 120 seconds an unaffected, still-authorized administrator can refresh Team (`GET /api/team`). Exact tenant-bound positive evidence confirms the result and rotates the token before projection and invitation/seat reconciliation. Recovery performs provider reads, not another access write or invitation email. Missing, unchanged or foreign evidence leaves the gate closed.
- Once invocation begins, transport failures and explicit provider rejections conservatively retain the intent. If the result cannot meet its recorded postcondition (including a later terminal invitation state), preserve the receipt and related invitation/seat records. Record only nonsecret operation identifiers in the incident record; do not expose raw tenant payloads or tokens in support logs.
- There is **no operator-clear CLI**. A stuck gate needs a separately reviewed reconciliation: verify the exact institute/provider identities and outcome, quiesce every original/old application writer so it cannot resume, and preserve current receipt evidence before any approved repair. Do not delete receipts, infer failure from absence, resend the operation or bypass the gate to restore availability. If no unaffected administrator can authenticate, escalate rather than weakening auth checks.

Before rollout or rollback, drain/remove all application versions that do not participate in this gate; mixed fenced/unfenced writers invalidate serialization. Preserve access, invitation and seat receipts through backup/restore. Database restore cannot rewind WorkOS state and may resurrect old intent, so keep writers stopped until provider state is reconciled. Direct WorkOS console changes are outside application serialization. Validate multi-replica locking, provider read consistency, late responses and recovery in staging before production acceptance.

### Admission-payment recovery

This admission-money path passed local/mock-provider regressions on 17 September; real merchant delivery/recovery remains unvalidated. It is separate from SaaS subscriptions. Configure the institute's signed `/api/webhooks/razorpay/<workspace UUID>` endpoint for `payment.captured` and `refund.processed`. It requires hosted PostgreSQL and a connected tenant merchant with a webhook secret. HTTP 200 means a supported event was durably queued (or an unsupported signed event was ignored), not that financial reconciliation completed. Persistence/configuration failures return 503 with `Retry-After`; malformed/signature/oversized bodies return 400/403/413.

The worker checks every 15 seconds and starts a recovery tick only when the previous tick has finished. Each tick visits up to ten tenants and selects up to two due receipts per tenant, with a 120-second claim lease. Its tenant cursor advances past empty/failing tenants and wraps to revisit capped backlogs. Attempts are bounded at eight; retry delay starts at 30 seconds and caps at one hour. Exhausted or invalid receipts are retained for operators. Monitor safe `Payment recovery`, `Payment recovery tenant failures`, `Payment reconciliation failed` and `Payment recovery dispatch failed` logs and pending/failed receipt state; configured alarms need subscribers.

Using an explicitly authorized runtime environment, inspect without provider calls:

```sh
npm run payments:inspect -- --workspace <workspace-uuid>
```

Inspection returns up to 50 oldest unprocessed receipt IDs, timestamps, attempts and safe status/errors. It is a bounded operator view, not a complete backlog export. After checking the exact tenant, merchant, provider payment/refund identity and attribution, explicitly replay one receipt:

```sh
npm run payments:inspect -- --workspace <workspace-uuid> --receipt <receipt-id> --apply
```

Replay performs authoritative provider GETs and local financial writes; it does not charge or refund through the provider. The command loads `.env.local` and closes its database pool on completion. Never run it as part of offline verification. Built equivalents use `node dist/payments.mjs` with the same arguments. An active lease blocks replay; `skipped` is not proof that a pending receipt has completed, so inspect state again if necessary.

A changed connection ID or merchant key-ID fingerprint is not rebound by replay. Keep the receipt, verify the original merchant's outcome and arrange a separately reviewed reconciliation; do not edit fingerprints or restore compromised credentials merely to force a retry. A same-key-ID secret refresh can retry with fresh credentials after the connection is stable. Financial commit precedes receipt completion, so a crash can leave already-posted money with a pending receipt. Provider-ID replay, rollback and stale-claim tests passed locally; configured-merchant recovery still needs a staging rehearsal.

Before rollback, preserve event receipts, financial rows, provider IDs and KMS access. An older worker cannot drain this new inbox, and an older webhook may acknowledge events without durable capture. Do not roll back into that behavior unnoticed; establish a reviewed provider-redelivery/recovery procedure before switching versions. Database restore does not undo external payments or refunds. Never delete pending receipts to make monitoring green.

Credential-looking `DATABASE_URL` and `WORKOS_API_KEY` entries were cleared from `.env.example`. If they were real, rotate them at their providers; template cleanup is not credential rotation.

Docker image execution, AWS deployment, TLS/DNS, WorkOS/Meta/R2/Neon credentials and cross-provider restore drills must be verified in their configured environments; offline synth and fixture tests do not establish those results.
