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

`infra/app.ts` synthesizes `AdmitFlow-staging` by default. It does not look up accounts, networks, certificates or secrets, and does not build Docker images during synthesis. `infra/stack.ts` defines:

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
| KMS | Retained, rotation-enabled tenant credential key | Web/worker task roles can encrypt/decrypt. The application supplies `organizationId` as the encryption context. Preserve the key with Neon backups. |
| Logs/alarms | 30-day web, worker, migration and Valkey engine log groups | CPU/memory, unhealthy targets, target 5xx, worker failures, queue memory and eviction alarms. Optional existing SNS topic for notification delivery. |

For a more resilient deployment, synthesize/deploy with `-c highAvailability=true`: the default web count becomes two and Valkey gains a replica with Multi-AZ automatic failover. The worker still defaults to one. The baseline does not configure autoscaling, Fargate Spot, Container Insights, NAT gateways, VPC endpoints or an application S3 bucket. Files stay in **R2**. CDK's own bootstrap assets, if used by the deployment environment, are infrastructure artifacts rather than application file storage.

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

## Images and release procedure

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

1. Set up the intended AWS deployment identity, CDK bootstrap environment if required, Neon roles, private R2 bucket, WorkOS app, issued same-region ACM certificate and existing JSON application secret. These external setup operations are outside synthesis.
2. For a new stack, deploy with **both desired counts zero** to create ECR and infrastructure before images exist. The digest parameters still require a syntactically valid `sha256:<64 hex characters>` placeholder; no image is pulled with zero tasks. Supply real digests before increasing counts.
3. Build web/worker for Linux amd64, authenticate Docker to the output ECR repository using the release identity, tag each image with a unique immutable release tag, push, and resolve its digest. Keep the public build configuration with the release manifest. Do not push from this offline implementation environment.
4. Update CloudFormation with the real `WebImageDigest` and `WorkerImageDigest`, keeping counts at zero for initial migration/cutover. Review IAM/network changes and the image scan in the release environment.
5. Run the one-off migration task or the local migration command with the direct migration role. Wait for task completion and check its exit code/log stream before starting services. A successful `ecs run-task` response only means the task was submitted.
6. If migrating SQLite, complete the rehearsal/cutover below while source and target application writers are stopped.
7. Run configuration preflight for each role, start web, verify the configured hostname, `/api/health` and `/api/ready`, authenticate with WorkOS, and exercise tenant boundaries and private R2 uploads. Start worker after reviewing held/reconciliation work and confirming provider configuration. Readiness is not a substitute for these live integration checks.
8. Point the application DNS record at `LoadBalancerDnsName` (or an ALIAS using the output hosted-zone ID). Ensure the application origin, WorkOS callback and provider URLs agree. For SSE, send heartbeats more frequently than the ALB idle timeout.

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

Contexts are `stage`, `region`, `highAvailability=true`, optional `appSecretKmsKeyArn`, and optional `alarmTopicArn`. Staging and production should use separate stacks, databases/branches, secrets, buckets and provider configurations.

### Schema migrations

```powershell
node --import tsx scripts/migrate.ts --dry-run
# DATABASE_URL_UNPOOLED comes from the secure environment or .env.local.
node --import tsx scripts/migrate.ts
```

`scripts/migrate.ts` uses Drizzle's PostgreSQL migrator and `drizzle/meta/_journal.json`, not a hardcoded table count or a filename loop. It requires the direct URL, rejects a Neon pooler hostname, takes a session advisory lock, checks already-applied timestamps/hashes against the release, applies pending SQL, verifies history again, and closes its connection. It rejects edited history and a database newer than the release. It uses five-minute statement and ten-second lock timeouts; review long-running data/index migrations separately. `.env.local` loading does not override an injected environment value.

For ECS, use `MigrationTaskDefinitionArn`, `ClusterName`, `TaskSubnetIds`, and `MigrationSecurityGroupId` from stack outputs. Launch as Fargate with `awsvpcConfiguration`, the output public subnets, the migration security group and `assignPublicIp=ENABLED`. Wait for `STOPPED`, inspect the migration container's exit code, and read `/admitflow/<stage>/migration`. Migration tasks need internet egress to Neon and AWS image/log/secret endpoints; they are not placed in the isolated cache subnets.

### Subscription rollout and recovery

Apply the complete eight-entry journal through `0006_subscription_trials.sql` and `0007_deferred_intake.sql` before starting the new readers/writers. Snapshots are included; SQL owns the custom constraints, triggers and RLS. This is an additive schema change but not a safe mixed-policy deployment: stop/drain old web, worker and cron dispatchers before enabling the new release. An older version can bypass restrictions or acknowledge intake without durable retention. Do not roll back to it merely because it can read the schema.

- Trial identity is the immutable WorkOS organization ID, not a workspace row or browser field. New hosted provisioning grants exactly 168 elapsed hours once. Migration grants the same interval from one migration timestamp only to eligible unlinked legacy trial institutes without recorded billing history; linked/history-bearing/ambiguous institutes receive no new grant. Review mappings and eligibility in staging before applying. Creating a different WorkOS organization is a separate anti-abuse boundary.
- Preserve `institute_trials` independently of workspace backups/imports. Workspace deletion does not remove this ledger; its trigger prevents grant resets, unconsumption and ordinary row deletion. Restoring a pre-grant or pre-consumption backup is not permission to issue another trial. Reconcile grants/consumption with retained history while writers are stopped; ordinary SQLite aggregate imports are not a ledger restoration mechanism.
- Active permission requires verified provider status, verification freshness under five minutes and a future current billing-period end. Charge dates and checkout return URLs do not prove paid coverage. Persisted past-due/terminal states restrict immediately; stale/malformed/unavailable verification fails closed for paid work. Billing and authorized existing-data/safety work remain available.
- Supply both services with the shared billing key/plan selectors before startup. Worker reconciliation runs independently every 60 seconds in bounded organization-route pages (default 10, maximum 20), in addition to paid-action freshness checks. This is not a guarantee that every institute is polled every minute. Monitor `Subscription reconciliation failures` and `Subscription reconciliation unavailable`. Basic readiness does not validate optional billing credentials or provider connectivity.
- Billing recovery does not automatically restart blocked old AI/campaign work. Review current consent, ownership, inbound turn and provider uncertainty before explicit retry/new scheduling. A provider request authorized and dispatched before cancellation cannot be recalled; never resend an uncertain operation.
- Owners/admins review **Settings → Billing → Deferred enquiries** after access returns. Each explicit import handles up to 25 events, not necessarily 25 new enquiries; it rechecks connection identity, entitlement and quotas transactionally and creates no automated replies/campaigns. Connection-mismatched events remain retained; restore the verified original connection or arrange separately reviewed reconciliation, never rewrite receipt bindings to force import. Use **Review from beginning** for retained earlier entries after resolving their blocker.
- `intake_inbox` contains sensitive validated WhatsApp events/fetched Meta forms, bounded to 128 KiB per database payload. Preserve receipt IDs, payloads, timestamps, state and provider/tenant bindings with workspace data on backup/restore. Retain imported receipts too for deduplication. No automatic retention/deletion job or inbox-delete API is implemented; storage/privacy retention requires a reviewed operational policy. Tenant deletion cascades intake rows, unlike the retained trial ledger. Do not delete receipts to clear a backlog; reconcile provider state before restoring dispatch.

Rehearse legacy upgrade, new provisioning, restore, provider outage, late callback and cancellation/dispatch orderings with the intended Neon roles and provider accounts. Local PGlite, mocked providers and offline secret-selector checks do not establish those deployment results.

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

The worker independently selects two due receipts every 15 seconds, with a 120-second claim lease. Attempts are bounded at eight; retry delay starts at 30 seconds and caps at one hour. Exhausted or invalid receipts are retained for operators. Monitor safe `Payment recovery`, `Payment reconciliation failed` and `Payment recovery dispatch failed` logs and pending/failed receipt state; configured alarms need subscribers.

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
