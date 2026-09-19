# AdmitFlow verification and open follow-up

Updated 19 September 2026. Results distinguish the first-release review repairs from earlier subscription/access/payment hardening and UI baselines.

## Current release-repair evidence — 19 September

- Uninterrupted `npm run verify`: **236 application tests**, **14 infrastructure tests**, project/infra TypeScript, Next production build, five service bundles, operational syntax/help checks and the **ten-migration dry run through 0009** passed; explicit `VERIFY_EXIT=0`. A separate isolated infrastructure confirmation passed 14/14 with `INFRA_EXIT=0`.
- Fresh isolated `npm run verify:browser`: **38 passed in 13.0 minutes**, one worker, disposable SQLite, explicit `BROWSER_EXIT=0`. This is automated fixture coverage, not separate manual visual or live-provider acceptance.
- Repairs cover durable actor/client-scoped organization provisioning and sticky review evidence, hosted/local auth separation, tenant dispatcher failure isolation, retained connection/receipt identity, stale reconnect and subscription-write checks, platform-key opt-out, malformed provider responses, non-bypass-role tenant isolation, and transactional orphan-migration refusal.
- Workflow actionlint passed with optional ShellCheck/Pyflakes disabled. Fully redacted Gitleaks scans passed over all five local Git commits and a fresh 222-file tracked/unignored source snapshot. These scans do not certify provider credential rotation. No application lint script exists.
- Fresh production lockfile audit: **0 vulnerabilities**, exit 0. Full audit: **4 moderate development-only findings**, exit 1, the existing Drizzle Kit/esbuild loader chain; no dependency changes or forced downgrade.
- Retained failed attempts: the first full run passed 235 tests and failed the schema-drift assertion because it compared current source to the old 0007 snapshot; the test now verifies the additive chain through 0009 and no modeled drift. Earlier focused fixture/type errors were corrected. An author's prior typecheck-pass claim based on absent diagnostics was retracted; the uninterrupted full verifier above is the authoritative compiler evidence.
- Independent source rechecks confirmed the sticky-provisioning and stale-local-reconnect fixes. Provider requests already dispatched cannot be recalled; absent non-AI/speech rows do not make disconnect a first-time setup cancellation API. See the recovery runbook.

These results cover the uncommitted repair checkout and were recorded in this session's command output, not the older log files below. Repaired-commit Linux CI/CodeRabbit review, restricted-role Neon rehearsal, WorkOS configuration, container/provider staging and deployment gates remain pending. No production migrations or deployments were performed. Raw-intake retention remains an explicit gate before live Meta/WhatsApp activation.

## Earlier subscription evidence — 18–19 September

- Uninterrupted `node scripts/verify.mjs --all` on 18 September: **175 application tests passed** (83.020 seconds), **8 infrastructure tests passed** (20.271 seconds), both TypeScript checks, Next 16.3.5 production build, five service bundles, operational syntax/help checks and the **eight-migration** dry run passed; exit **0**, `databaseContacted: false`.
- Final isolated `node scripts/verify.mjs --browser` on 19 September: **37 passed, 0 failed in 21.3 minutes**, one worker/default Chromium and disposable SQLite; exit **0**. Final isolated project TypeScript passed after the browser-test corrections, exit **0**. Runtime source did not change after the full non-browser pass.
- Coverage includes immutable 168-hour trials, legacy transition grants, verified period/freshness boundaries, provider and team cancellation orderings, denied speech/vector fallbacks, durable signed intake and explicit recovery. The infrastructure test verifies worker billing secret selectors. Migration snapshots form an additive chain with no modeled schema drift; custom SQL constraints/triggers/RLS are exercised by migration fixtures.
- Browser coverage includes open-tab expiry and refresh outage/recovery, identical capability snapshots not renewing access, restricted controls with drafts/notes/safety preserved, billing recovery, explicit intake batches, role guidance and coded 409 handling, plus the existing workspace and public-page suites.
- Retained earlier failures: a hidden-radio `.check()` was replaced with a visible-label click plus the same checked assertion; the expiry test's pre-navigation paused clock stalled hydration and was removed, with refresh completion now awaited. The subsequent run passed that expiry regression but was interrupted after 14 tests; it was not a suite pass.
- On 19 September one invocation timed out before dev-server readiness (no tests ran). The diagnostic rerun started normally and passed 36/37 tests: `/api/jobs` cold compilation took 23.2 seconds, exceeding the request's 15-second budget; the server then returned the expected 401. That request now uses the existing 45-second navigation budget, with its authorization assertion unchanged. The final complete run above passed without retries.
- Evidence: `.data/verification-subscriptions-20260918-225058/all.log`, `browser.log`, `browser-expiry-rerun.log` and archived failure artifacts; `.data/verification-subscriptions-20260919/browser.log`, `browser-diagnostic.log`, `browser-final.log`, `typecheck-final.log` and `browser-cold-route-failure/`. Exit codes were recorded in terminal output separately from stdout logs. Earlier screenshots/traces were copied before reruns.

This is local/mock-provider verification, not production acceptance. Independent access-review sign-off, credentialed staging, full-projection capacity work and lint adoption remain separate gates. No new dependency audit, live-provider requests, hosted migrations, deployments or commits were performed. The 17 September audit remains historical: zero production vulnerabilities and four moderate dev-only findings.

## Earlier access hardening evidence — 18 September

- Uninterrupted `node scripts/verify.mjs --all`: **143 application tests passed** (206.8 seconds), **8 infrastructure tests passed** (92.9 seconds), project/infra TypeScript, Next 16.3.5 production build, five service bundles, operational syntax/help checks and all six migration dry-run entries passed. Final exit **0**; `databaseContacted: false`.
- The application suite includes **14 access test-runner entries** (12 route/auth subtests, their parent and one SDK transport test). It tests real auth/team source in memory with mocked WorkOS/AuthKit and PGlite; the SDK test checks five writes across eight retryable/transport failures with exactly one request per invocation.
- First browser attempt: **18 passed, 1 timeout** (14.1 minutes). Trace showed initial `/api/team` fetching began 17.7 seconds after navigation started and returned 200 about 1.4 seconds later. The 15-second waiter expired during hydration. Its navigation-spanning budget was aligned with the existing 45-second navigation budget and both promises awaited together; application code and assertions were unchanged.
- Fresh browser rerun: **19 passed in 7.7 minutes**, one worker, disposable SQLite, exit **0**. Port 3100 was checked free; unrelated processes were not stopped. Final isolated project TypeScript passed after the test-only change, exit **0**.
- Logs: `.data/verification-2026-09-18/release-access-verification.log`, `browser-access-verification.log` (initial failure), `browser-access-rerun.log`, `final-typecheck.log`; initial failure trace: `browser-first-failure-trace.zip`. Terminal output recorded final exit codes separately from the stdout logs.
- Dependency audit was not repeated today: the 17 September result remains **0 production vulnerabilities / 4 moderate dev-only findings**. No lint configuration/pass, live-provider calls, hosted migrations, commits or deployments are claimed.

The original access races have local regression coverage and an implemented repair. Multi-replica PostgreSQL/WorkOS semantics, positive-evidence recovery and operational restore still require credentialed staging. Unknown dispatched outcomes deliberately stay blocked; see [team access recovery](deployment.md#team-access-recovery).

## Earlier payment/readiness hardening evidence — 17 September

Payment inbox/recovery, authoritative merchant reconciliation, integer-paise checks, exact bounded UTF-8 signature handling, readiness/preflight and isolated verification tooling passed these local checks:

- `--payments`: **15 tests passed**, followed by a project typecheck with no diagnostics. Two fixture typing errors found by an earlier direct compiler run were corrected before this pass.
- `--all`: **129 application tests passed** (85.1 seconds), **8 infrastructure tests passed** (47.4 seconds), then project TypeScript passed. The process was interrupted during infra TypeScript with Windows exit `-1073741510` (`0xC000013A`); later stages had not run. This invocation was not a complete pass.
- Resumed `--build`: **infra TypeScript passed**, Next 16.3.5 production build passed (including its TypeScript stage), all five service bundles built, worker/payment/preflight syntax checks and payment/preflight CLI help checks passed. The six-migration dry run passed with `databaseContacted: false`.
- `--browser`: **19 passed in 5.2 minutes**, one worker, disposable SQLite. Port 3100 was checked free before launch; unrelated Node processes were not stopped. This is a new browser result, not recovered output.
- Fresh `npm audit --omit=dev --package-lock-only --ignore-scripts`: **0 vulnerabilities**. Full lockfile audit: **4 moderate dev-only findings**, the existing Drizzle Kit/esbuild loader chain under GHSA-67mh-4wv8-2f99. No dependency upgrades or forced fixes were performed.

Payment tests cover persistence failure/rollback, out-of-order refunds, duplicates, lease replacement, merchant-key changes and connection changes during provider reads. Readiness/configuration and verification-environment tests passed in the application suite. At that point access repair was pending; the 18 September section supersedes that status. **Credentialed deployment and live-provider checks remain pending. No lint script or lint pass exists.**

Earlier wait-mode shell attempts returned cancelled without results; monitored sessions subsequently completed. Use `npm run verify:payments`, then `npm run verify`; `node scripts/verify.mjs --build` supports resuming only the build stages. Check process/port ownership before `npm run verify:browser`. The verifier uses in-memory application fixtures and disposable browser SQLite, strips inherited provider settings and blanks template-named variables without editing `.env.local`. This is not a network sandbox or a production-deployment certification.

## Pre-hardening results — 16 September baseline

Every pass in this table predates the hardening source changes and must not be cited as current-checkout acceptance.

| Check | Status | Scope / provenance |
| --- | --- | --- |
| `npm run build` | **PASS** | Fresh continuation run via the Next CLI after fixing the billing test fixture's TS2559 error |
| Typechecking | **PASS** | Fresh `tsc --noEmit --incremental false`; no diagnostics |
| `npm test` | **111 passing, 0 failed** | Fresh continuation run via `tsx --test tests/*.test.ts` after the type-only fix |
| `npm run test:infra` | **8 passing** | Fresh audit run earlier in this conversation; also passed in the recovered OpenCode run; infrastructure unchanged |
| Scoped worker/infrastructure typecheck | **Recorded PASS** | Historical scoped check; current whole-project TypeScript check also passes |
| `npm run build:services`, bundle syntax and CLI smoke checks | **Recorded PASS** | Historical worker/schema/import bundle checks; not rerun in this continuation |
| Offline CDK synthesis | **Recorded PASS** | Historical synthesis only; current infrastructure tests passed, no deployment |
| Migrator dry-run / PostgreSQL fixture replay | **PASS** | Fresh database-free dry run and application fixtures cover six journaled migrations through `0005_saved_view_preferences.sql` |
| `npm audit --omit=dev` | **0 vulnerabilities** | Recorded after BullMQ **5.81.5** / ioredis **5.11.1** updates |
| Full `npm audit` | **4 moderate dev-only findings** | Drizzle Kit's older esbuild loader chain; direct service bundler uses esbuild 0.28.2. Details in [deployment](deployment.md#dependency-audit--12-september-2026) |
| Browser E2E / responsive / scoped Axe | **19 passing, 0 failed** | Recovered completed OpenCode command output from 16 September; 8.3 minutes, one worker, default Chromium; not rerun here |
| Real provider accounts, Business-app coexistence and delivery | **NOT LIVE-VALIDATED** | Requires the intended credentials, accounts, permissions and actual signed events |
| Docker execution, AWS rollout, real queue recovery and restore exercise | **NOT LIVE-VALIDATED** | Build/synth/fixtures do not establish a configured deployment |

## Pre-hardening continuation provenance
The recovered OpenCode session `ses_f5588df47ffe2duC3aEl3uiQZV` ("Resume previous work", `H:\new-app`) completed 19 browser tests, 111 application tests, 8 infrastructure tests and the six-migration dry run on 16 September. Its last build failed at `tests/connected-services.test.ts:392` with TS2559; the subsequent chained typecheck did not run.

This continuation added an explicit parsed-plan type to the fixture at `tests/connected-services.test.ts:38`, without changing runtime application behavior. Fresh build, TypeScript, 111 application tests and migration dry-run checks all passed. Test processes used an isolated environment with live-provider settings removed and SQLite set to memory; the migration dry run reported `databaseContacted: false`. Browser evidence comes from the recovered completed command, corroborated by `test-results/.last-run.json`; it is not a new browser run or a new visual inspection. No OpenCode/Next/Playwright process or listener on ports 3000/3100 was detected before resuming. Dependency audit figures above remain historical, not a fresh security certification.

## Backend and connected-service evidence

The [backend verification record](backend-verification.md) and [connected-services runbook](connected-services.md) describe the baseline contracts. The previously executed suite covered:

- PostgreSQL/PGlite migration application, non-bypass-role tenant RLS and context cleanup, composite-reference rejection, transaction rollback, exact paise persistence, duplicate receipts and refund ceilings.
- Stable member-ID ownership, same-name counsellors, role/actor spoofing, membership changes, task/appointment/file scope and positive public-field allowlists.
- Signed WhatsApp routing, phone-app echoes, duplicate/out-of-order inbound/status events, acceptance/callback races, final dispatch guards, stable request IDs, stale claims and safe retry/reconciliation.
- Autonomous demo replies and human takeover without provider/KMS/R2 calls; mocked media download, ElevenLabs transcription/synthesis, private R2 audio and text fallback.
- SQL/domain parity for enquiry views and sorts, filtered count/page consistency, malformed/offset timestamps, tie ordering, source/chunk isolation and full-text fallback when optional vectors are absent.
- Manual and AI booking preflight, Google busy/outage and self-event exclusion cases, permission/connection races, local clash revalidation, pending cancellation sync and booking-job recovery without resending the accepted reply.
- Google OAuth/PKCE state, deterministic one-way Calendar insertion/cancellation/stale-write handling, team invitation/membership projection, Meta form deduplication/consent, SSE revalidation/cleanup, and persisted SaaS billing lifecycle/retry behavior.

These are application/fixture and mocked-provider checks. They do not establish paid-model response quality, real WorkOS email/session behavior, Google calendar writes, actual Razorpay collections, Meta app approval, R2 CORS or an operational AWS queue.

## Tooling evidence

The [deployment runbook](deployment.md) records the eight tooling tests and scoped checks:

- Offline CDK resource/secret-selector contracts, TLS ALB/health path, private node-based Valkey/noeviction, digest-pinned images and in-memory queue URL construction.
- Exact rupee-to-paise conversion, overflow/fractional-paise rejection and migration-journal/history validation.
- Explicit WorkOS mapping preparation/verification, stable legacy member IDs, unresolved labels/references and duplicate-contact reporting.
- Read-only SQLite input, coherent WAL backup, default offline report, demo exclusion and omission of credential/session content from reports.
- Repository import round-trip, ID/money/history preservation, preflight collision rejection and resume that refuses changed tenants.

The normal Drizzle journal now includes ten migrations, `0000` through `0009_connection_binding`, including `0008_org_provisioning`; all snapshots are included. Preserve the immutable institute trial ledger and intake receipts during restores; see [subscription rollout and recovery](deployment.md#subscription-rollout-and-recovery). The optional `drizzle/optional/pgvector.sql` remains separate; local tests cover the extension-absent fallback, not a real vector-enabled deployment.

## Browser QA — fresh local/fixture run
`node scripts/verify.mjs --browser` reports **37 passed in 21.3 minutes** on 19 September, using one worker and default Chromium against disposable SQLite. The 19-test runs on 16–18 September are baseline history. In addition to the subscription regressions documented above, the suite includes:

1. CSV → recovery → inbox → counselling → receipt persistence, local registration/sign-in, and cross-origin/cross-workspace rejection checks.
2. Exact recovery collections and distinct paid-student chart data, including multiple receipts and a refund.
3. Enquiry pagination, stable bulk owner IDs, server-side `view`/`sort` restoration after clearing local storage, and query-error handling.
4. Demo autonomy/human takeover, unchanged request UUID/payload across retry and reload, team actions, demo billing/integration states and fixture-based role affordances.
5. Counselling reschedule/cancel/ICS and local onboarding; keyboard command search, dialog Tab containment, Escape and focus restoration.
6. All 12 routes at 320/375/414/768 px with reduced motion (48 route/viewport combinations); local onboarding at the same widths. Desktop tests use 1440×1050.
7. Zero Axe violations for overview, open enquiry form and inbox under `wcag2a`, `wcag2aa`, `wcag21aa`; no uncaught browser errors in the executed suite.

The public-page suite also checks no workspace requests on public pages, light/dark accessibility, fictional-preview and pricing disclosures, user-initiated audio/transcripts, missing-media fallback, theme persistence, all workspace screens in dark theme and 200-percent CSS zoom. This is local/fixture acceptance of the subscription-enforced checkout, not live-provider verification or whole-product accessibility certification.

### Harness and artifacts

- `playwright.config.ts` points to `tests/browser`, starts `npm run dev -- --port 3100`, uses one worker and does not reuse an existing server.
- Browser base URL: `http://127.0.0.1:3100`; direct Playwright runs default to `.data/browser-tests.sqlite`. `npm run verify:browser` supplies `ADMITFLOW_BROWSER_DB` pointing to a disposable temporary database.
- The normal preview uses port 3000 and `.data/admitflow.sqlite`.
- Run local browser fixtures with `DATABASE_URL` unset: `ADMITFLOW_DB` does not override a configured PostgreSQL connection. Hosted identity tests require an explicitly configured/controlled environment.
- The browser suite writes `test-results/overview-1440.png`, `enquiries-1440.png`, `inbox-1440.png`, `overview-375.png` and `inbox-375.png`. The fresh run uses the same filenames, so prior images may have been replaced. Passing automated checks are not a separate manual visual inspection.

## Material implementation limits / open findings

### Reporting and saved preferences — resolved before this continuation
`revenueReport()` in `src/lib/domain.ts` now provides shared headline/chart data, distinct paid students, integer-paise sums, Indian-calendar-day windows and refund-date cash flow. Domain tests and the recovered browser chart test cover instalments, refunds and matching totals. Counts mean distinct students paying within the selected window, not necessarily first-ever admissions.

Saved enquiry views persist `view` and `sort` via migration `0005_saved_view_preferences`; server values take precedence over legacy browser fallback. Domain/API/PostgreSQL and recovered browser tests cover restoration without local storage.

### Admission-payment webhook — local regressions passed; live acceptance pending
- **High, original finding:** refund-before-capture was acknowledged and lost. The new hosted route persists minimal signed references in `event_receipts`; the worker fetches authoritative capture/refund state and commits financial changes before receipt completion.
- **Medium, original finding:** floating-point totals rejected a valid 10 + 20 paise refund against a 30 paise capture. Refund ceilings now compare integer paise; payment-link validation rejects fractional paise rather than silently rounding.
- **Medium, original finding:** unsigned bodies were buffered before enforcing size limits. The route now streams through the 500,000-byte helper. The UTF-8 decoder preserves a leading BOM so signatures are checked against unchanged content.
- Claims use random tokens and conditional completion/failure updates. Provider IDs keep financial replay idempotent; changed merchant-key fingerprints require operator reconciliation, not automatic rebinding.

All 15 tests in `tests/payments.test.ts` passed, independently and within the 129-test application run. This provides local/mock-provider regression evidence for the original defects; real merchant delivery/recovery remains a staging gate. No additional migration was added; the implementation uses the existing server-only receipt registry.

### Access-management concurrency — repaired with local regression evidence
**High-severity historical reproduction:** controlled execution of the original `src/app/api/team/route.ts` POST handler, with only its authentication/WorkOS dependency injected and all store/authorization/projection helpers real, reproduced these races against in-memory PGlite:

- Two owners self-demoting to admin: two provider writes, HTTP `[200, 200]`, zero active owners in both provider mock and persisted workspace.
- Each owner deactivating the other: two provider writes, HTTP `[403, 403]`, zero active owners in both stores. Final reauthentication does not undo already-issued changes.
- One owner demoting the other while the other deactivates the first: two provider writes, HTTP `[403, 200]`, zero active owners in both stores.

That reproduction transpiled the then-unmodified route in memory and used controlled dispatch barriers, without live provider/database calls. Separate helper-level checks also showed stale team snapshots restoring removed privileges; auth projection was initially a static finding.

**Implemented repair:** `src/lib/db/team-access.ts` uses a tenant-scoped receipt with random fencing tokens and `idle/prepared/dispatched` phases. Short organization-locked transactions claim and fence projections; WorkOS requests occur outside those access transactions. Team POST claims before fetching a fresh snapshot and rechecks actor/last-owner authorization before dispatch. Auth captures its fence before fetching membership and rejects stale results. Unchanged identity/team reads avoid revision churn; stable member IDs survive provider membership recreation.

Prepared claims expire after 120 seconds; dispatched intents never expire into permission to write again. After 120 seconds, an unaffected administrator's team GET may confirm only an exact positive provider postcondition, rotate the token, reconcile members/invitations/seats and release. Missing/unchanged/wrong-tenant evidence cannot clear the intent. The membership target cannot authenticate while its operation is dispatched. The application SDK client uses `maxRetries: 0` and a 15-second fetch timeout; an abort is not proof that WorkOS rejected a write.

`tests/team-access.test.ts` now executes actual auth and route source with controlled provider barriers and all eight migrations in PGlite. The three owner-loss interleavings permit only one dispatch and retain an owner after retry. Further regressions cover delayed real auth/GET projections, lost responses, tenant isolation, expired prepared writers, stale tokens, invitation/seat recovery and deduplication, stable member IDs and no-op revisions. The full application run passed these plus the actual SDK transport regression. The earlier focused run passed 36 access/connected-service entries and TypeScript before the SDK test was added.

**Remaining boundary:** these fixtures do not prove multi-server PostgreSQL locking, provider read consistency or live WorkOS behavior. Direct console changes are outside app serialization. Once dispatch is invoked, even explicit provider errors conservatively retain the access intent unless positive success evidence appears; terminal or permanently unknowable outcomes require separately reviewed operator reconciliation. There is no operator-clear CLI. See [recovery and rollback](deployment.md#team-access-recovery); never delete a receipt or re-enable unfenced writers to unblock access.

### Full-projection throughput

Native `/api/leads` pagination is implemented and used by the enquiry table. The shell still separately loads `/api/workspace`; canonical mutations/worker paths read full tenant collections and serialize same-institute transitions. Counsellor filtering happens after a whole-workspace clone.

The [documented synthetic measurement](backend-verification.md#full-projection-performance-inspection) produced owner JSON over **4 MB at 1,000 leads / 5,000 messages**, and over **41 MB at 10,000 / 50,000**. It excluded database, network, provider, browser and production concurrency costs. This establishes a concrete projection concern, not a tested maximum-capacity or latency SLA. Targeted projections and actual load testing are needed before large-institute rollout claims.

### Functional scope and live behavior

- Google synchronization is **AdmitFlow → Google only**, with one institute calendar and snapshot availability checks. External changes can race a later write; local booking and remote sync confirmation are distinct.
- SaaS billing now enforces the selected lifecycle policy: one durable seven-day hosted trial, verified active coverage bounded by five-minute freshness and current-period end, immediate known past-due/terminal restrictions, and mutation/provider guards for outbound, AI, new enquiries, invitations and reactivations. Configured member/enquiry quotas remain separate; this is not a comprehensive usage/spend ledger. Cycle-end cancellation, upgrades/proration and SaaS refunds remain unimplemented. Admission collections and their recovery remain independent of subscription permission.
- Meta coexistence is requested during onboarding and recorded verified only on an appropriate signed Business-app echo. Real account eligibility, both sending paths, signed callbacks and ownership behavior still need live validation. Demo echoes cannot establish this.
- Optional vectors, actual OpenAI/ElevenLabs quality/voice behavior, provider scopes, private-bucket CORS, missing-status reconciliation, orphan-upload retention, container execution and restore behavior remain configured-environment work.
- Broader contacts/guardian relationships and configurable pipeline/workflow definitions remain roadmap features. Saved-view `view`/`sort` persistence is now implemented; older inventory statements to the contrary are superseded.

## Historical MVP verification — not current acceptance

The following results were recorded **before the current production-stack implementation and 12-screen redesign**, during the original ten-screen SQLite/custom-auth/Twilio MVP:

| Historical check | Recorded historical result |
| --- | --- |
| Original `npm run test:e2e` | **9 tests passed** |
| Original `npm test` | **7 domain tests passed** |
| Original build/typechecking | Passed for that earlier implementation |

That browser run covered CSV → demo recovery/reply → local counselling → manual receipt → reload persistence; command search/knowledge editing; local account/session isolation; ten-screen checks at 320/375/414/768px; and limited Axe scans of the overview/enquiry form. It did not validate the new WorkOS/Neon/Meta/SaaS flows or today's CSS. Old screenshots and the former Twilio setup are historical context, not evidence or configuration instructions for the current application.
