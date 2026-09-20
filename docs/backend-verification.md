# Core backend verification and UI handoff

Current release evidence is maintained in [the dated verification ledger](verification.md) and [README](../README.md). The 18–19 September subscription addendum below is historical, not the latest repair acceptance.

## Historical subscription boundary addendum — 18–19 September

The complete isolated non-browser run passed **175 application tests / 8 infrastructure tests**, both typechecks, Next production build, five service bundles, operational checks and eight-migration dry run, exit 0. The final browser run passed **37 tests in 21.3 minutes**, followed by a passing project typecheck; both exited 0. See [exact evidence and prior attempts](verification.md#earlier-subscription-evidence--1819-september).

- `tests/subscriptions.test.ts` covers exact trial boundaries/invalid evidence, immutable identity across concurrent provisioning and workspace deletion, authoritative freshness/current-period checks, replacement and additive snapshot drift. `tests/subscription-intake.test.ts` covers legacy upgrade from the six-migration baseline, signed intake/rollback/replay, tenant RLS and controlled recovery.
- Actual workspace/team route and worker regressions cover denied paid mutations with existing-data/safety operations preserved, cancellation before the final dispatch check (no provider write), and cancellation after dispatch (confirmation remains allowed). Existing uncertainty/access fences and no-write-retry tests remain in the full suite.
- Speech transcription/synthesis and attachment denial cannot become a text fallback, second send, persisted generated audio or automatic retry. Every embedding batch and post-retrieval AI call rechecks subscription state; restricted errors propagate through fallback paths. Normal non-policy transient fallbacks retain their earlier behavior.
- Intake regressions cover duplicate/immutable bindings, mixed safety/status callbacks, partial-batch STOP handling, changed connections, quota rollback, retained Meta forms, earliest accepted timestamps and phone-matched cross-channel holds. Recovery creates no automatic replies/campaigns; imported contacts are human-owned.
- `0006_subscription_trials.sql` adds the non-cascading WorkOS-identity ledger and immutable-grant trigger, with migration-anchored grants for eligible legacy institutes. `0007_deferred_intake.sql` adds tenant-RLS intake, receipt/contact indexes and a 128 KiB JSONB bound. Both snapshots extend the journal without modeled schema drift; custom SQL behavior is separately exercised by fixtures.
- `infra/tests/infrastructure.test.ts` verifies that web and worker receive billing key/plan secret selectors, not plaintext task environment values, and that the worker does not receive the WorkOS API key or billing webhook secret.

These checks use PGlite/mocks and disposable browser data. Independent access review, real multi-replica/provider/restore exercises, optional pgvector-enabled validation, capacity redesign and lint adoption remain separate. No live requests, hosted migrations, deployments or commits were performed. Preserve trial and intake history using the [deployment runbook](deployment.md#subscription-rollout-and-recovery).

The active messaging design is **Meta WhatsApp Cloud API + OpenAI autonomous replies + optional ElevenLabs speech**. Existing WhatsApp Business app numbers require Meta's coexistence-enabled onboarding configuration. A connection's requested coexistence flag is not proof that the phone app and Cloud API are both working.

## Implementation delivered

### Identity, ownership and projection

- `Lead.ownerId`, task `ownerId`, and appointment `ownerId` reference the immutable local `Member.id`. WorkOS members additionally carry `Member.workosId` (the WorkOS user ID). `actor.id` is the authenticated user ID; `actor.memberId` is the canonical member record ID.
- `owner` remains a display label for the existing UI. Authorization never compares a lead's owner name with the actor's name.
- WorkOS membership status, organization, user identity, role, member ID, name and email are checked. Unknown roles fail closed. Profile refresh preserves existing member IDs and updates display labels on records already bound to that ID.
- Legacy/sample IDs are preserved. Missing local label IDs are deterministically hydrated. A legacy name match never grants ownership to a WorkOS identity. Explicit WorkOS user IDs from intake adapters can be normalized to their existing member record IDs.
- Production assignments require active WorkOS-backed owner/admin/counsellor members. Ambiguous names are rejected; inactive members and foreign IDs cannot be assigned.
- Counsellor projections and record actions filter by stable ownership, including existing task/appointment records before reparenting. File and knowledge references outside the permitted projection are removed.
- Public workspace responses omit encrypted connection secrets, arbitrary credential-bearing metadata, object keys, ETags and object credentials. Connection metadata uses a positive allowlist.

### Dispatch, callbacks and recovery

- Message state is `queued` before dispatch, `accepted` after a successful Meta acceptance response, and `sent` / `delivered` / `read` only after signed status callbacks. Signed Business-app echoes are observed manual sends.
- A durable dispatch marker is committed immediately before the final `/messages` request, **after** credential, template and attachment preparation. The guard reloads consent, reply window, guardian permission, human ownership, current assignment/recipient, latest inbound turn, campaign state, daily AI budget, worker claim and connection identity.
- Outbound UUIDs are stable idempotency keys in AdmitFlow and Meta's `biz_opaque_callback_data`. Reusing a request ID for different content/lead/attachment fails. A timeout after dispatch enters `reconcile`; replaying that request does not send again.
- Signed callbacks may arrive before the API response. The API response cannot downgrade a verified delivery or failure. Out-of-order statuses cannot regress delivered/read messages.
- Inbound provider IDs deduplicate messages and AI jobs. Historical messages remain in the thread without replacing the latest turn, unread state or its reply job. Opt-outs still stop automation even if the opt-out event arrives late.
- Signed `smb_message_echoes` pause AI on that conversation and set `metadata.coexistence = "verified"` plus `coexistenceVerifiedAt`. Local simulation and client-supplied metadata cannot set verified coexistence.
- Safe, undispatched transient failures and idempotent calendar/document/indexing work have at most **three automatic attempts**, with bounded backoff. Explicit Meta rejection can be retried; ambiguous acceptance cannot.
- Processing claims older than five minutes are recovered from Neon. Uncertain sends stay in reconciliation; safe work is re-enqueued. Claim fencing prevents a recovered worker's stale attempt from dispatching later.
- Admin `job.retry` preserves the original message ID, increments `retryGeneration`, and requeues only safely retryable failures. `confirmedNotSent: true` does not override ambiguous acceptance. Failed/completed BullMQ IDs are explicitly removed before durable pending jobs are re-added.
- The worker and bearer-authenticated `/api/jobs` use the same outbox dispatcher. Routing is paginated through the server-maintained organization registry, requires a matching WorkOS organization mapping, and excludes demo workspaces. Redis receives only workspace/job IDs.

### Speech and private files

- Incoming audio uses authenticated Meta media lookup, an HTTPS Meta-host allowlist, redirects disabled, declared and streamed size bounds, file-signature checks, and ElevenLabs transcription.
- With `ai.voiceReplies` enabled, generated replies are synthesized as MP3, saved privately in R2 with institute/lead/source metadata, uploaded to Meta, and dispatched as audio. The generated text remains the message body for the inbox.
- Ordinary transcription, synthesis, storage or pre-dispatch media-upload failures can produce a text fallback with `Message.voiceFallback`. Subscription restriction propagates instead: it cannot trigger fallback delivery or another paid call. A timeout after the message POST cannot cause a text resend.
- Counsellors can upload attachments only for an assigned enquiry. Knowledge/receipt/import uploads remain administrator operations. Authorization is checked at initiation, finalization, attachment dispatch and download.
- Finalization verifies declared metadata, exact size/type, ETag and bytes, then conditionally copies to a unique immutable key. Replaying an unexpired upload URL cannot replace the finalized object. Generated audio uses the same private, tenant/lead-bound metadata model.
- Demo suggestions, simulated replies, jobs, storage paths and connection setup are tested with provider/KMS/R2 methods that fail if called. No real credential or provider calls are needed for demo operation.

### Knowledge retrieval

- Article/document changes index bounded, overlapping chunks in the same tenant transaction. GIN full-text search supports English stemming plus simple multilingual tokens; source IDs remain article IDs.
- `drizzle/optional/pgvector.sql` optionally installs a 1536-dimensional vector column/HNSW index when the extension is available. The normal migration does not require pgvector.
- `KNOWLEDGE_VECTOR_ENABLED=true` enables OpenAI `text-embedding-3-small` indexing and tenant-filtered vector retrieval. Conditional chunk-ID/hash updates reject stale embeddings after article edits.
- Responses expose `retrievalMode: "keyword" | "full-text" | "vector"` and an optional `retrievalNote`. Missing extension, unindexed embeddings or lookup failures explicitly fall back. Local/demo retrieval remains keyword-based and provider-free.

## Frontend API contract

### Enquiry list

```http
GET /api/leads?q=Rahul&course=NEET&ownerId=membership_id&view=high-intent&sort=intent&page=1&pageSize=50
```

```ts
{
  leads: Lead[];
  total: number;       // count after tenant, role and query filtering
  page: number;       // starts at 1
  pageSize: number;   // 1–100, default 50
  hasMore: boolean;
}
```

- Filters are optional. `q` searches name, phone and email; SQL wildcard characters are treated literally. Existing defaults remain `view=all`, `sort=newest`, `page=1`, `pageSize=50`.
- `view=all|high-intent|needs-followup|admitted` and `sort=intent|newest|name` are validated enums. Unknown values return 400. Tenant/owner scope, query, course, stage and view conditions are combined before both SQL count and limit/offset; there is no unfiltered fallback on query failure.
- `high-intent` is `scoreLead(lead).score >= 70`. `needs-followup` uses `isStale`: at least seven days since `lastContactAt || createdAt`, excluding Admitted/Lost. It intentionally does **not** add campaign consent, human-ownership or enrolment restrictions. `admitted` requires stage Admitted. Combining `view=admitted&stage=Qualified`, for example, returns an empty page with total 0.
- `intent` orders by the existing score descending; `newest` preserves `createdAt DESC, id DESC`. `name` uses ASCII-case-insensitive Unicode code-point order, independent of database locale. Name and score ties use the same newest/ID tie-breaks.
- Scoring weights, signal patterns and stage/source rules are shared with the domain module. One server timestamp anchors recency/staleness for the entire count/page transaction, including the inclusive 14-day scoring and seven-day stale boundaries. Valid timestamp offsets are compared as instants, not lexicographically. Apply migration `0004_lead_view_dates.sql` before using SQL intent/staleness queries.
- `ownerId=unassigned` selects unassigned enquiries for roles permitted to see them. WorkOS user-ID selectors are normalized to member IDs. A counsellor cannot use the selector to broaden their scope.
- Neon count and page queries run in one repeatable-read tenant transaction. Normal authentication reads the membership projection, not the entire CRM, for this endpoint.
- `GET /api/workspace` and mutation responses still return the **transitional full authorized workspace projection**. Existing UI code can keep using it; the new route does not automatically migrate UI list state.

### Assignment and identity

```ts
{ type: "lead.create", lead: { name, phone, ownerId: member.id, /* other fields */ } }
{ type: "lead.update", id: lead.id, changes: { ownerId: member.id } }
{ type: "lead.bulk", ids: leadIds, ownerId: member.id }
{ type: "task.save", leadId, title, ownerId: member.id, dueAt }
{ type: "appointment.create", leadId, ownerId: member.id, startsAt, duration, kind }
```

`ownerId: null` unassigns a lead for an administrator. Name-only input remains compatible only when it resolves unambiguously. Counsellor-created leads are assigned to the authenticated member regardless of submitted ownership. Counsellors cannot reassign records to another member.

Use the response's `actor` for the signed-in user. `workspace.userName` is a response display value; record mutations no longer overwrite the institute's persisted owner name to attribute an action.

### Booking, rescheduling and cancellation

The existing `POST /api/workspace` actions `appointment.create` and `appointment.reschedule` now call the async `bookAppointment` orchestration in `src/lib/integrations.ts`.

```ts
// The response retains { workspace, result }; result now includes:
{
  appointmentId: string;
  syncStatus: "pending" | "local";
  availability: {
    source: "google" | "local";
    checkedAt: string;
    excludedExistingEvent: boolean;
  };
}
```

- Input/record permissions and local owner-ID clash checks run before provider access. Live workspaces with a connected Google calendar call the existing `calendarBusy` and `overlapsBusy` exports. A provider outage or permission failure blocks acceptance; it is not treated as an empty calendar.
- Google free/busy returns merged intervals without event identities. If a reschedule intersects a busy interval, the orchestration reads that calendar's event window (maximum four pages of 250 events). It excludes only the exact saved/deterministic event ID whose private workspace and appointment bindings match. Other overlaps, missing event details, wrong bindings and incomplete pagination fail closed. Google event IDs/details are not returned to the browser.
- The final synchronous tenant transaction rechecks actor access, current assignment, calendar connection identity, existing appointment version, local clashes, and a 30-second preflight freshness limit. Provider calls are outside the organization lock. The unchanged `calendar.ts` module remains responsible for actual Google writes and their idempotent event IDs.
- An accepted local appointment with Google connected is `status: "scheduled", syncStatus: "pending"` until the `calendar.sync` worker confirms the write. Local/demo bookings return `syncStatus: "local"`; demo execution never calls Google or decrypts provider credentials.
- Cancelling an appointment sets `status: "cancelled", syncStatus: "pending"` **before** enqueueing its calendar synchronization. A former `synced` value cannot imply the remote cancellation already happened.
- `applyAction` remains synchronous and validates only local domain invariants. Callers that accept live slots must use `bookAppointment`; direct domain calls are not provider-availability checks.

AI reply plans no longer create an appointment inside the synchronous message-plan mutation. An accepted proposal records a durable `appointment.book` job and displays “Checking the requested counselling slot”. The worker performs the same live preflight before creating the appointment and queueing `calendar.sync`.

The parent reply job exposes `payload.bookingState` (`pending`, `booked`, `conflict`, `failed`, or `cancelled`), `bookingJobId`, and, after acceptance, `bookingAppointmentId`. **`booked` means the local appointment was accepted; use that appointment's `syncStatus` for Google confirmation.** Busy slots create no appointment and request counsellor attention. Safe availability-read failures use the existing bounded retries. Takeover, opt-out, a newer student turn or AI pause cancels the pending proposal. Recovery/retry of this booking job never resends its already accepted WhatsApp reply.

Availability is a checked snapshot, not an atomic reservation spanning Google and Neon. External changes after the check can still race synchronization. The current connection represents one institute calendar, not separate Google calendars per counsellor. Older remote events lacking the verified private binding are not silently excluded as “our” event.

### INR display

`currency(1250.5)` now returns `₹1,250.50`; nonzero paise render with two decimals, including refunds and negative amounts. Integer rupees keep their existing whole-rupee display. Values are rounded to paise before formatting to avoid floating-point dust. Compact mode remains approximate (`₹1.3k`, `₹1.0L`), preserves signs, and promotes rounded `100.0k` to `1.0L`. Use non-compact formatting for exact payment/receipt amounts.

### Reporting window, collections and distinct students

`revenueReport(workspace, days, now?)` is the shared pure calculation for headline financial totals, daily/cumulative series, and the payment ledger's selected records. `metrics` and `revenueSeries` delegate to it. The overview and analytics data calculations share one report result per render, so the headline, chart, trend and ledger cannot choose different period cutoffs.

- Reporting uses **Asia/Kolkata (UTC+05:30)** calendar days, independent of browser/server local timezone. “Last N days” means midnight at the start of the first of N calendar days, including today, **through the supplied/current instant**. Both boundaries are inclusive. Today's bucket is partial; later events today and later dates are excluded. For example, a two-day report as of `2026-09-12T00:15:00+05:30` spans `2026-09-11T00:00:00+05:30` through that instant.
- The input `RevenueEvent.amount` and refund amounts remain INR rupees. Each amount is converted to integer paise before any aggregation. `report.money` and series `*Paise` fields expose exact minor-unit aggregates; existing display totals and series `value`/`cumulative` remain rupee numbers. Received payment objects and amounts are not rewritten.
- Gross collections include every qualifying receipt in the window. Paid admissions count **distinct `leadId`s within that window**, not receipts, campaigns or a lifetime first-payment cohort. Two instalments on different days still add only one student. A later receipt associated with a different campaign does not increment that student's recovery count again.
- The series `count` is cumulative distinct campaign-associated students; its final value equals `metrics.recoveredAdmissions`. `cumulativeAdmissions` tracks distinct students across all qualifying payments. A direct receipt can count a student in all paid admissions before their first campaign-associated receipt counts them in recovery admissions.
- Refunds are cash flow on their own recorded date. An in-window refund against a valid older receipt reduces this period's net collections, even when the receipt is outside the window. Recovery refund attribution comes from that receipt's `campaignId`. Future refunds, refunds against future/invalid receipts and missing receipt references are excluded. A refund-only period may correctly be net negative with zero paid admissions.
- Refunds change collections, not the distinct paid-student count. A full refund does not erase a qualifying receipt or rewrite an admission stage. This preserves the existing receipt-based metric meaning; it is not a count of currently active enrolments or causal recovery lift.
- Chart series use Indian day-start instants and the same cutoff as headlines. The payment ledger/export and enquiry-source gross-collection calculation use the report's selected payment records. Source gross figures remain distinct from the net-of-refunds recovery chart.

The implementation buckets payments/refunds once and accumulates student sets in chronological day order, replacing receipt-count accumulation and per-day nested scans. It remains a calculation over the authorized ledger already supplied to the UI, not a new reporting database or provider ledger.

### Persisted saved-view preferences

`view.save` accepts the existing `name`, `query`, `course`, `stage`, `owner` fields plus optional validated `view` and `sort`:

```ts
{ type: "view.save", name: "Priority by name", query: "", course: "NEET 2027",
  stage: "Qualified", owner: member.id, view: "high-intent", sort: "name" }
// result: { viewId, view, sort } (optional preferences are omitted if not supplied)
```

`SavedView.view` uses `all|high-intent|needs-followup|admitted`; `SavedView.sort` uses `intent|newest|name`. Invalid supplied values return 400 and are also rejected by database check constraints. Apply `0005_saved_view_preferences.sql` before deploying these schema reads/writes.

New saved views restore these preferences from the server on every device. Server values take precedence over any stale browser cache. Nullable columns preserve old records and their IDs/filters: only missing preferences consult the older workspace/name local-storage key, then fall back to the previous UI defaults (`all`, `intent`). The client removes obsolete browser preferences after the server confirms a new save; an older server during rollout can still use the legacy cache. Saved preferences do not alter tenant/owner authorization or the paginated lead API.

### Files

1. `POST /api/files` with `{ type: "begin", name, mime, size, purpose: "attachment", leadId }`.
2. Response: `{ id, url, headers, expiresAt }`. **PUT the bytes to `url` using every returned header**, including the two `x-amz-meta-admitflow-*` headers. The signed upload is valid for five minutes.
3. `POST /api/files` with `{ type: "finish", id }`. It is safe to repeat finalization; success returns `{ id }`.
4. `GET /api/files?id=...` checks current access and redirects to a three-minute download URL with a private/no-store response.
5. `message.send` accepts `fileId` for a ready attachment bound to the same enquiry, or an institute-wide ready knowledge document.

Maximum file size is **10,000,000 bytes**. The browser should send the declared MIME type; the server also checks content signatures. R2 CORS must permit the returned signed PUT headers and the application origin.

Image/document attachment captions are limited to 1,024 characters; longer captions are rejected rather than silently truncated. Audio messages store their transcript/generated text in AdmitFlow, while Meta receives the audio media payload.

### Messages, suggestions and jobs

```ts
{ type: "message.send", leadId, body, requestId: crypto.randomUUID(), fileId? }
{ type: "message.suggest", leadId, question? }
{ type: "message.simulate", leadId, body, echo?: boolean } // demo only
{ type: "job.retry", id: jobId }                         // administrator
```

- Preserve `requestId` when retrying the same HTTP request. Do not automatically create a new ID after a timeout or on `reconcile`.
- Render `accepted` as awaiting provider send/delivery status, not as sent. Render `reconcile` as unresolved delivery. Surface `voiceFallback` where present.
- Suggestions include source IDs/titles, retrieval mode, and an optional exact-slot booking proposal with `ownerId`. Proposal IDs are validated against supplied tenant-scoped data.
- AI daily reply limits use UTC dates and reserve in-flight work before generating replies. Local simulation remains the explicit way to exercise autonomy without credentials.
- `/api/jobs` requires `Authorization: Bearer $CRON_SECRET` and returns `{ organizations, enqueued }`; it enqueues durable work rather than selecting a single environment-bound workspace. `INTEGRATION_WORKSPACE_ID` is obsolete here. Run `npm run worker` to execute queued jobs.

### Connections

- OpenAI, ElevenLabs and Razorpay manual connections perform format and read-only provider/resource checks before reporting connected. Failure does not persist a connected record.
- WhatsApp exchange/manual connection verifies number ownership and subscribes the WABA. Set `coexistence: true` on `whatsapp.exchange` when using the existing Business-app number flow. Configure the Meta Embedded Signup config for coexistence; the backend does not infer it from the number label.
- Generic `service: "meta_leads"` connection requests call the connected-services helper `registerMetaLeadPage(workspaceId, { pageId: externalId, accessToken: secret.accessToken })`, which verifies the Page and subscribes `leadgen`.
- Integration booleans indicate available configuration, not a live end-to-end delivery certification. Account verification and coexistence verification are separate states.

## Migrations and verification

`0003_core_hardening.sql` and its Drizzle snapshot/journal entry are additive. The original `0000` unique-index-before-composite-FK fix is preserved. New composite foreign keys cover owners, file/lead relationships, task owners, campaign attribution and job/message sources. A deferred inbound-message FK allows the lead pointer and incoming message to be committed together.

The migration adds tenant RLS for knowledge chunks, refund-balance triggers, nonnegative/positive money and size checks, case-insensitive refund references, and dispatch recovery fields. Legacy live queued/failed messages lacking acceptance evidence are conservatively marked for reconciliation; original record IDs are retained.

`0004_lead_view_dates.sql` adds a bounded, UTC timestamp-to-milliseconds helper for native SQL score/staleness filters. Malformed legacy text returns NULL instead of aborting a list query. It needs no extension or PostgreSQL-16-only parsing function and rewrites no customer rows. Its snapshot/journal entry is included in the regular Drizzle migration sequence.

`0005_saved_view_preferences.sql` adds nullable `view`/`sort` columns and enum-value check constraints. It does not backfill defaults over legacy browser preferences. The PGlite test inserts an old-format saved view before applying this migration and verifies that its ID, owner and filters survive with absent optional preferences.

Verification covers:

- PostgreSQL migration application, real non-bypass runtime-role RLS, connection-local tenant-context cleanup, foreign-key rejection, integer paise round-trips, refund ceilings, duplicate receipts, and rollback on database constraint errors.
- Same-name counsellors, actor/role spoofing, revocation, task reparenting, file permissions, source isolation, streamed HTTP limits, signatures and tenant-bound AES-GCM tamper/cross-tenant rejection.
- Signed WhatsApp tenant routing and coexistence echoes; acceptance/callback races; duplicate/out-of-order messages; opt-outs; pause/takeover/latest-message races after template/media lookup; claim concurrency and restart recovery.
- Autonomous demo replies through `/api/workspace`, credential-free demo operation, bounded media downloads, mocked STT/TTS/R2/Meta audio flow and text fallbacks, and failed-BullMQ-ID re-enqueue behavior.
- Native SQL pagination/count filtering, chunk version replacement, and the optional pgvector migration's unavailable-extension path with honest full-text fallback.
- SQL/domain parity across all view/sort combinations, stable tie pagination, inclusive time boundaries, offset timestamps, malformed legacy dates, Unicode names, contradictory filters and same-name owner isolation.
- Live booking conflicts/outages, preflight permission and connection races, verified self-event exclusion on reschedule, other/paginated/incomplete event conflicts, local conflict revalidation, AI pending-booking recovery and provider-free demo bookings.
- Exact paise/negative/compact currency output and immediate pending cancellation synchronization.
- Distinct-student reporting across instalments and multiple campaigns, Indian calendar-day/year/leap-day boundaries, partial current days, future exclusions, old-receipt refunds, refund-only periods, full refunds, integer-paise totals and headline/series agreement.
- Saved-view API validation, server restoration without browser storage, server-over-cache precedence, legacy-row migration, database enum constraints and tenant isolation.

Final recorded verification: **`npm test`: 101 passing, 0 failed** (88 core-backend tests/subtests plus 13 connected-services tests). **`npm run typecheck`: passed**; the first invocation reached the runner's 120-second timeout without diagnostics, and the retry with a 300-second limit completed successfully. No new browser/image run, production build or credentialed live integration is asserted by this focused data fix.

Files changed in the final reporting/preferences pass: `src/lib/domain.ts`, `src/lib/actions.ts`, `src/lib/db/schema.ts`, `src/components/overview.tsx` (reporting data only), `src/components/leads.tsx` (saved-preference integration only), `drizzle/0005_saved_view_preferences.sql`, `drizzle/meta/0005_snapshot.json`, `drizzle/meta/_journal.json`, `tests/domain.test.ts`, `tests/repository.test.ts`, `tests/backend-security.test.ts`, and this document.

## Full-projection performance inspection

This release adds bounded server-side list results, not a rewrite of the canonical aggregate:

- `readWorkspace` issues one organization query plus 15 collection queries, loading all tenant leads/messages/jobs/appointments/payments/files/etc. It is not paginated. `scopeWorkspace` clones the whole aggregate before applying counsellor filters.
- Ordinary workspace mutations still perform full reads for initial authorization, the locked domain transition, and the final response. Calendar preflight currently adds the existing calendar helper's workspace read. The organization lock serializes same-institute transitions; changed rows are written individually. Campaign-recipient and article comparisons also contain nested scans.
- The Neon `/api/leads` path uses a narrow membership projection and native filtered count/page queries; it does not fetch conversation histories. An application shell that also requests `/api/workspace` still pays that separate full-projection cost.
- Score/staleness expressions require evaluation over the scoped candidate set; intent/name sorts and exact counts are not constant-time. Deep offsets also cost more. A page response is internally consistent, but separate page requests are not a frozen cross-request snapshot: writes and time-based score decay can reorder later pages.

### Local synthetic measurement

Measured on this Windows development environment with Node **v24.18.0**, using `publicWorkspace` followed by `JSON.stringify`, one warm-up and the median of three runs per phase. Each lead had five synthetic messages of approximately 420 characters and one task. The counsellor owned 35% of these fixtures. No database, network, authentication/provider calls, browser rendering, compression or production concurrency is included; this is not a capacity or latency SLA.

| Tenant leads / messages | Role / visible leads | JSON bytes | Projection median | Serialization median |
| --- | --- | ---: | ---: | ---: |
| 40 / 200 | Owner / 40 | 168,579 | 2.2 ms | 1.6 ms |
| 40 / 200 | Counsellor / 14 | 61,107 | 2.5 ms | 0.4 ms |
| 1,000 / 5,000 | Owner / 1,000 | 4,141,563 | 40.3 ms | 22.3 ms |
| 1,000 / 5,000 | Counsellor / 350 | 1,453,899 | 57.2 ms | 10.7 ms |
| 10,000 / 50,000 | Owner / 10,000 | 41,388,288 | 430.6 ms | 318.2 ms |
| 10,000 / 50,000 | Counsellor / 3,500 | 14,511,324 | 482.7 ms | 81.6 ms |

The concrete limit is already visible at 1,000 fixtures: the owner response exceeds 4 MB. At 10,000 it exceeds 41 MB, before database/transport/browser costs. Counsellor filtering reduces the response but not the initial whole-tenant clone. Large-institute release claims need targeted inbox/workspace projections and actual Neon/worker/browser load testing; the small sample-workspace performance does not establish those limits.

### Quota and operational limits reviewed, not expanded in this pass

The current AI limit is an application message-count guard using **UTC dates**, separate from the Indian financial reporting window. It counts non-draft outbound messages authored by `AdmitFlow AI` and reserves in-flight reply generation. That includes queued/failed rows and AI-authored campaign messages; it is not a provider token, rupee, speech-duration or embedding-spend budget. Manual suggestions and embedding operations do not share this reply counter. A provider-usage ledger, explicit spend/usage entitlements, and load-tested worker/database capacity remain larger release work. Existing full-projection, R2 orphan-retention, live coexistence and credentialed-provider verification limits still apply; this pass implements no infrastructure or quota redesign.

## Changed files

| Area | Files |
| --- | --- |
| Domain/auth/boundaries | `src/lib/domain.ts`, `src/lib/actions.ts`, `src/lib/permissions.ts`, `src/lib/auth.ts`, `src/lib/api.ts`, `src/lib/http.ts` |
| Persistence/retrieval/outbox | `src/lib/db/schema.ts`, `src/lib/db/repository.ts`, new `src/lib/db/chunks.ts`, `src/lib/db/knowledge.ts`, `src/lib/db/outbox.ts` |
| Providers/files | `src/lib/providers/ai.ts`, `src/lib/providers/meta.ts`, `src/lib/providers/speech.ts`, `src/lib/integrations.ts`, `src/lib/connections.ts`, `src/lib/files.ts` |
| API | `src/app/api/workspace/route.ts`, `src/app/api/files/route.ts`, `src/app/api/connections/route.ts`, `src/app/api/jobs/route.ts`, `src/app/api/webhooks/whatsapp/route.ts`, new `src/app/api/leads/route.ts` |
| Worker/migrations | `scripts/worker.ts`, `drizzle/0003_core_hardening.sql`, `drizzle/0004_lead_view_dates.sql`, `drizzle/0005_saved_view_preferences.sql`, `drizzle/meta/0003_snapshot.json`, `drizzle/meta/0004_snapshot.json`, `drizzle/meta/0005_snapshot.json`, `drizzle/meta/_journal.json`, `drizzle/optional/pgvector.sql` |
| Focused UI data integrations | `src/components/overview.tsx` reporting calculations/data props; `src/components/leads.tsx` saved-view preference serialization |
| Tests/handoff | `tests/domain.test.ts`, `tests/repository.test.ts`, `tests/messaging.test.ts`, new `tests/backend-security.test.ts`, `docs/backend-verification.md` |

## Required configuration and remaining live checks

| Area | Configuration |
| --- | --- |
| Neon | `DATABASE_URL`; `DATABASE_URL_UNPOOLED` for migrations; optional `DATABASE_POOL_SIZE`. Runtime role must not bypass RLS. |
| WorkOS | `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI` matching the registered callback, and supported organization role slugs. |
| Origin | `APP_BASE_URL`, matching the browser's scheme and host. |
| Queue | `REDIS_URL` (`rediss://` for TLS), `CRON_SECRET`; BullMQ queue name is `admitflow`. |
| Tenant secrets | `KMS_KEY_ID` plus AWS region/IAM permissions, or a base64 32-byte `INTEGRATION_ENCRYPTION_KEY`. Existing encryption uses the workspace ID as authenticated context. |
| Meta | `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_CONFIG_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, optional `META_API_VERSION`; institute token/WABA/phone ID stored as a tenant connection. `META_APP_ID`, if supplied for Page verification, must match the public app ID. Subscribe app webhook fields including `messages` and `smb_message_echoes`. |
| OpenAI | Per-institute key, or a valid platform `OPENAI_API_KEY`; the selected model must be accessible to that key. |
| ElevenLabs | Per-institute key/voice, or `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID`; `ai.voiceReplies` and a usable voice must be configured for audio output. |
| Google booking checks | Existing `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and tenant refresh-token/calendar connection. Its OAuth scopes must allow free/busy and event reads/writes; verified self-event rescheduling uses event reads. These hooks add no environment variables. |
| R2 | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`; private bucket with application-origin upload CORS. |
| Optional vectors | Apply `drizzle/optional/pgvector.sql` separately after regular migrations, then set `KNOWLEDGE_VECTOR_ENABLED=true` and run/retry `knowledge.index` jobs for existing articles. |

No live credentials, cloud provisioning, real WhatsApp sends or production queue/Neon/R2/WorkOS sessions were used in this verification. A credentialed pilot must still verify provider scopes, webhook delivery, Meta app review/template readiness, actual Business-app coexistence, the chosen ElevenLabs voice, private-bucket CORS and real queue restart behavior. The pgvector-enabled branch needs a vector-capable PostgreSQL integration run; the available local PGlite environment verifies the extension-absent path.

Template substitutions currently support body parameters `name`, `course`, `institute` / positions `1–3`; richer header/button parameter workflows are outside this adapter. A missing signed status can leave a send in reconciliation indefinitely because the backend deliberately does not guess acceptance. Pending/orphan R2 upload objects need an operational retention/cleanup policy. Large-workspace mutation/worker throughput still needs load testing because canonical workspace mutations remain serialized projections.

These are verified local/backend behaviors and explicit remaining checks, not a production-readiness claim.
