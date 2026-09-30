# INTERNAL DRAFT — AdmitFlow privacy notice

**Do not publish or link from the public site.** This is a fact-gathering draft for the product owner and legal reviewer, prepared 29 September 2026. It is not a completed privacy notice or a statement that every described configuration is live for every institute.

## Identity and roles to decide

- Public product and business display name: **AdmitFlow** (owner-confirmed).
- Public email: **support@admitflow.incfrog.ai** (owner-confirmed; delivery not tested in this work).
- **Owner decision required:** registered service operator, postal address, privacy contact and whether the institute or AdmitFlow acts as controller/processor for each lead and staff data flow. Confirm applicable jurisdictions and any DPA.

## Data the current product can handle

Institute staff accounts and organisation membership come through the hosted WorkOS sign-in path. An institute can enter enquiries manually, review a CSV import or connect a Meta Lead Ads page. Lead records can contain a name, phone, email, course interest, source, notes, admissions stage, counsellor owner, consent state and source, minor/guardian-consent flags, timestamps and activity. Staff can handle WhatsApp messages, counselling bookings, files, lead-linked receipt records and separate refunds. Service connection records can hold protected provider credentials. This inventory needs a field-level review against the live database and enabled integrations before publication.

## Current processing paths

The application uses organisation and role checks and a tenant-aware PostgreSQL data model. Private uploaded objects use R2 with signed access links. WorkOS provides hosted staff identity; configured Meta services can provide lead intake and WhatsApp messaging; an optional Google Calendar connection sends bookings from AdmitFlow to one institute calendar. AI assistance can process conversation context under the configured provider and mode. **Owner decision required:** identify each actual processor/subprocessor, provider account owner, country/region of processing, international-transfer position, and whether each integration is enabled for a specific institute. Do not describe disabled or unverified provider paths as live.

## Purpose, authority and choices

Likely purposes are running the admissions workspace, organising follow-up, delivering eligible messages, recording counselling and outcomes, securing the service and supporting users. The application blocks outbound WhatsApp when opt-in is unknown or opted out, and requires guardian consent for a lead marked as a minor. A customer-service reply does not create future campaign permission. **Owner/legal decision required:** legal bases, each party's notice and consent responsibilities, minors policy, marketing vs service messaging, cookies/analytics disclosures and individual rights language by jurisdiction.

## Retention and deletion

One narrow raw-intake policy is implemented: raw content expires 30 elapsed days from receipt or seven days after import when earlier; cleanup preserves deduplication/binding evidence and safety holds. This does **not** define retention for lead records, messages, notes, files, bookings, receipts, refunds, staff accounts, operational logs, backups or exports. **Owner decision required:** a full category-by-category schedule, legal holds, user/institute deletion and export process, backup retention and restored-data scrubbing. The security review says a full erasure policy and scrubbed backup-restore rehearsal remain open.

## Safeguards and requests

Current source implements staff/tenant checks, provider-secret protection and private-file access. The 27 September 2026 security review records a limited production database-role/row-security check and local synthetic testing; it does not establish a certification, independent audit or complete live-provider proof. **Owner decision required:** publishable security description, request address/workflow and timeframes, incident contact route and notice revision process.

## Before publication

Legal reviewer must replace this internal outline with an approved notice using the verified operator and jurisdictional terms, confirm actual providers/data flows, define retention and rights handling, then test the support/privacy contact route. Do not add a public `/privacy` page from this draft alone.
