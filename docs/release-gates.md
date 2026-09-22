# First-release gates — 22 September 2026

**Status: not deployed.** This is the dated operational addendum to [deployment](deployment.md) and [scoped IAM bootstrap](../infra/iam/README.md). It supersedes their historical readiness statements and original human-operator prerequisite only where explicitly noted below. It does not change tool behavior, grant permissions or authorize a build, migration, merge or DNS write.

Target: AWS account `543777713748`, Singapore `ap-southeast-1`, stack `AdmitFlow-prod`, domain `admitflow.incfrog.ai`, Route53 zone `Z07524403BCACLCZ72JOD`. Refresh identity and relevant resource inventories before mutations; the observations below are a dated snapshot, not continuing proof of state.

## Completed evidence — do not repeat provisioning

- **Authentication correction:** hosted settings/onboarding now use a POST server action with a required, exact public Origin and a fixed `/onboarding` return destination. GET logout is removed; local settings retain `/api/auth` POST logout. Callback `baseURL` is resolved from `APP_BASE_URL` at request time, not the container hostname or build environment. Missing hosted configuration fails closed without SQLite fallback.
- **Local validation:** `npm run verify` exited 0 with 311 application tests, infrastructure/IAM checks, typechecks, Next/service builds and the 14-migration dry run. All 45 browser tests passed with exit 0. Initial typechecking failed on two stale generated Next validators referencing the deleted route; after clearing those generated files, full verification passed. This was not a source-code type error or an ignored failure. There is no application lint script.
- **Standalone probe:** credential-free production-build HTTP checks confirmed GET/HEAD `/logout` return 404 without cookie mutation. Both `/settings` and `/onboarding` reject foreign-origin action requests; matching-origin requests reach the unconfigured-hosted-auth guard. Expected rejection responses are 500, not successful sign-outs. The temporary server was stopped. Mocked callback tests prove wiring, not a live token exchange.
- **Neon:** production branch `br-winter-water-b3tlwo5r` in project `curly-mud-84217323` is protected; history is seven days; endpoint/default compute is 0.25–1 CU with existing idle-suspension setting preserved. Runtime and migration-role TLS authentication was checked. Two disposable branches exercised all 14 migrations, PITR, journal hashes and tenant RLS/isolation; both were deleted. Production still has no application schema/journal entries. This is not a populated-tenant retention-scrubbing or cross-provider recovery rehearsal.
- **R2:** signed synthetic upload, metadata, conditional copy, exact-byte download and allowed/foreign-origin CORS probes passed. All six synthetic objects across three attempts were deleted with absence verified. Unsigned S3-endpoint access returned HTTP 400; that is not independent proof that every public-access surface is disabled. Disabled r2.dev, no exposing custom domain and bucket-scoped credentials remain operator-attested. Application tenant authorization remains untested against production R2.
- **WorkOS:** dashboard readback confirms the corrected stored client matches production environment `environment_01KZ4546BAZRX9HNGAJ4611MAR` (`sandbox=false`), callback `https://admitflow.incfrog.ai/callback`, logout `https://admitflow.incfrog.ai/onboarding`, and member/admin/owner/counsellor/analyst roles. API-key acceptance and dashboard client identity are separate checks, not proof of key/client pairing or successful login. CORS is empty; do not add origins without a demonstrated requirement for this server-side integration.
- **ACM:** issued certificate `arn:aws:acm:ap-southeast-1:543777713748:certificate/f27d4fea-0d5e-4a97-b2ef-2467c29e02a9`. Its validation CNAME matches Route53 and public resolvers. Keep that CNAME for renewal. Unrelated zone records were preserved; no application A/AAAA alias has been published.
- **AWS inventory:** no application stack, tenant-key alias, application secret, parameter group or queue was found. The observed AWS-managed ACM key is not a tenant-key reuse candidate. Do not infer that scoped CFN/workload prerequisites are installed.
- **Depot:** project `0xd1td4lmf` in organization `xsf8b0w7g9` is accessible. Allowance and GitHub OIDC setup are operator-attested, not independently read back. Paid image publishing remains disabled by `BUILDS_APPROVED=false`.

Protected operator evidence is outside Git under `%LOCALAPPDATA%\AdmitFlow\release\prod`: `neon-20260922-recovery-01.json`, `r2-ee2b4816-f58d-421d-a837-b8f6cc81edcb.json`, `elasticache-ParameterGroup-20260922.json` and `elasticache-ReplicationGroup-20260922.json`. These are local evidence references, not portable CI artifacts. Retain reviewed nonsecret copies/hashes in the release record without copying credentials or raw tenant data into Git.

## Gate 1 — publish and review this exact revision

Owner: release maintainer/reviewer.

The auth correction has local evidence, but has not been pushed or reviewed in CI. Draft [PR #2](https://github.com/Deepak8858/admitflow/pull/2) previously had four green checks and no unresolved review threads at `8b1574992107b5729aec7647b3680614083f631b`. Those results do not cover this correction. PR #1 was already merged; it is not the current release gate.

After separately authorized publication, record the new head SHA, inspect exact-head CI/security results and actionable external review findings, and merge only the reviewed revision with authorization. The manual publishing workflow requires successful **main-push CI for the exact merged commit**. Neither this documentation nor the local commit enables image publishing.

## Gate 2 — resolve scoped AWS provider behavior

Owner: infrastructure/security reviewer. **Blocking before application provisioning.**

`infra/iam/generate.mjs` permits candidate parameter-group prefix `admitflow-prod-cacheparameters-*` and snapshot prefix `admitflow-prod-queue-*`. Neither is a proven CloudFormation naming guarantee. The regional ParameterGroup schema says its physical name is read-only and declares tag-on-create; it does not establish actual generated names or authorization-time tag context. The ReplicationGroup delete schema includes snapshot creation. The advertised provider source was not retrievable.

Required clearance evidence:

1. Establish generated parameter-group and final-snapshot names, tagging at each relevant authorization step, and dependent-action coverage for create/update/delete/rollback. Explain each applicable permission versus the current policy; schema action lists alone do not establish actual calls.
2. Review `AddTagsToResource` on parameter groups in particular: the current policy requires existing application tags as well as request tags. A provider's separate post-create tagging call on an untagged group would fail. Do not solve this by granting unrestricted retagging.
3. Check service-linked-role requirements and IAM role cleanup. The IAM Role deletion schema does not list boundary removal, but that does not prove rollback succeeds. Keep boundary-removal denial intact.
4. Obtain IAM Access Analyzer validation, real positive/negative AWS simulations, missing-context review and effective identity/boundary/resource-policy analysis. Offline policy tests are not AWS authorization evidence. Explicitly review residual regional privileges, including task-definition deregistration and log-delivery operations.

If public evidence cannot resolve these points, submit a separate, narrowly scoped rehearsal or naming/lifecycle redesign for approval, including exact resources, cost ceiling, retained snapshots and cleanup. No alternative is approved yet. Do not broaden wildcard scope, remove request/resource-tag checks, drop snapshots, remove boundaries or bootstrap with AdministratorAccess to get a stack through.

## Temporary human-operator exception

The operator authorized short-lived, local root-operated first-release work while deferring compatible IAM-user MFA. This replaces only the human non-root prerequisite; it does not waive any other gate. Preserve the existing IAM deployer, credentials, passkey and MFA-gated trust policies. Do not weaken `aws:MultiFactorAuthPresent` or create root access keys.

Root credentials must never enter GitHub, Depot, images, containers, application secrets or logs. Root may submit an inspected compact inline CloudFormation template only with the explicit scoped execution role `arn:aws:iam::543777713748:role/admitflow/deployment/admitflow-prod-cfn-exec` and six workload boundaries. Root's own application scope is operational, not an IAM-enforced boundary. Review exact account, region, identifiers and requests before each mutation.

The IAM generator still describes the ordinary non-root bootstrap sequence. For root-operated tenant-key creation, separately review using the final account-delegation key policy from creation instead of adding an unnecessary temporary bootstrap grant. Keep lockout safety enabled, creation retries disabled, and persist the returned key ARN immediately. **CreateKey is not idempotent:** reconcile any uncertain response; never blindly recreate, replace or delete a key. Verify tags, rotation, alias and final policy; use that exact ARN in synthesis and boundaries.

**The DNS helper still rejects root/default profiles.** Do not modify it to accept them. Either finish the scoped non-root DNS path or separately review exact AWS CLI requests under the exception with equivalent inventory, conflict, acceptance, CREATE-only, propagation and TLS safeguards. Existing script checks are not automatically applied to direct CLI calls. End the root exception after first-release verification by completing and testing compatible MFA/scoped access; do not delete or weaken the existing setup as a shortcut.

## Gate 3 — prepare prerequisites and approve cost

Owner: deployment operator, after Gate 2 clearance.

- Re-inventory and reuse only verified resources. Prepare the exact application secret, tenant key/alias, six workload boundaries, scoped CFN role, narrowly scoped publisher/OIDC role, service-linked-role prerequisites and reviewed `admitflow-prod-valkey-logs` resource policy. Read back all changes; preserve unrelated policies and detach temporary setup permissions where used.
- Use the corrected encrypted application configuration, not the original `production.clixml` with the wrong WorkOS client. The corrected DPAPI file is `production-corrected-e41e632487ab4df78703d091938d3623.clixml` under `%LOCALAPPDATA%\AdmitFlow\credentials\application`. Do not print/export plaintext secrets into review artifacts. Verify all selected application-secret keys exist and securely generate any still-missing session, state or intake-contact keys.
- Confirm feature-specific credentials, scopes, webhook readiness, usage caps and monitoring for features enabled at launch. Keep optional, unverified providers/features disabled; basic readiness does not prove billing, messaging or speech readiness.
- Refresh AWS/Neon/R2/provider estimates, Depot allowance/cache policy and OIDC trust. Preserve the $200/month planning budget as an estimate, **not a hard spending cap**. Zero ECS tasks still leave ALB/Valkey and other infrastructure costs. No paid build or infrastructure execution is authorized merely by passing local tests.

Clearance record: actual resource ARNs, reviewed template/policy hashes, configuration-key presence (not values), identity, current cost approval and provider-check scope.

## Gates 4–6 — bootstrap, immutable images and migration

Owner: deployment operator/release maintainer.

1. After all prerequisite gates, create the inspected stack with **both desired counts zero**, the scoped CFN execution role and actual verified identifiers. Review events and rollback status; a submitted API request is not successful deployment. Do not run an ordinary CDK administrator bootstrap.
2. After separate publishing approval, configure exact ECR/publisher variables, verify main-only GitHub/Depot OIDC, and enable the manual workflow deliberately. Publish Linux amd64 web/worker images for the exact reviewed main SHA. Inspect scans, container smoke tests and the immutable digest pair/release manifest. Local Next standalone checks are not Docker image validation.
3. Apply real digests while counts remain zero. Verify public web build values match runtime domain/WorkOS callback. Preserve rollback tags and record task-definition revisions.
4. Refresh production branch identity, restore readiness and journal state before the authorized migration. Run the exact reviewed migration task revision with only its direct migration connection; wait for STOPPED, exit 0, log verification and complete journal/hash readback. Do not start services on submission success alone. Never auto-apply down migrations or rewrite history.
5. Only if SQLite import is actually required, perform the separately approved frozen-source backup/mapping/cutover procedure. Do not import preview/demo data by default. The completed empty-branch Neon rehearsal does not cover a populated legacy upgrade, key backfill or scrubbing restored tenant data.

## Gate 7 — service and authentication acceptance before public DNS

Owner: application operator/security reviewer.

- Run role-specific configuration preflight. Start web, confirm stable deployment and healthy ALB targets, then verify `/api/health` and hosted `/api/ready` through valid HTTPS using the production SNI/Host. Do not disable certificate verification. Arrange a reviewed operator-only name-resolution method for browser testing before public DNS publication; do not substitute a different callback/domain or prematurely publish the alias.
- Complete real WorkOS sign-in/token exchange with the production key/client, PKCE callback, secure session cookie and organization selection. Verify permitted/denied roles and cross-tenant access. Click sign-out from both hosted controls; confirm POST, cookie clearing and WorkOS session termination/return. GET/HEAD navigation must not log out. Reject cross-origin submissions without changing the session.
- Exercise private R2 upload/finalization/download through the app; verify tenant ownership and foreign-tenant denial. The synthetic provider probe did not test these authorization boundaries.
- Verify private queue TLS/AUTH, `noeviction`, snapshots, alarms and worker progress. Review held/ambiguous jobs and provider state before starting dispatch; do not replay an uncertain external action. Validate the configured billing/webhook/reconciliation paths and feature-specific provider flows before enabling them.
- Record rollback compatibility and recovery procedures. Restoring Neon does not rewind WorkOS, R2, KMS, message delivery or payments. Keep writers stopped during restore/scrubbing/reconciliation; retain key versions and durable receipt/provisioning/trial history. Configure actual alert delivery, not just alarm resources.

Clearance record: timestamp, operator/reviewer, image SHA/digests/task revisions, schema journal hashes, exact acceptance outcomes, remaining disabled features and rollback decision. No passwords, cookies, OAuth codes, tokens or raw tenant payloads.

## Gate 8 — publish only the accepted application alias

Owner: authorized DNS operator.

Re-read the complete zone inventory, certificate, actual ALB canonical zone/DNS target, HTTPS listener, healthy target group and stable web/worker services. Review the acceptance record and exact change before submission. Preserve unrelated records and the existing ACM validation CNAME. Conflicts block; do not UPSERT or delete them to force a launch.

Create only the exact application A alias for the IPv4 baseline. AAAA additionally requires verified dualstack capability **and** separately reviewed matching permissions; the current baseline IAM phase permits only A. Wait for INSYNC, verify public resolvers and TLS, then repeat user-facing health/login/logout checks. On uncertain writes, inspect existing records/change status before any retry. DNS propagation is not application acceptance.

## Operator handoff

Keep a protected, nonsecret release record of approvals, evidence hashes, CloudFormation events/change-set IDs, image digests, migration task result, acceptance and DNS change status. Record the root-to-scoped-operator transition. This document prepares the remaining work; it neither marks unresolved gates complete nor grants permission to skip review.
