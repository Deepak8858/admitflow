# AdmitFlow — MVP plan

## Job and audience

An institute owner imports neglected enquiries; a counsellor prioritises, follows up, books counselling and records admissions. The owner sees revenue associated with recovery efforts. Audience and utilitarian visual direction were confirmed by the user.

## Implemented local MVP scope

- Revenue overview and time-range reporting.
- Lead creation, searchable/filterable lists, CSV column mapping, validation, deduplication and export.
- Lead detail, explainable scoring, ownership, activity history and consent state.
- Admissions pipeline, including keyboard/touch stage changes.
- Recovery campaign audience preview, scheduling and pause/resume.
- Shared inbox, human handoff, knowledge-grounded draft suggestions and clear message states.
- Knowledge-base CRUD for courses, fees, policies and FAQs.
- Follow-up sequence configuration and due-job processing.
- Appointment booking, clash checks, completion/cancellation and calendar-file export.
- Recorded admission revenue and campaign/source attribution.
- Isolated demo workspaces, account registration/sign-in, and workspace settings.

Live AI and WhatsApp use server-side environment configuration bound to a registered workspace. Without credentials, drafts and explicitly labelled demo scheduling remain useful. No fabricated delivery receipts, student replies or payments.

## Architecture

Next.js App Router + React + TypeScript; Node 24 built-in SQLite, WAL mode; Zod at the action boundary; server-side session cookies; scrypt password hashing. A small aggregate workspace snapshot is stored transactionally in SQLite. This is suitable for a single-instance pilot and reduces setup friction. Each request resolves a workspace from its session, not a client-supplied organization ID.

Shared pure domain functions own scoring, recovery eligibility, import validation, metrics and state transitions. The UI consumes the same model. Network calls run outside SQLite transactions and commit their results against fresh state.

Twilio adapter: approved recovery templates, free-form replies only inside the service window, signed inbound/status webhooks, opt-out suppression, no delivery claim on API acceptance. Optional OpenAI draft generation uses workspace knowledge with human review. A bearer-protected cron endpoint processes due follow-ups; creating a sequence alone does not start a background daemon.

## Data contract

Workspace → leads, messages, activities, campaigns, follow-up jobs, appointments, knowledge articles and admission revenue events. IDs are UUIDs; amounts are integer INR rupees; timestamps are ISO UTC; appointments display in Asia/Kolkata. Consent records include source and time. A revenue event requires a positive amount; changing a stage does not invent a payment.

## Production evolution

Migrate aggregate storage to PostgreSQL tables (organizations, memberships, leads, messages, activities, consent_events, campaigns, campaign_members, followup_jobs, appointments, revenue_events, knowledge_articles), with org_id on every tenant-owned row, composite uniqueness, row-level access enforcement and indexes on (org_id, status, next_action_at).

Use leased queue jobs and provider-aware idempotency/reconciliation for multi-worker sending. Store provider credentials per organization in a secret manager; add verified onboarding, team invitations/roles, password recovery, retention/export/deletion administration, backups and restore verification. Add real Google Calendar OAuth, Meta lead intake and payment reconciliation after the recovery pilot is validated. Deploy the current SQLite build only on a single Node instance with persistent storage.

## Delivery sequence

1. Data/workspace/session foundation and seed demo.
2. Main revenue workflow: leads → recovery → inbox → appointment → admission.
3. Provider adapters and scheduled processing.
4. Type checking, domain invariants, browser flows, tenant-isolation checks and mobile/accessibility verification.

## Pilot expansion (proposed eight weeks)

- Weeks 1–2: five design partners; live import data quality and scoring calibration.
- Weeks 3–4: verified WhatsApp onboarding, templates, real inbox and reply/handoff outcomes.
- Weeks 5–6: recovery cohort/holdout measurement, appointment attendance and reconciliation.
- Weeks 7–8: production tenancy, team access, billing, operational monitoring and paid continuation offers.

Scheduling and revenue attribution are operational measurements. Incremental revenue needs a comparison group or another defensible causal method. The product must never describe open lead value as measured lost cash.
