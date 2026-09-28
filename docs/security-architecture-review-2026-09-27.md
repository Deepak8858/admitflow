# AdmitFlow architecture, security, and product review

**27 September 2026 · PR #13 remediation and architecture review**

This review covers the seven dimensions in the attached brief and the five requested deliverables. AdmitFlow currently serves **coaching-institute staff** managing enquiries, counselling, WhatsApp follow-up, appointments, admission-payment receipts, and the institute's separate SaaS subscription. It is not yet a student application portal, university student-information system, tuition ledger, or multi-gateway fee platform. The current [role and lead model](../src/lib/domain.ts#L1), [database schema](../src/lib/db/schema.ts#L9), and [service inventory](connected-services.md) define that scope.

**Evidence labels.** **Implemented in source** means the referenced code expresses the control; **locally verified** means local synthetic tests exercised it; **live unverified** means no configured-provider proof is claimed; **proposal** means no implementation is claimed. PR #13 remains separate from the deployed release. No claim of FERPA, GDPR, India DPDP Act, or PCI-DSS compliance follows from source controls alone.

**Release status:** the user requested finishing the fixes in the PR for now. GitHub refused to start all four jobs in [CI run 36328446377](https://github.com/Deepak8858/admitflow/actions/runs/36328446377), reporting an account payment/spending-limit problem. The user subsequently requested native Depot CI. Both branch dispatch `46nktn6jn6` and automatic PR run `k4xcqw5zzb` passed all four jobs for head `0ebf95f2c3aa280e3750548c9deebc6b3a965b4d`. The [automatic PR workflow](https://depot.dev/orgs/xsf8b0w7g9/workflows/v16brltjms) built and smoke-tested both Linux images, passed all 72 browser checks and the security job, and retained zero-finding image reports. The first run exposed a timing-sensitive pagination fixture, now corrected without changing production scoring. See [Depot CI](depot-ci.md) for exact execution evidence. A later successful automatic run on head `4a2791a` verified the accessibility timing repair. GitGuardian now supplies exact locations: its four occurrences are synthetic parser fixtures and password-presence validation expressions. The [finding review](gitguardian-findings-2026-09-28.md) documents their false-positive classification and source cleanup; historical incidents still need a GitGuardian disposition and fresh passing check. The manual publisher still depends on GitHub Actions scheduling. No merge or deployment was performed.

**Production read-only check:** at `2026-09-27T15:07:52.847Z`, a transaction using the deployed web task's database connection confirmed effective role `admitflow_runtime`, `superuser=false`, `bypassRls=false`, `row_security_active(organizations)=true`, and no visible organization row without tenant context. The transaction was rolled back. Credentials and tenant records were not written to this report. This verifies that role configuration at that instant, not every table, pooled connection, or provider workflow.

### Confirmed findings and implemented corrections

| Finding | Correction in PR #13 | Verification |
| --- | --- | --- |
| Two HIGH runtime image findings: CVE-2026-82560 (Perl Pod::Text) and CVE-2026-85091 (zlib). Official Node also bundles the affected zlib source. | Final web/worker stages use a pinned Wolfi base, `nodejs-24=24.21.0-r3` and patched shared `zlib=1.3.2.1_rc20260601-r0`; Debian stays build-only. Keep package metadata for scanning. [Dockerfile](../Dockerfile), [runtime smoke checks](../infra/smoke-images.sh), [image scan](../infra/scan-image.sh). | Package recipes and upstream fixes checked. CI asserts actual shared-zlib linkage, no Perl, non-root UID, native modules, startup and authenticated API boundary; complete Trivy HIGH/CRITICAL results gate publication. The first native Depot run built both Linux images and passed these smoke checks. Retained Trivy reports contain 28 Wolfi packages each, 58 web npm packages and 236 worker npm packages, with zero detected vulnerabilities. |
| GHSA-67mh-4wv8-2f99 via the development esbuild dependency chain. | Scope the override to `@esbuild-kit/core-utils` and reuse root esbuild `0.28.2`. Audit development dependencies in CI too. [package.json](../package.json). | Full npm audit reports zero vulnerabilities; the real loader transform and Drizzle CLI regression tests pass locally. |
| Tenant code could run with an accidentally privileged runtime role; provisioning had its own transaction boundary. | Fail closed when the effective connection does not enforce RLS, including provisioning actor/client isolation. [repository](../src/lib/db/repository.ts), [provisioning](../src/lib/db/provisioning.ts). | Production role readback above; negative PostgreSQL fixtures cover privileged roles, disabled provisioning RLS and tenant isolation. |
| Worker accepted queue data without verifying the complete queue entry against the current durable job generation. | Validate name, ID and strict payload; require the pending tenant job and exact retry-generation/attempt identity, then recheck generation/attempt under the organization lock before claiming. [outbox](../src/lib/db/outbox.ts), [claim](../src/lib/integrations.ts). | Wrong-tenant, foreign-job, stale-retry and interleaved retry-between-validation-and-claim fixtures in [repository tests](../tests/repository.test.ts). |
| JSON mutation endpoints accepted absent Origin/content type, weakening browser request boundaries. | Require a valid same-origin Origin and JSON content type before body consumption or session mutation. [API](../src/lib/api.ts), [auth boundary tests](../tests/security-auth-boundary.test.ts). | Rejected-origin, missing-origin, unsupported-content-type and unchanged-session fixtures. |
| Analyst read/download permissions included applicant attachments, receipts and imported files. | Restrict analyst files to shared knowledge, remove hidden file references and file-backed private articles. [permissions](../src/lib/permissions.ts). | Direct-ID download and response-projection denials; original stored records remain intact. |
| Stored R2 object key validation checked a prefix rather than the exact file identity and path shape. | Require the workspace, storage phase, exact file ID and a safe final path segment; normalize leading-dot upload names. [files](../src/lib/files.ts). | Traversal, foreign tenant and mismatched file-ID fixtures in [file tests](../tests/security-webhooks-files.test.ts). This is defense against malformed/corrupted stored keys, not a demonstrated public cross-tenant upload exploit. |
| Google disconnect erased a local refresh token without revoking the provider grant; a reconnect could race the external revoke. | Commit a disabled revocation fence before contacting Google. Preserve encrypted credentials on an uncertain outcome while denying their use and reconnects; require an explicit disconnect retry. Confirm revocation before erasure and use increasing connection versions to reject stale callbacks. OAuth start rejects unfinished revocations. The UI refreshes the disabled state after a failed disconnect and offers recovery before OAuth setup. [connections](../src/lib/connections.ts). | Mocked provider, in-flight reconnect/disconnect, uncertain outcome, pre-exchange callback snapshot and empty-snapshot race fixtures in [Google tests](../tests/security-integration-google.test.ts); [browser recovery](../tests/browser/google-recovery.spec.ts) uses the real redacted connection projection. The migrated PostgreSQL schema rejects binding one Google subject to two institutes through its existing global `connections_external` constraint; cross-tenant reconciliation is therefore unnecessary for supported bindings. |
| A merchant payment carrying matching notes could be credited without proof that AdmitFlow issued its payment link. | Persist the provider-returned link ID, discover its association through `payment_links?payment_id=…`, fetch its canonical captured payment, and atomically claim the issued link with the financial write. Notes do not authorize attribution. [payments](../src/lib/providers/payments.ts), [recovery runbook](payment-link-recovery.md). | Mocked provider and PostgreSQL fixtures cover forged notes, missing/ambiguous links, wrong merchant/amount/lead, concurrent claims, replay and refund ordering. Live merchant compatibility remains unverified. |
| Hosted mutation routes had no shared per-actor/tenant application budget; replica-local limits would not bound distributed traffic. A terminal cached Redis connection could leave mutations unavailable indefinitely. | Add atomic Redis fixed-window budgets after verified identity/membership and before writes. Deny unavailable or malformed limiter responses; require authenticated TLS Redis in production. Recreate ended connections for later requests without replaying an uncertain counter evaluation. [limiter](../src/lib/mutation-rate-limit.ts), [runtime configuration](../src/lib/rate-limit-config.ts). | Disposable real Redis tests cover concurrent replicas, actor/tenant isolation, expiry, rejected-request accounting and backend failure. Mocked lifecycle tests cover connection recovery, concurrent waiters and stale-client events. Production resolver tests independently reject forged tenant choices and missing, inactive or mismatched membership. |

Mutation budgets are 120 per actor/institute/minute, 1,200 per institute/minute, 30 organization actions per account/minute, and five organization creation attempts per account/hour. Exhaustion returns 429; an unavailable limiter returns 503. Reads, the local demo and signed webhook ingestion use their existing boundaries. Production web and worker startup now require authenticated TLS Redis; migration remains independent.

**Payment compatibility:** existing credited receipts retain their stored attribution and refund path. Older uncredited links without durable canonical issuance evidence are held for investigation, as are partial/multiple-payment links and changed merchant key IDs. The [recovery runbook](payment-link-recovery.md) specifies the independent evidence and reviewed registration required before replay; this PR does not automatically backfill from notes or rewrite financial history.

Broader identity, accounting and compliance proposals in sections 2–5 are not represented as newly discovered exploitable bugs.

Runtime source evidence: [upstream Perl fix](https://github.com/rra/podlators/commit/70510174f69eb54aa6d617bde4e1402cd9b7c61f), [upstream zlib fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148), [Wolfi zlib patch](https://github.com/wolfi-dev/os/blob/main/zlib/0001-gz_write-don-t-keep-a-pointer-into-callers-buffer-on.patch). Google's [revocation documentation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke) explains that revocation invalidates the user's grant across the Google project; a generic HTTP 400 is not proof of revocation.

### Local verification

| Check | Result and scope |
| --- | --- |
| Application regression suite | 371 passed, zero failed or skipped, including the final worker claim race regression. |
| Infrastructure regression suite | 115 passed, zero failed or skipped. |
| IAM policy regression suite | 646 offline checks passed; these are not AWS policy simulations or live permission probes. |
| Python audio tooling | Three tests passed. |
| Redis mutation budgets | Disposable real Redis tests passed for concurrent requests, tenant/actor isolation, expiry and backend failure; no production Redis was used. |
| Browser regression suites | 62 main browser checks and 10 signup/onboarding checks passed across the run and focused repair rerun. The main run initially passed 61/62; its session-isolation fixture omitted the newly required Origin. After supplying Origin for valid requests and explicitly testing missing-Origin denial without a data change, that check passed. No application guard was relaxed. |
| Type checking and build | Application and infrastructure TypeScript checks, the production Next build, service bundles, syntax checks and CLI help checks passed. |
| Database migration validation | All 14 migrations passed the dry run; no migration was applied and the dry run did not contact a database. |
| Dependency and repository scanning | Full npm audit reports zero vulnerabilities; Actionlint, both shell syntax checks and redacted Gitleaks scans of Git history and staged changes passed. |

The local verification harness clears provider and database credentials before execution. Mocked Razorpay and Google responses establish the application's validation and race behavior, not live provider compatibility. Account browser tests use AuthKit's real local server action/PKCE construction with intercepted outbound navigation and synthetic organization responses. Native Depot additionally verified Linux container builds, shared-zlib/native-module startup, HTTP authentication boundaries and complete image reports; this does not establish provider acceptance or production deployment.

**Native Depot verification:** the successful branch dispatch at `0ebf95f` repeated all 371 application tests, 646 IAM checks, three Python tests and build/migration checks on Linux. Infrastructure coverage increased to 120 tests with five new release-gate tests. The successful automatic PR run passed all 72 browser checks in one run and retained zero-finding reports for both images. The release gate accepted the real four-check metadata and rejected its PR-branch suite for publication. The remaining GitGuardian findings above are a separate release blocker.

## 1. Architecture and prioritized gap matrix

### Current trust boundaries

| Boundary | Code evidence and present behavior | Verification limit |
| --- | --- | --- |
| Staff identity → institute | Hosted access requires WorkOS AuthKit session and selected organization, maps WorkOS organization to local `organizations.id`, checks active WorkOS membership, and projects a stable local member identity. [auth.ts](../src/lib/auth.ts#L27), [team-access.ts](../src/lib/db/team-access.ts), [schema.ts](../src/lib/db/schema.ts#L75). Without `DATABASE_URL`, the local SQLite demo uses its own session path. | Identity-provider SSO modes, session lifetime/rotation/revocation settings, multi-replica membership behavior, and live organization switching were not exercised here. |
| Institute → PostgreSQL | Shared database, tenant-keyed tables, composite tenant/lead and tenant/member foreign keys, FORCE RLS policies, and transaction-local `app.organization_id`. The transaction wrapper checks `row_security_active` on the effective runtime role before tenant work. [schema.ts](../src/lib/db/schema.ts#L17), [0002_tenant-policies.sql](../drizzle/0002_tenant-policies.sql#L1), [repository.ts](../src/lib/db/repository.ts#L17). | Live role verification is recorded above. Full pooled-connection and all-table checks remain operating requirements; privileged runtime roles fail closed. |
| Pre-tenant routing → tenant context | `organization_routes` maps WorkOS organization IDs; `connection_routes` maps external provider IDs to a tenant before tenant-scoped reads. [schema.ts](../src/lib/db/schema.ts#L135), [auth.ts](../src/lib/auth.ts#L43), [outbox.ts](../src/lib/db/outbox.ts#L78). These route registries are outside the per-tenant RLS tables by design. | Their write paths, ambiguous bindings, deletion/rebind behavior, operational access, and race handling need an end-to-end review. |
| HTTP actions → records | Static permissions are `owner`, `admin`, `counsellor`, `analyst`; counsellor access is tied to assigned `leads.ownerId` and related files, tasks, appointments, and messages. Action authorization runs server-side; read projection strips connection secrets/object keys. [permissions.ts](../src/lib/permissions.ts#L5), [permissions.ts](../src/lib/permissions.ts#L32), [permissions.ts](../src/lib/permissions.ts#L71), [workspace route](../src/app/api/workspace/route.ts). | This is not a complete field-level privacy model. The analyst's aggregate projection still includes broad enquiry/message data, subject to the actual product role contract. All routes and newly added fields need a permission inventory. |
| Worker and integrations → tenant | Durable jobs carry workspace/job IDs, verify a registered institute route and matching pending job before processing; BullMQ/Valkey is a queue, not a general CRM read cache. Private R2 keys are tenant-prefixed and presigned access is short-lived. Credential encryption uses a tenant-bound KMS context (or AES-GCM fallback). [outbox.ts](../src/lib/db/outbox.ts#L13), [outbox.ts](../src/lib/db/outbox.ts#L78), [files.ts](../src/lib/files.ts#L60), [secrets.ts](../src/lib/secrets.ts#L20). | Worker retry/concurrency proof, R2 lifecycle/orphan cleanup, key rotation, and any CDN/edge cache configuration are live or operational checks. |
| Admissions payments → provider | INR payment links, positive integer-paise receipts/refunds, signed institute Razorpay webhooks, durable inbox, provider reconciliation, and per-tenant uniqueness are present. SaaS billing uses a separate webhook/secret and does not post admission revenue. [payments.ts](../src/lib/providers/payments.ts#L53), [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L25), [billing webhook](../src/app/api/webhooks/billing/route.ts#L14). | Live merchant settlement/reconciliation, tax invoices, tuition balances, installment schedules, chargebacks, and provider-initiated admission refunds are not established. |

**Priority meaning for the following operating/architecture matrix:** P0 identifies critical boundaries requiring continued verification, P1 identifies near-term design or policy work, and P2 identifies product/scale expansion. Confirmed implementation findings and corrections are recorded separately above. A proposed validation exercise is not evidence of a reproduced exploit.

| Priority · dimension | Specific gap or failure mode | Existing evidence | Concrete next action and acceptance test |
| --- | --- | --- | --- |
| **P0 · tenancy/production** | A privileged PostgreSQL runtime role, connection-pool reuse, or a query outside a tenant transaction could bypass intended isolation. | FORCE RLS and transaction-local GUC exist; `assertTenantRls` now checks the effective role. The read-only production role check above passed. [0002_tenant-policies.sql](../drizzle/0002_tenant-policies.sql#L1), [repository.ts](../src/lib/db/repository.ts#L17). | Continue disposable production-equivalent A/B tenant read/write, pooled-connection reset, migration and worker exercises. Recheck effective role and unscoped visibility when deployment or database-role configuration changes. |
| **P0 · tenancy/integrations** | Pre-tenant organization/provider route lookup is an authority boundary; stale or ambiguous external-ID mappings could dispatch a signed event or worker job to the wrong institute. | Globally unique route rows, tenant checks in job execution, and connection-scoped payment binding. [schema.ts](../src/lib/db/schema.ts#L135), [outbox.ts](../src/lib/db/outbox.ts#L78), [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L26). | Inventory every route writer and callback. Test disconnect/reconnect, rotated IDs, concurrent bind, tenant deletion, provider redelivery, and wrong-tenant payload. Require immutable binding evidence or explicit operator reconciliation before reassignment. |
| **P0 · financial integrity** | An acknowledged payment could be missed if webhook persistence fails or a crash occurs between applying the admission receipt and marking the inbox processed; duplicate delivery must never double-credit. | Body-bound receipt identity, lease/fencing/retry, provider GET, tenant/provider uniqueness, and 503 retry on save failure are implemented. [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L25), [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L47), [schema.ts](../src/lib/db/schema.ts#L54), [admission webhook](../src/app/api/webhooks/razorpay/%5BworkspaceId%5D/route.ts#L14). | In a configured Razorpay test merchant, replay exact and semantically duplicate events, deliver refund-before-capture, crash after financial commit, rotate merchant binding, and reconcile provider settlement versus local receipt totals. Preserve failed receipts for operator review. |
| **P0 · supply chain** | Source remediation does not establish that a new production image has passed scanning/startup or been deployed. | The pinned Wolfi/shared-zlib change, scoped esbuild override and fail-closed scan are implemented. Native Depot now executes Linux compatibility and scan jobs independently of GitHub Actions billing. | Require successful current Depot CI and verify exact published/deployed digests during a later authorized release. |
| **P1 · authorization/privacy** | Four coarse roles do not define finance, applicant, guardian, consultant, or field-counsellor permissions. Analyst read projection is broader than `view.save`; future sensitive fields could be exposed through the full workspace response. | [domain.ts](../src/lib/domain.ts#L64), [permissions.ts](../src/lib/permissions.ts#L5), [permissions.ts](../src/lib/permissions.ts#L71), [repository.ts](../src/lib/db/repository.ts#L45). | Approve a role × object × field matrix, then implement server-side positive field projections per endpoint. Add negative tests for every role, unassigned lead, related document/payment, and cross-tenant ID. |
| **P1 · AuthN/lifecycle** | WorkOS is the hosted staff identity authority, but enterprise SSO configuration and session revocation on role/tenant change are not proven from this repository; WorkOS Events API sync is listed as missing. | Live membership recheck and team access projection are present. [auth.ts](../src/lib/auth.ts#L41), [connected-services.md](connected-services.md#L100), [production-plan.md](production-plan.md). | Document actual WorkOS tenant/domain/SSO configuration, session TTL and revoke semantics. Test role removal while API/SSE/browser/worker operations run. Add signed WorkOS change-event reconciliation if polling cannot meet the agreed revocation bound. |
| **P1 · privacy/audit** | `activities` is an operational timeline, not an immutable administrative audit; the raw-intake expiration rule does not define retention for leads, messages, files, backups, exports, or erasure. | Mutable activities and bounded intake expiry. [schema.ts](../src/lib/db/schema.ts#L69), [schema.ts](../src/lib/db/schema.ts#L89), [connected-services.md](connected-services.md#L219). | Produce data inventory and legal-basis/retention decisions with counsel; add append-only security/audit records, subject export/deletion workflow, backup retention and scrubbed-restore exercise. Do not label compliance “complete” without policy and operating evidence. |
| **P1 · abuse/AI/OAuth** | Aggregate mutation limits do not replace provider-specific spend budgets or edge protection. AI has prompt/citation/booking checks and a daily message guard, but not complete token/cost/risk telemetry. | Google provider revocation is now implemented and negatively tested. Existing AI controls: [ai.ts](../src/lib/providers/ai.ts#L46), [integrations.ts](../src/lib/integrations.ts#L375), [infra stack](../infra/stack.ts). | Tune limits against measured traffic, verify edge/WAF policy and provider quotas, and add tenant spend caps and provider data-flow review. Exercise real Google revoke/reconnect behavior in a test account before relying on provider readiness. |
| **P1 · financial product** | Admission `payments`/`refunds` record receipts, not a double-entry ledger or receivable; manual/offline refund records do not initiate provider refunds. SaaS subscription billing is a separate domain. | [schema.ts](../src/lib/db/schema.ts#L54), [payments.ts](../src/lib/providers/payments.ts#L91), [connected-services.md](connected-services.md#L155), [connected-services.md](connected-services.md#L207). | Define fee component, order, invoice, immutable journal, allocation, refund/chargeback, and provider settlement tables before installments or multi-gateway routing. Finance and tax advisers approve invoice numbering/jurisdiction rules. |
| **P1 · concurrency/observability** | Full workspace hydration and diff persistence makes many mutations proportional to tenant size; appointment availability is advisory and external calendar writes are not atomic. | [repository.ts](../src/lib/db/repository.ts#L45), [repository.ts](../src/lib/db/repository.ts#L147), [connected-services.md](connected-services.md#L86), [backend-verification.md](backend-verification.md). | Replace highest-volume mutations with bounded SQL commands and explicit versions; instrument request/tenant/queue/provider spans and alarms. Test 10× expected peak with concurrent assignment, booking, payment, webhook, and retry workloads. |
| **P2 · admissions/counselling** | Eight fixed stages and deterministic lead score exist; there is no first-party applicant form-event stream, document abandonment detector, predictive model, general workflow graph, telephony recording/transcription, or multi-counsellor calendar sync. | [domain.ts](../src/lib/domain.ts#L1), [domain.ts](../src/lib/domain.ts#L9), [connected-services.md](connected-services.md#L86), [production-plan.md](production-plan.md). | Define consented event taxonomy and configurable transitions before omnichannel automation. Pilot with measured response time, recovery, opt-out, error, and human-handoff metrics. |
| **P2 · tenant lifecycle/enterprise** | A WorkOS-organization route is not a custom-domain/TLS system. Export, retention-safe offboarding, institutional SAML/OIDC configuration, agency and applicant identities are separate products. | [schema.ts](../src/lib/db/schema.ts#L135), [auth.ts](../src/lib/auth.ts#L41), [domain.ts](../src/lib/domain.ts#L64). | Design verified domain ownership, unique hostname→tenant lookup, automated certificate lifecycle, suspend/export/delete states, and region/tenant residency options. Test domain takeover and restore after offboarding. |

There is no Elasticsearch/OpenSearch/Meilisearch tier in the inspected runtime. Knowledge retrieval uses tenant-scoped PostgreSQL full text; a vector path is optional and must be verified if enabled. Valkey carries BullMQ jobs rather than applicant result caches. Avoid importing generic cache/search leak findings without a corresponding deployment or code path. [schema.ts](../src/lib/db/schema.ts#L61), [knowledge.ts](../src/lib/db/knowledge.ts), [outbox.ts](../src/lib/db/outbox.ts#L13).

## 2. AuthN and AuthZ blueprint

### Identity and role contract

**Implemented in source:** the hosted principal is a WorkOS user within one active WorkOS organization; `organization_routes` selects local `organizations.id`. The local `members.id` is the stable assignee key used by `leads.ownerId`, tasks, and appointments; `members.workosId` links to the WorkOS user. `owner`/`admin` have wildcard actions, `counsellor` gets specified actions on assigned enquiries, and `analyst` has `view.save` as its mutation permission. [auth.ts](../src/lib/auth.ts#L41), [schema.ts](../src/lib/db/schema.ts#L18), [schema.ts](../src/lib/db/schema.ts#L72), [permissions.ts](../src/lib/permissions.ts#L5). The local demo owner is a separate non-hosted path, not evidence of production applicant login. There is no student, parent, consultant, finance, or platform-superadmin session contract in the current type model. SAML/OIDC, passkeys, OTP, and social-login options must be verified/configured at the identity provider before being advertised.

**Proposed least-privilege matrix** (deny unless a cell is granted; `own` means relationship proven by stable IDs, not display names):

| Principal | Enquiries/messages | Applicant files | Admission money | Team/configuration | Audit/export |
| --- | --- | --- | --- | --- | --- |
| Institution owner/admin (current) | Tenant-wide | Tenant-wide | Tenant-wide | Tenant-wide | Proposed privileged approval plus audit |
| Counsellor (current) | Assigned leads only | Assigned attachments plus shared knowledge | None | None | Own activity only |
| Analyst (current, tighten read contract) | Aggregate/de-identified reporting; no raw message default | None | Aggregates only | Saved views | No bulk PII export |
| Finance officer (proposed) | Minimal lead identity required to reconcile | Invoice/receipt only | Receipts, allocations, refunds within approval limits | None | Financial export with purpose |
| Field counsellor / agency consultant (proposed) | Explicit assigned/referral relationship | Explicitly shared only | Attribution/commission summary, not raw balances | None | Own portfolio |
| Applicant / guardian (proposed) | Their own application, with guardian relationship/age rules | Own authorized documents | Own fee orders/receipts | None | Own data export |
| Platform support (proposed) | No standing tenant read | No standing read | No refund/write | No tenant membership mutation by impersonation | Time-limited, approved, audited support session |

**Proposed additive schema, not a migration already present.** Keep `organizations.id`, `members.id/workosId`, tenant composite FKs, and `leads.ownerId`. Avoid a second competing membership identity. The following logical tables are sufficient to start; names and data types are illustrative and require migration/retention review:

```sql
-- Existing: members(id, organization_id, workos_id, role, status);
-- Existing: leads(id, organization_id, owner_id), unique (organization_id, id).
member_access_scope(
  organization_id uuid not null,
  member_id text not null,
  scope_kind text not null check (scope_kind in ('course','lead','agency')),
  scope_id text not null,
  granted_by_member_id text not null,
  expires_at timestamptz,
  primary key (organization_id, member_id, scope_kind, scope_id),
  foreign key (organization_id, member_id)
    references members(organization_id, id)
);
lead_relationship(
  organization_id uuid not null,
  lead_id uuid not null,
  subject_id uuid not null, -- proposed applicant/guardian/agency identity, never a name/phone
  relation text not null,
  verified_at timestamptz,
  revoked_at timestamptz,
  primary key (organization_id, lead_id, subject_id, relation),
  foreign key (organization_id, lead_id)
    references leads(organization_id, id)
);
security_event(
  id uuid primary key,
  organization_id uuid, -- nullable only for pre-tenant control-plane events
  actor_kind text not null,
  actor_id text not null,
  subject_kind text not null,
  subject_id text not null,
  action text not null,
  decision text not null,
  request_id text not null,
  occurred_at timestamptz not null,
  metadata_redacted jsonb not null
);
```

Enforce FORCE RLS on every added tenant table; use tenant-composite references for scoped objects, typed `scope_id` or dedicated per-resource tables when an FK is needed, and prohibit cross-tenant grants. Make `security_event` append-only with a separate insert-only writer, no update/delete application grant, retention/partition policy, and independently tested tamper detection. It is not a substitute for data-access logs or legal retention policy. An applicant/guardian identity must be added only with explicit verified relationship proof; a matching phone number is insufficient.

**Proposed request middleware/command sequence**, aligned to current `resolveWorkspace`, `assertActor`, `authorizeRecordAction`, and `tenantTransaction`:

```text
1. Hosted request: verify WorkOS session and selected organization; reject missing identity.
2. Resolve organization_routes[workos_organization_id] on the server.
   Re-read active WorkOS membership and local member projection/fence.
   Reject inactive, unsupported role, changed membership, or suspended tenant.
3. Build immutable Context {
     organizationId: local organizations.id,
     workosUserId, memberId: local members.id,
     role, requestId, purpose
   } from verified server data, never request JSON or hostname alone.
4. Authorize action by role + relationship + record state.
   For a lead: SELECT ... WHERE organization_id = Context.organizationId
                       AND id = :leadId [AND owner_id = :memberId when required].
   Join files/messages/payments using (organization_id, lead_id), then project
   an explicit field allowlist for the principal. No "read all, hide in UI" rule.
5. In one tenantTransaction, assert effective RLS role and SET LOCAL tenant GUC;
   execute bounded SQL with tenant predicate, validate affected-row count,
   write redacted decision/security event, then commit.
6. On denial, reveal no cross-tenant object detail. Test every route variable,
   query ID, action payload, attachment, export, SSE, and background command.
```

Provider callbacks and workers are **service principals**, not staff sessions: authenticate the signed callback or durable job, resolve one authoritative route, then enter the same tenant transaction and object checks. Do not let a provider-supplied workspace ID override a server binding. A future support “impersonation” feature should issue a separate time-limited, read-only-by-default support grant with approval, prominent banner, reason, request/session IDs, revocation, and append-only audit; do not grant the application role `BYPASSRLS`.

## 3. Payment and webhook reliability specification

This sequence describes **current admission Razorpay behavior in source**, not tuition accounting or the SaaS subscription path. [payments.ts](../src/lib/providers/payments.ts#L53), [admission webhook](../src/app/api/webhooks/razorpay/%5BworkspaceId%5D/route.ts#L14), [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L25), [worker.ts](../scripts/worker.ts#L20).

```mermaid
sequenceDiagram
    participant Staff as Authorized staff
    participant App as AdmitFlow
    participant DB as Tenant PostgreSQL
    participant RZ as Razorpay
    participant Worker as Recovery worker
    Staff->>App: Issue INR admission payment link for a lead
    App->>RZ: Create link with bounded tenant/lead notes
    RZ-->>App: Return link ID and URL
    App->>DB: Save issued-link receipt (tenant, lead, paise, connection binding)
    RZ-->>App: Signed captured/refund webhook (raw body)
    App->>App: Check size, route, active merchant secret, HMAC; parse minimal reference
    App->>DB: Insert tenant + signed-body-hash receipt; duplicate = same receipt
    App-->>RZ: 2xx only after durable accept; persistence failure = retryable 503
    Worker->>DB: Claim pending receipt with lease and fenced claim
    Worker->>RZ: GET authoritative payment/refund state
    opt New credit without an existing captured receipt
        Worker->>RZ: GET payment_links filtered by payment_id
        Worker->>RZ: GET canonical link and captured payments
    end
    Worker->>DB: Check issued link, tenant, merchant key, amount, provider IDs
    Worker->>DB: Atomically claim issued link and apply capture/refund
    Worker->>DB: Mark receipt processed or schedule bounded retry/operator failure
```

The provider link is created **before** its issued-link receipt is persisted; the app returns the link only after the receipt is stored. A failure between those steps can leave an unreturned provider link that needs merchant-side reconciliation. The admission webhook signature covers the exact bounded UTF-8 body, and receipt identity is tenant plus a hash of that signed body. The unsigned provider event-ID header is not trusted as the admission deduplication key. The inbox stores minimal references, not full customer/card payloads. The worker has an eight-attempt bounded retry, lease, claim token, failed receipt inspection, and explicit retry path. Reconciliation re-fetches provider state and checks the issued link, connected merchant fingerprint, INR amount, and provider identifiers before applying a positive receipt/refund. Refund-before-capture is handled by reconstructing the capture before refund application. [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L12), [payment-inbox.ts](../src/lib/db/payment-inbox.ts#L47), [payments.ts](../src/lib/providers/payments.ts#L53), [payments.ts](../src/lib/providers/payments.ts#L79), [payments.ts](../src/lib/providers/payments.ts#L128).

The issued-link `creditedPaymentId` claim and financial write share one tenant transaction. A refund never clears the claim, and another payment cannot consume that same link. The financial write and **inbox** `processedAt` update remain separate tenant transactions; a crash between them relies on provider-ID/reference uniqueness and duplicate handling during replay. Thus “exactly once” should be stated as an **idempotent financial outcome**, not an exactly-once webhook delivery guarantee. Synthetic crash/replay tests exercise that outcome; configured-provider verification remains pending. A signed replay with different body bytes may create a second inbox receipt but must still resolve to the same provider payment/refund ID and one financial outcome. No time-window replay rejection is claimed. The [SaaS billing webhook](../src/app/api/webhooks/billing/route.ts#L14) has its own secret and subscription state machine; its `payment.captured`/refund events do not add admission revenue.

**Proposed extension before installment or gateway expansion:** introduce `fee_order` (tenant, applicant/lead, fee type, currency, total paise, status), `fee_installment` (due amount/date), `payment_attempt` (gateway, merchant, provider ID, order ID, idempotency key), `ledger_entry` (immutable balanced debit/credit postings), `allocation` (capture→installment), `refund_request` (approval and provider outcome), `settlement_reconciliation` (provider statement line→local postings), and jurisdiction-specific `tax_invoice` (unique sequential number assigned transactionally). Keep admission and SaaS billing ledgers distinct. Financial invariants: tenant/order/merchant must agree; cumulative allocated captures ≤ verified captures; refunds ≤ captured less prior refunds; balanced postings per currency; duplicate provider events do not post twice; an unverified webhook never changes balances. A scheduled reconciler should compare provider settlement exports to the immutable journal, alert on missing/mismatched events, and require two-person approval for high-risk manual corrections. Have qualified finance/tax counsel validate invoice and data-retention rules before launch.

## 4. Advanced features catalog

These are **proposals**, not current endpoints. The sequence favors reusable identity, event, permission, and ledger foundations over copying a full university SIS into the existing `Lead` record.

| # | Feature and product value | AdmitFlow anchor and prerequisite |
| --- | --- | --- |
| 1 | **Applicant journey and abandonment events:** resume incomplete forms, document submissions, and checkout with consent-aware reminders. | Add application/form event IDs and resumable state beside `leads`, not into free-text notes; event authenticity, dedup, consent, and deletion first. [lead model](../src/lib/domain.ts#L19). |
| 2 | **Policy-driven omnichannel orchestration:** WhatsApp, transactional email, SMS, and optional outbound voice with quiet hours, channel consent, delivery failover, and human handoff. | Extend bounded campaign/job model and Meta status receipts; provider-specific consent and opt-out per channel. [campaign/job types](../src/lib/domain.ts#L39), [outbox.ts](../src/lib/db/outbox.ts#L13). |
| 3 | **AI counsellor copilot:** source-cited suggested replies, next-best action, supervisor approval, and quality review rather than default autonomous promises. | Extend existing knowledge-grounded reply and assisted mode with evaluations, PII policy, usage budgets, and audit. [ai.ts](../src/lib/providers/ai.ts#L46), [AI settings](../src/lib/domain.ts#L72). |
| 4 | **Assignment and SLA engine:** round-robin/skills/language routing, first-contact timer, capacity caps, and safe reassignment escalation. | Use stable `members.id`/`leads.ownerId` and versioned assignment commands; reconcile concurrent updates and preserve ownership audit. [schema.ts](../src/lib/db/schema.ts#L18). |
| 5 | **Applicant/guardian self-service portal:** status, documents, appointments, fee receipts, and controlled consent updates. | New verified applicant identity and `lead_relationship`; server-side object and field policies, age/guardian rules, no staff-cookie reuse. |
| 6 | **Agency/consultant attribution portal:** referred applicant status and commission evidence without broad institute PII. | New agency relationship and scoped grants; distinguish referral attribution from ownership and payment authority. |
| 7 | **Merit list, offer letter, and seat allocation:** auditable program rules, ranked decisions, acceptance windows, and versioned letters. | Separate `application`, `program`, `decision`, and `offer` from the fixed eight enquiry stages; legal and institutional policy review. [stages](../src/lib/domain.ts#L1). |
| 8 | **Fee plans and tax-ready invoicing:** application/seat/tuition fee distinctions, scholarships, installments, refunds, receipts, and settlement. | Build proposed order/ledger/invoice domain on integer paise and provider reconciliation; never mutate the SaaS subscription ledger for student fees. [payments schema](../src/lib/db/schema.ts#L54). |
| 9 | **Counselling contact center:** inbound/outbound call routing, consented recordings, transcript search, disposition, and multi-counsellor calendars. | Add signed telephony callbacks, recording retention/redaction and per-counsellor calendar authorization; current Google availability is advisory. [appointments](../src/lib/domain.ts#L55), [connected-services.md](connected-services.md#L86). |
| 10 | **Enterprise institute controls:** verified SSO/domain onboarding, custom domain/cert lifecycle, delegated administration, export/offboarding, residency and audit reporting. | Build on WorkOS organization mapping and tenant lifecycle state; require domain ownership proof and non-bypassable support access. [auth.ts](../src/lib/auth.ts#L41). |

Predictive conversion scoring is a **later option within features 1 and 3**, after event quality, consent, drift/fairness review, and a measurable baseline. Today's score is a deterministic rule set (`LEAD_RULES`), not a trained conversion probability. [domain.ts](../src/lib/domain.ts#L9), [domain.ts](../src/lib/domain.ts#L183).

## 5. Phased production-readiness roadmap

| Phase | Concrete deliverables | Exit evidence |
| --- | --- | --- |
| **Security & Compliance** | Finish cross-tenant route and object inventory; run production-equivalent non-BYPASSRLS/pooled-connection tests; set edge/API/provider/AI limits; review WorkOS/OAuth scope, revocation, and session settings; adopt role/field matrix; add append-only security events; establish data map, consent/retention/export/deletion and backup policies with legal owners. | Automated negative A/B tenant and role tests, wrong-merchant webhook replay, revoked-member tests, rate-limit/load results, logged operator recovery, and a scrubbed backup restore. Compliance status remains “assessment pending” until legal and operational evidence is signed off. |
| **Core Engine** | Add typed applicant/application and form-event model; configurable admission transitions; assignment/SLA engine; consent-aware omnichannel queue; finance order/immutable ledger/settlement reconciler; supervised AI copilot and knowledge quality controls. | Event replay is idempotent, reassignment is race-safe, no unconsented send, financial invariants hold under duplicate/crash/refund ordering, and staff can explain every score/action. |
| **Scalability** | Replace full-workspace writes/read projections on hot paths with bounded SQL and paginated resource APIs; partition or archive high-volume messages/events; measure queue lag and provider quota pressure; add request/tenant/receipt correlation and restore/rollback rehearsals. | Production-like 10× launch-peak exercise meets agreed p95 latency, queue-drain, error-budget and no-duplicate-money targets; no cross-tenant leakage in pooled, worker, or search paths. Targets must be set from real usage rather than invented here. |
| **Enterprise Features** | Offer optional SSO federation and delegated groups, verified custom domains, applicant/guardian/consultant portals, merit/offer automation, jurisdiction-reviewed invoicing, and institution-specific export/offboarding. | Two pilot tenants prove identity isolation, domain verification/certificate rotation, delegated least privilege, signed offer/fee lifecycle, export/delete and restore boundaries, with documented support/runbook ownership. |

**Operating follow-up:** after the PR is reviewed, require the exact main revision to pass native Depot CI and retain the Linux runtime scan/startup evidence before release. Separately maintain WorkOS session/revocation evidence, provider spend budgets, R2 lifecycle/backup scrub and configured-provider test coverage. Signed state, PKCE, scope checks and an admin recheck already protect the [Google callback](../src/app/api/integrations/google/callback/route.ts#L17); this PR adds provider revocation on disconnect. The database role check above was read-only. No merchant payment, provider message, grant revocation or deployment was performed during this review.
