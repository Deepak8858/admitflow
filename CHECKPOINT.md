# AdmitFlow — implementation handoff

Documentation refreshed 19 September 2026. Workspace: `H:\new-app`.

## Resume from here

The latest review-repair evidence is the [19 September README handoff](README.md): **236 application tests, 14 infrastructure tests and 38 browser tests in 13.0 minutes**, with full verification/browser exit 0. Workflow lint and redacted history/source scans passed; fresh audits report zero production vulnerabilities and four moderate dev-only findings. Repaired-commit Linux CI/CodeRabbit review and configured-environment gates are still pending. [Verification](docs/verification.md) preserves earlier attempts and scoped evidence; the [deployment runbook](docs/deployment.md) owns current recovery procedures and launch gates. Use the complete [Drizzle journal](drizzle/meta/_journal.json), not a historical migration count.

Subscription enforcement and deferred enquiry intake supersede the earlier paid-access planning below. Live coexistence, provider/cloud setup, independent access review, Docker execution, capacity and restore checks remain separate gates. No historical local test run establishes deployment readiness.

## Historical 18 September handoff

The core application and light **12-screen redesign are implemented**. Payment/readiness hardening and the durable access-concurrency repair passed the uninterrupted 18 September full verifier: **143 application tests, 8 infrastructure tests, project/infra typechecks, Next production build, service bundles/CLI checks and six-migration dry run**. Browser rerun: **19 passed in 7.7 minutes**, disposable SQLite; final TypeScript also passed. The 17 September audit reported zero production vulnerabilities and four moderate dev-only findings; it was not repeated on 18 September.

Historical provenance: the 17 September `--all` run was interrupted during infra TypeScript after 129 application/8 infra passes; `--build` completed the remaining stages. The 18 September `--all` is a separate uninterrupted pass, exit 0. Its first browser attempt had 18 passes/one timeout: team fetching began 17.7 seconds after navigation, beyond the 15-second waiter, then returned 200. Only that navigation-spanning waiter was aligned with the existing 45-second navigation budget and awaited with `Promise.all`; all 19 tests then passed, exit 0. Logs and the initial failure trace are retained under `.data/verification-2026-09-18/`. No commits, live provider calls, hosted migrations or deployments were performed.

Current source: `src/lib/db/payment-inbox.ts`, `src/lib/providers/payments.ts`, the admission webhook, `src/lib/http.ts`, `scripts/worker.ts`, `src/lib/readiness.ts`, `src/lib/runtime-config.ts`, readiness/liveness routes and operational scripts. `tests/payments.test.ts` and `tests/readiness.test.ts` passed. `APP_BASE_URL` is blank in non-browser verification; browser verification sets its loopback origin.

Access repair is implemented in `src/lib/db/team-access.ts`, actual auth/team routes and fenced invitation/seat helpers, using existing `event_receipts` with no migration. Regression barriers now stop competing writes before dispatch and preserve an owner; actual delayed auth/team reads cannot restore revoked privileges. Uncertain dispatched operations stay blocked until positive WorkOS evidence; a membership target cannot authenticate while its operation is pending. The app WorkOS client disables automatic retries and uses a 15-second fetch timeout; real SDK/mocked-fetch tests cover five writes across eight failure modes. See `docs/verification.md` and the conservative operator boundary in `docs/deployment.md`. `DATABASE_URL` and `WORKOS_API_KEY` were cleared in `.env.example`; any previously real exposed credentials still require external rotation.

Read these current implementation records first:

1. [README](README.md) — practical preview/setup commands.
2. [Verification](docs/verification.md) — scoped results and historical evidence; the README records the later 38-test browser run.
3. [Backend verification](docs/backend-verification.md) — API contracts, identity/dispatch/booking behavior and measured projection limits.
4. [Connected services](docs/connected-services.md) — WorkOS team, Google, Meta intake, SSE and SaaS billing.
5. [Deployment](docs/deployment.md) — AWS, secrets, images, migrations, import, audit and rollback.
6. [Implementation inventory](docs/production-plan.md) — delivered functionality and remaining scope.

## Decisions and working constraints

- Approved stack: **Next.js 16.3.5, React/React DOM 19.3.0, TypeScript, Node 24; Neon + Drizzle; WorkOS; R2; AWS ECS/Fargate web and worker; BullMQ with node-based private Valkey/noeviction**.
- Approved messaging: **Meta Cloud API transport + OpenAI autonomous mode + ElevenLabs speech**. Counsellors retain human override. The user wants the existing WhatsApp Business app number through Meta's coexistence path. Native ElevenLabs Agents WhatsApp is not the selected transport.
- Default deployment placement is Singapore (`ap-southeast-1`) alongside Neon Singapore. Budget, actual account resources and credentialed rollout remain deployment work; Mumbai was absent from the reviewed Neon region list.
- Accepted design direction uses the existing **8 inspected Mobbin references** in [UI direction](docs/production-ui-direction.md). They are sufficient. Do not reopen image research, fetch new reference images or load skills.
- The OpenCode verification task is now complete. No OpenCode/Next/Playwright process or port-3000/3100 listener was detected before this continuation. Recheck process ownership before any future browser run; do not assume a preview server is active.
- No commit, push or cloud provisioning is part of this handoff. Keep actual credentials outside documentation/source control.

## Pre-hardening verification ledger

All passes below predate the 17 September runtime/tooling changes. They are historical baseline evidence, not acceptance of the current checkout.

| Check | Latest recorded result / provenance |
| --- | --- |
| `npm run build` | **PASS**, fresh continuation run after the test fixture typing fix |
| Typechecking | **PASS**, fresh `tsc --noEmit --incremental false` |
| `npm test` | **111 passing, 0 failed**, fresh after the type-only fix |
| `npm run test:infra` | **8 passing**, fresh audit run earlier in this conversation; infrastructure unchanged |
| Scoped worker/infrastructure TypeScript | **Recorded PASS**; current whole-project check also passes |
| `npm run build:services` / bundle syntax / CLI smoke checks | **Historical PASS**, not rerun here |
| Offline CDK synthesis | **Historical PASS**, no deployment; current infrastructure tests passed |
| Drizzle journal dry run + PostgreSQL fixture replay | **PASS**, six journaled migrations through `0005_saved_view_preferences.sql`; dry run contacted no database |
| Production dependency audit | **Historical 0 vulnerabilities**, not rerun here |
| Full dependency audit | **Historical 4 moderate dev-only findings**, not rerun here; see deployment runbook |
| Browser / responsive / scoped Axe | **19 passed**, recovered 16 September OpenCode output, 8.3 minutes; not rerun here |
| Configured-provider pilot, actual coexistence, AWS/Docker deployment and restore exercise | **NOT LIVE-VALIDATED** |

The previous **9 passing MVP browser tests and 7 domain tests are historical**, predating this implementation/redesign. They do not certify the current UI. Do not reuse old screenshots or test counts as current evidence.

## Implemented application map

- `src/components/workspace.tsx` and `src/app/[[...view]]/page.tsx`: Overview, Enquiries, Admissions pipeline, Shared inbox, Counselling, Recovery campaigns, AI & automations, Knowledge base, Revenue analytics, Team & access, Integrations, Settings. Billing is within Settings; hosted onboarding is separate.
- `src/app/tokens.css`, `workspace.css`, `surfaces.css`, `responsive.css`, `globals.css`: applied light design system. Recovered QA covers all 12 routes at four narrow widths and scoped keyboard/Axe checks; no fresh visual inspection was performed here.
- `src/components/leads.tsx`: actual `/api/leads` queries, server pagination/filter/sort, server-persisted saved-view `view`/`sort`, and bulk stable-ID assignment. Migration `0005_saved_view_preferences.sql` is required for hosted persistence. The shared provider still loads `/api/workspace` separately.
- `src/lib/db/*`, `auth.ts`, `permissions.ts`, `actions.ts`: normalized PostgreSQL tables, transaction-local tenant RLS, stable `Member.id` ownership, WorkOS projections, guarded mutations and local SQLite compatibility.
- `src/lib/integrations.ts`, `providers/meta.ts`, `providers/ai.ts`, `providers/speech.ts`, `files.ts`: controlled autonomous replies, ownership/consent/budget checks, acceptance/reconciliation state, signed phone-app echoes, private media and speech fallback.
- `src/lib/db/outbox.ts`, `scripts/worker.ts`: durable job dispatch, bounded safe retries, stale-claim recovery and graceful shutdown. Queue payloads contain IDs.
- Connected-service APIs and UI hooks are wired: Team GET/refresh/actions, BillingPanel, Google OAuth result notices, Meta Page registration helper, and revision-based SSE refresh/revocation.
- `infra/**`, Docker targets and migration scripts: deployment tooling plus backup-first, explicit-identity SQLite import. Existing provider ciphertext requires a separate rekey/reconnect migration.

## Material limits / follow-ups

1. **Projection throughput:** `/api/workspace`, canonical mutations and worker reads still load a full tenant aggregate and serialize same-institute transitions. A documented synthetic owner response already exceeded 4 MB at 1,000 leads / 5,000 messages. `/api/leads` pagination does not remove the shell's separate cost. Targeted inbox/workspace projections and actual load testing are needed for large institutes.
2. **Payment and access hardening passed local/mock-provider checks:** durable receipts, authoritative capture/refund reads, integer-paise checks, replay, rollback, tenant boundaries, access serialization and auth/team projection fencing have executable evidence. Real merchant and multi-replica WorkOS behavior still require staging. Unknown dispatched access outcomes fail closed indefinitely; no operator-clear CLI exists, and receipt deletion is not a recovery procedure.
3. **Google:** one-way AdmitFlow → Google synchronization, one institute calendar. Free/busy and bound-self-event checks are implemented, but availability is a snapshot and external changes can race the write. `booked` means a local booking; use `syncStatus` for Google confirmation.
4. **Billing:** catalog/checkout/provider-state/webhook/immediate cancellation, verified invoice reads and configured seat/enquiry quotas are implemented. Quotas cover app invitations/reactivations and manual/CSV additions, not full paid-status or usage enforcement. Cycle-end cancellation, upgrades/proration and SaaS refunds remain unimplemented. Admission money is separate.
5. **Messaging/media:** actual coexistence, template/scopes/account readiness and signed live callbacks are unvalidated. Only signed `smb_message_echoes` can verify coexistence; client flags and demo echoes cannot. Uncertain sends may remain in reconciliation without a signed result. Template parameters are limited to the supported body fields; orphan-upload cleanup is still operational work.
6. **Further scope:** normalized contact/guardian relationships, configurable stages, arbitrary versioned automation graphs, historical Meta-form backfill, richer administration and full cost/usage accounting remain roadmap items. Saved-view `view`/`sort` now persist server-side. Optional pgvector needs a vector-capable database run; local checks cover the extension-absent path.

## Commands and mode boundaries

For a local preview, leave `DATABASE_URL` and WorkOS/provider configuration unset, then run `npm run dev` at **http://127.0.0.1:3000**. Default persistence is `.data/admitflow.sqlite`. Demo simulation is provider-free; the continuous production worker is not needed to explore it. Local evaluation accounts do not create WorkOS memberships.

For hosted operation, configure `.env.example` / the existing Secrets Manager JSON secret, run reviewed migrations, and use WorkOS organization sessions. Per-institute provider tokens are configured through Integrations and encrypted using KMS. Public Meta app/config IDs and the WorkOS callback must match the web image's build-time values.

```sh
npm run db:migrate -- --dry-run
npm run db:migrate              # requires DATABASE_URL_UNPOOLED
npm run worker                 # requires DATABASE_URL and REDIS_URL
npm run db:import-sqlite -- --source .data/admitflow.sqlite
npm run build:services
npm run test:infra
```

The import command defaults to backup/dry-run and needs reviewed WorkOS mappings for `--apply`. `npm test` still targets `tests/*.test.ts`; tooling tests are a separate command. Direct esbuild is pinned to 0.28.2. Core framework versions and React Table 8.21.3 were preserved during the queue dependency update.

## Immediate next session

1. Start from the README's latest recorded release evidence and current deployment/recovery runbook, not the historical 18 September scope above. Revalidate review repairs before treating those earlier runs as acceptance of changed code.
2. Paid-access enforcement and deferred intake are implemented. Preserve durable operation gates and conservative recovery; targeted workspace/inbox projections and capacity testing remain follow-up work.
3. No application lint script is configured; the README separately records workflow lint. Keep the four moderate development-tool advisories visible rather than forcing an incompatible downgrade.
4. Prepare a separately authorized staging pilot for multi-replica tenancy/access, WorkOS recovery/late responses, private files, coexistence/handoff, signed callbacks, queue restart, payments and restore. Direct WorkOS console changes are outside app serialization. Never delete access receipts or roll back to unfenced writers to unblock a tenant.
