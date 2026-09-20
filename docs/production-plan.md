# AdmitFlow — implemented architecture and release follow-up

> **19 September 2026 supersession notice:** This inventory retains the 12 September handoff and its historical test counts. Use the dated [README handoff](../README.md) and [verification record](verification.md) for subsequent evidence, including the CSS-zoom fix; those results do not establish validation of later repairs. Shared distinct-student reporting, server-persisted saved-view preferences, payment/access hardening, subscription enforcement and deferred intake are implemented. This documentation refresh is not a new validation run. Current source, the complete [Drizzle journal](../drizzle/meta/_journal.json) and [deployment/recovery runbook](deployment.md) take precedence over historical inventory details. Independent review, credentialed provider/cloud staging, Docker, capacity and restore gates remain open.

Original inventory: 12 September 2026. **The core application and light 12-screen UI are built; local browser QA is now recorded in the README linked above.** The original evidence paragraph below is preserved as history. This document does not certify a deployed or fully production-ready service.

The user's decisions are resolved: **Neon + Drizzle, WorkOS AuthKit, Cloudflare R2, AWS hosting, Meta WhatsApp Cloud API, OpenAI autonomous mode and ElevenLabs speech**. The existing WhatsApp Business app number should use Meta's coexistence-enabled onboarding. Counsellors retain human override. Native ElevenLabs Agents WhatsApp is not the selected transport.

**Historical 12 September report:** `npm run build` and typechecking passed, with **94 `npm test` cases** after the BullMQ/ioredis dependency updates. The **8 tooling tests**, worker bundles, migration checks and offline CDK synthesis passed separately; browser QA was pending at that handoff. Later results supersede that status without changing this historical count. [Verification and provenance](verification.md).

## Product and current interface

AdmitFlow supports an institute team's enquiry → follow-up → conversation → counselling → payment workflow, with NEET/JEE-oriented sample content and configurable courses. The English interface exposes English/Hindi/automatic reply-language settings. Demo people, fees and messages are fictional.

The implemented main routes are Overview, Enquiries, Admissions pipeline, Shared inbox, Counselling, Recovery campaigns, AI & automations, Knowledge base, Revenue analytics, Team & access, Integrations and Settings. Settings includes SaaS billing. Hosted onboarding/institute switching is a separate flow. The light shared shell, CSS layers and page components are applied; local browser/responsive/scoped accessibility evidence is recorded in the linked release records, not a live-provider certification.

The [accepted UI direction](production-ui-direction.md) uses the existing eight inspected references. Additional image research or a new design-selection pass is not needed.

## Implemented stack

| Layer | Current implementation |
| --- | --- |
| Application | Next.js **16.3.5**, React/React DOM **19.3.0**, TypeScript, Node **24**; App Router and Node API handlers |
| Interface | Custom shared components, Radix primitives, native dialogs, Tailwind 4 and layered CSS; Geist, Lucide, Recharts; React Hook Form/Zod |
| Data UI | TanStack Query and React Table **8.21.3**; native server-filtered/count/paginated enquiry queries; full workspace projection still used by the shell and mutations |
| Local preview | Node SQLite, cookie-scoped demo sessions and local evaluation accounts when `DATABASE_URL` is absent |
| Hosted database | Neon PostgreSQL with Drizzle/`pg`, tenant transactions/RLS, composite references and financial constraints; apply the complete current Drizzle journal |
| Hosted identity/team | WorkOS AuthKit, organizations, verified memberships, stable member-ID assignment and owner/admin/counsellor/analyst authorization; invitations and team reconciliation |
| Background work | BullMQ **5.81.5**, ioredis **5.11.1**, Node worker, durable PostgreSQL jobs, bounded retries and reconciliation; private node-based Valkey/noeviction in CDK |
| Inbox updates | Revision-based SSE with periodic checks, heartbeats, reconnection and WorkOS membership revalidation; changes trigger an authorized workspace refresh |
| Messaging and AI | Tenant Meta Cloud API connections, templates, signed incoming/status/phone-echo handling, OpenAI grounded autonomous replies, assisted/paused modes and human takeover |
| Speech/files | ElevenLabs transcription and optional voice-note replies; private R2 upload/finalization/download, media checks and document ingestion |
| Retrieval | Article chunks and PostgreSQL GIN full-text search; optional pgvector/embeddings behind `KNOWLEDGE_VECTOR_ENABLED` |
| Connected outcomes | Google OAuth/free-busy/outbound appointment sync, Meta Lead Ads intake, institute Razorpay payments/refunds, separate platform SaaS billing lifecycle |
| Deployment tooling | Docker standalone web and bundled worker; CDK ECS/Fargate, ECR digests, TLS ALB, existing application secret selectors, KMS, CloudWatch and Valkey. Synthesized locally; not deployed |

WorkOS supplies hosted authentication/invitation email behavior. Application notifications through Resend and Sentry instrumentation are still unwired placeholders, not delivered features.

## Implementation inventory and remaining scope

| Area | Working code / local verification | Remaining work or configured-environment dependency |
| --- | --- | --- |
| UI/navigation | Twelve implemented screens, role-aware navigation, command search, enquiry drawer, loading/error/empty states, responsive CSS | Local browser/Axe/viewport coverage is recorded in the README and verification ledger; build success alone does not establish usability |
| Accounts/team | AuthKit login/callback/logout, organization create/switch, membership validation, invite/role/deactivate/reactivate/revoke actions, last-owner protection, team UI | Actual WorkOS accounts, email/activation and role setup need a configured pilot; durable WorkOS Events API cursor synchronization is not implemented |
| Enquiries | Manual/CSV intake, validation/deduplication, bulk owner-ID assignment, tags/custom-field data, export, server-persisted saved filters/view/sort, SQL view/sort/count/page endpoint used by the UI | The model still couples contact and enquiry, with tenant phone uniqueness. Separate household/guardian/contact relationships, merge review and full import history remain roadmap work |
| Tasks/pipeline | Stable member assignments, due tasks, activity records, eight fixed stages, drag and explicit stage controls | Configurable stages/transition rules, richer task/reminder management and branch-scoped organization modeling remain future scope |
| Recovery/automation | Selected audiences, approved-template selection, recipient/job records, delay playbook, pause/resume, stop guards and run-history/retry UI | Arbitrary condition/workflow graphs, versioned publishing, comprehensive sending-window configuration and richer sequence analytics are not implemented |
| WhatsApp/inbox | Per-institute onboarding/manual connection checks, WABA subscription, shared threads, reply/note/draft/attachment actions, signed callbacks, phone-app echo takeover, acceptance/reconciliation states | Real account eligibility, template/scopes/delivery and same-number coexistence need live validation. Header-media/dynamic-button template workflows, call support and historical chat import are outside the current adapter |
| Autonomous AI | Institute knowledge/model/language/instructions, daily message budget with in-flight reservation, guarded reply/qualification/booking proposals, human override, demo simulation | Paid-model quality/language evaluation and real usage remain unvalidated; complete token/cost/seat entitlement accounting is not implemented |
| Knowledge/files | Article editing/version counters, document ingestion, tenant chunks, full-text retrieval, private immutable finalization and authorized downloads; mocked speech/R2/media tests | Full version-history management, orphan/pending-object cleanup and retention need further work. The vector-enabled branch needs a vector-capable database/provider run |
| Counselling | Booking/reschedule/cancel/outcomes, local owner-ID clashes, Google availability/self-event checks, deferred AI booking jobs, sync-state UI and ICS export | **One institute calendar; AdmitFlow → Google sync only.** No inbound Google-change import or per-counsellor OAuth calendars. Availability is not an atomic external reservation |
| Admission money | Positive INR receipts, exact paise persistence/display, duplicate-reference/refund-balance protection, offline refund recording, Razorpay payment links and captured/refund event reconciliation | Actual merchant verification is pending. Payment links are not collected funds. Full instalment schedules, invoice issuance and initiating provider refunds are not implemented |
| Revenue | Receipt/refund/net reporting, shared distinct-student charts/headlines, date/course/source views, ledger export and campaign association | No causal/incremental-lift claim |
| SaaS billing | Settings panel, configured plans, checkout, provider-confirmed state, signed webhook dedup/routing, uncertain-create reconciliation, immediate cancellation, verified invoice reads, member/enquiry quotas, subscription enforcement and deferred intake | Cycle-end cancellation, upgrades/proration, complete cost/usage accounting and SaaS refunds remain unimplemented; plans/accounts must be configured externally |
| Operations/migration | Safe schema runner, backup/dry-run SQLite importer, explicit verified WorkOS mappings, per-workspace atomic import/fingerprint resume, deployment resources and runbook | Actual AWS/Docker rollout, DNS/TLS, live queue behavior, restore exercises, alert delivery and throughput validation remain outstanding |

Detailed contracts and tests: [backend verification](backend-verification.md), [connected services](connected-services.md), [deployment](deployment.md).

## Runtime and data boundaries

```text
Local preview, DATABASE_URL empty
  Browser -> Next.js -> SQLite workspace aggregate / local session
                     -> deterministic demo actions, no provider calls

Hosted mode, DATABASE_URL configured
  Browser -> WorkOS session + verified organization membership -> Next.js API
          -> tenant-scoped Neon queries / authorized workspace projection
          -> private R2 object operations and provider adapters
  Signed provider webhooks -> server-maintained tenant routes -> durable records
  Node worker -> organization registry -> Neon jobs -> BullMQ -> guarded provider action
  SSE -> revision notification -> authorized client refetch
```

`DATABASE_URL` selects the database path; `NODE_ENV` or a successful Next build alone does not select hosted behavior. Production containers reject absent database configuration. AuthKit credentials and a real organization membership are required to access a hosted institute; the local anonymous demo path is not substituted for that session.

### Historical schema inventory

The 12 September schema inventory had **21 tables**, rather than every entity from the former proposal. This list predates subscription-trial/deferred-intake additions; use `src/lib/db/schema.ts` and the full Drizzle journal for the current schema:

- Institute/identity projection: `organizations`, `members`, `organization_routes`.
- CRM/work: `leads`, `tasks`, `activities`, `saved_views`.
- Messaging/recovery: `messages`, `campaigns`, `campaign_recipients`, `jobs`, `connections`, `connection_routes`.
- Counselling/money: `appointments`, `payments`, `refunds`.
- Knowledge/files: `articles`, `knowledge_chunks`, `files`.
- Event/operational records: `event_receipts`, `sync_cursors` (the table exists; a WorkOS event-sync loop is not wired).

Courses, team labels, sequence/AI settings and the subscription projection currently live on the organization record. Conversations are derived from lead/message records; contacts and enquiries are not separate relational models yet. Optional vectors extend the knowledge table through `drizzle/optional/pgvector.sql`.

Tenant business queries use transaction-local `app.organization_id` and RLS with a non-bypass runtime role. Composite references cover ownership, enquiry/message/file relationships, campaign attribution and money. Server routing registries are distinct from caller-selected tenant IDs. `Lead.ownerId`, task and appointment owners reference the stable local `Member.id`; `Member.workosId` is the external WorkOS user ID. Display-name matches do not grant WorkOS ownership.

Payments/refunds are **INR** and stored as integer paise; domain/API display amounts are rupees. `leads.value` remains integer-rupee potential course value. Exact money formatting preserves paise; compact chart labels are approximate. Migration `0010_native_instants.sql` converts 31 historical relational instant columns to `timestamptz(3)` with strict preflight and finite constraints; later operation timestamps use the same adapter. Domain/API values remain canonical UTC strings. The text-date helpers from `0004` are historical, not the current repository comparison path.

### Autonomous sending and human ownership

Autonomous mode is approved and implemented, with assisted and paused modes also available. It does not require a counsellor to approve every eligible reply. Instead, dispatch rechecks tenant access, ownership, latest incoming turn, opt-out/guardian/closed-state rules, reply window, AI mode/budget, campaign eligibility, current connection and worker claim immediately before the message request.

An application reply/takeover or signed Business-app `smb_message_echoes` event gives the conversation to a human and pauses further AI work. A signed echo can record coexistence as verified; a requested flag or local simulation cannot. [Transport/coexistence details](whatsapp-provider-review.md).

Messages are queued before dispatch, accepted after Meta acceptance, and sent/delivered/read after signed evidence. Stable request/message IDs, dispatch markers, callback deduplication and claim fencing prevent unsafe replay. Safe undispatched failures and idempotent service work have bounded retries; ambiguous outcomes enter reconciliation. Without an authoritative result, a send may remain unresolved instead of being guessed safe to resend.

ElevenLabs handles transcription and optional synthesized audio within this application-controlled flow. Pre-dispatch speech/media failures can fall back to text; a timeout after message dispatch cannot trigger an automatic second text send.

### Booking, money and updates

Counselling uses local constraints plus connected Google availability checks. An accepted local appointment remains `syncStatus: pending` until its outbound Google operation succeeds. AI proposals first queue `appointment.book`; parent-job `bookingState: booked` means local acceptance, not remote Google confirmation. Takeover, opt-out, AI pause or a newer student turn can cancel an unaccepted proposal.

Admission collections use each institute's merchant connection. Platform SaaS subscriptions use separate `BILLING_RAZORPAY_*` credentials/routes and never increment admission revenue. A checkout return does not mark an institute paid; provider state is verified. Offline refunds record money already refunded; they do not issue a bank refund.

SSE sends workspace/revision notifications and revalidates membership. It is a polling/reconnect mechanism, not a complete immutable event-log replay API. Login/request validation, team refresh and SSE checks provide current WorkOS membership enforcement; continuous WorkOS Events API projection remains future work.

## Setup and migration tooling

Use [.env.example](../.env.example) and the runbooks rather than the superseded Twilio/single-workspace environment model:

- Database: pooled runtime `DATABASE_URL`; direct `DATABASE_URL_UNPOOLED` for migrations; `DATABASE_POOL_SIZE` as needed.
- Auth/origin: `APP_BASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_WORKOS_REDIRECT_URI`. Configure the callback and `/onboarding` sign-out return with WorkOS.
- Queue/encryption: runtime `REDIS_URL`, optional HTTP-dispatch `CRON_SECRET`, AWS `KMS_KEY_ID` and region. ECS assembles a TLS URL from injected queue credentials.
- R2: account ID, access key, secret key and private bucket variables from the template; permit the exact signed upload headers/origin in bucket CORS.
- Meta: public app/config IDs at web build time, server app secret/verify token and reviewed API version. Institute access tokens/WABA/phone/Page mappings are stored encrypted through connection APIs.
- AI/speech: institute credentials or optional platform `OPENAI_API_KEY`, `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`; model/mode/budget are institute settings. Optional vectors use `KNOWLEDGE_VECTOR_ENABLED`.
- Connected services: Google OAuth/state variables, optional separate Meta Lead Ads verify token, and the platform billing keys/catalog documented in [connected services](connected-services.md).

```sh
npm run db:migrate -- --dry-run
npm run db:migrate
npm run db:import-sqlite -- --source .data/admitflow.sqlite
npm run worker
npm run build:services
npm run test:infra
```

The schema runner validates the Drizzle journal/hashes, locks the migration session and applies through the direct connection. Apply every entry in `drizzle/meta/_journal.json` in journal order; `0004_lead_view_dates.sql` was a historical endpoint, not today's migration boundary. Use `npm run db:migrate -- --dry-run` to inspect the release plan. Optional pgvector setup is separate.

SQLite import already exists. It makes a coherent backup and defaults to offline dry-run; explicit mappings and read-only WorkOS verification are required on apply. It preserves IDs and exact money, detects collisions, holds pending messaging work for reconciliation, and verifies committed workspaces. Resume accepts only identical completed imports. Local passwords/sessions are not fabricated into WorkOS identities; provider ciphertext and R2 object bytes require their own reviewed migration steps.

AWS/CDK defaults to Singapore alongside Neon Singapore. The reviewed Neon region list did not include Mumbai. Files use R2; AWS runs compute, queue, secrets/encryption and operations. Infrastructure definitions and cost drivers are in [deployment](deployment.md). No AWS deployment or actual provider account validation has been performed by these local checks.

## Remaining release follow-up

1. **Preserve browser evidence and rerun after changes.** The README and dated verification ledger record the latest complete local browser run, including the chart/200% CSS-zoom regression; these supersede the original pending status, not the need to validate later repairs.
2. **Preserve reporting consistency.** Admissions charts and headlines now share distinct-student reporting, exact paise totals and refund-date cash flow. The original receipt-count mismatch is historical, not an open defect.
3. **Complete a credentialed pilot.** Exercise the existing Business-app number through eligible Meta coexistence onboarding, actual signed echoes/statuses, OpenAI/ElevenLabs behavior, WorkOS membership/email, R2 CORS, Google and separate merchant accounts. Mocked tests establish application behavior, not real account readiness.
4. **Address full-projection throughput.** `readWorkspace` loads the tenant's collections and `scopeWorkspace` clones them. Mutations serialize on the organization and often repeat reads. The shell still loads that projection even though enquiries use `/api/leads`. A local synthetic owner response was over 4 MB at 1,000 leads/5,000 messages and over 41 MB at 10,000/50,000; these are not load-tested capacity guarantees. [Measurement scope](backend-verification.md#full-projection-performance-inspection).
5. **Validate rollout/recovery.** Container execution, actual AWS services, TLS/DNS, queue loss/restarts and a Neon restore exercise are outstanding. Restoring Neon does not rewind WorkOS, R2, KMS or provider delivery/payment state.
6. **Prioritize the explicit roadmap gaps above.** Billing commercial features, inbound/multi-calendar sync, richer CRM relationships/workflows, retained audit/version history, object cleanup and complete usage accounting need product/implementation decisions. They are not implied complete by the working core.

## Reference records

- [Current verification](verification.md), [backend implementation evidence](backend-verification.md), [connected services](connected-services.md), [deployment](deployment.md).
- [Accepted UI reference set](production-ui-direction.md) and [resolved WhatsApp decision](whatsapp-provider-review.md).
- Earlier external research links: [Neon regions](https://neon.com/docs/introduction/regions), [Neon/Drizzle](https://neon.com/docs/guides/drizzle), [WorkOS AuthKit](https://workos.com/docs/authkit/nextjs), [R2](https://developers.cloudflare.com/r2/), [BullMQ on ElastiCache](https://docs.bullmq.io/guide/redis-tm-hosting/aws-elasticache). These documentation references are not live deployment evidence.

`mvp-plan.md`, `ui-research.md` and the old MVP verification are historical context. The current source and linked implementation runbooks take precedence for configuration and behavior.
