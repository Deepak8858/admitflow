# Connected services

These endpoints use the asynchronous workspace store and WorkOS/Neon tenancy model. Tenant transactions protect live records. Subscription state now includes verified provider status, verification time and current-period end; the public workspace exposes a safe capability summary, not the trusted trial ledger or raw intake payloads. Migrations `0006_subscription_trials` and `0007_deferred_intake` add durable trial identity and tenant-isolated intake storage; no new package is required.

## Parent integration hooks

### Settings

```tsx
import { BillingPanel } from "@/components/billing";

<BillingPanel workspace={data} onUpdated={refresh} />
```

`BillingPanel` uses the shared panel, button, badge and form styling. It fetches `/api/billing` independently and handles demo, missing configuration, Razorpay test mode, checkout, provider-confirmed status and immediate cancellation. It displays prices only after fetching the configured plan from Razorpay. Only owners/admins load billing details.

### Team

Keep the existing invitation request:

```ts
POST /api/team
{ type: "invite", name, email, role }
```

The response includes `{ workspace, members, member?, mode, message, emailSent }`. Show `message`: local/demo invitations explicitly say no email was sent and no account access was granted. They remain `invited` and are not active assignees.

Call `GET /api/team` on entry and manual refresh to reconcile WorkOS memberships, invitations, roles and deactivations made outside AdmitFlow. An ordinary `/api/workspace` refresh alone does not fetch the complete WorkOS team.

Additional owner/admin actions:

```ts
{ type: "role", id: member.id, role: "counsellor" }
{ type: "deactivate", id: member.id }
{ type: "reactivate", id: member.id }
{ type: "revoke", id: member.id } // pending invitation
```

Roles are `owner`, `admin`, `counsellor`, `analyst`. Ownership changes require an owner; last-owner removal and self-deactivation are rejected. Hosted team changes now claim a durable per-institute gate before fresh provider reads and authorization checks. Competing operations return **409 before another dispatch**; actual-route/auth/PGlite regressions cover the original concurrent owner-loss and stale-projection defects. See [repair evidence](verification.md#access-management-concurrency--repaired-with-local-regression-evidence). An inactive teammate is reactivated rather than re-invited. Unsupported WorkOS roles remain inactive in the projection and must be configured as one of the application roles.

A 409 can also mean an uncertain WorkOS outcome. Do not automatically resend the POST: after 120 seconds, an unaffected administrator may refresh the team to reconcile positive provider evidence without replay. The target of a pending membership operation cannot authenticate until confirmation. Absent evidence remains blocked, including across restarts; the [operator runbook](deployment.md#team-access-recovery) defines the manual-review boundary. Auth and team projections, invitation receipts and seat reservations share fencing tokens. WorkOS requests do not hold access-operation database transactions; SDK automatic retries are disabled on the application client.

Membership authorization uses `Member.workosId === context.actor.id`, never a display-name match. `Lead.ownerId`, task owners and appointment owners reference the stable **member projection ID**, consistent with the backend's composite foreign keys. Legacy/unclaimed assignees remain inactive audit records; a same-name WorkOS account does not inherit their enquiries.

### Meta Page registration — required in `/api/connections`

The generic credentials branch must call the registration helper instead of saving a Meta Page token directly:

```ts
import { registerMetaLeadPage } from "@/lib/providers/meta-leads";

if (input.service === "meta_leads") {
  assert(input.externalId, "Enter the Meta Page ID.");
  await registerMetaLeadPage(context.workspaceId, {
    pageId: input.externalId,
    accessToken: input.secret.accessToken,
  });
} else {
  // Existing provider-specific verification/save branches.
}
```

The caller must retain its `resolveWorkspace` / `requireAdmin` checks. The helper verifies the token's app, permissions and Page identity, checks form access, saves the Page route, then subscribes the app to `leadgen` while preserving its existing subscribed fields. The webhook URL is `${APP_BASE_URL}/api/webhooks/meta-leads`.

Connection metadata includes `subscriptionStatus` (`pending`, `active`, `error`), `appId`, `tokenExpiresAt` when present, `lastLeadAt`, `lastLeadError`, and `lastLeadErrorAt`. Keep these safe fields in the public metadata allowlist and show errors/status in Integrations. Raw credentials remain encrypted. A failed registration is marked `error` and requires reconnection.

### Disconnect and retained intake

Disconnect removes stored credentials and active routing but retains the connection UUID/provider identity and imported/deferred receipts. Pending WhatsApp subscription routing is preserved: signed callbacks return retryable 503 rather than being acknowledged and lost. WhatsApp recovery requires the original phone-number and Business Account IDs; Meta Lead Ads requires the original Page. Different accounts are rejected, not rebound. Reconnect verifies provider access again; stale verification cannot overwrite a newer disconnect. See [connection recovery](deployment.md#connection-and-intake-recovery) and [WhatsApp subscription recovery](whatsapp-provider-review.md).

OpenAI/ElevenLabs explicitly non-connected states suppress platform-key fallback for that institute, including a disconnect when no tenant credential row existed. This does not revoke the shared key globally. WhatsApp disconnect advances a durable revision fence even during first-time setup and preserves already-dispatched operation evidence. Those disconnects do not revoke provider credentials or cancel dispatched requests. Google disconnect revokes its refresh-token grant before deleting credentials, preserves the token on uncertain failure, and rejects a concurrent reconnect before local removal. Google's revocation applies across clients in the Google project for that account and may affect connections in other institutes; existing calendar events remain. Other absent non-AI/speech service rows do not cancel first-time setup in flight.

**Live Meta/WhatsApp activation gate:** the approved 30-day receipt/seven-day imported-payload policy is implemented. Populated migration/key-backfill, finite backup retention and scrubbed-restore rehearsals remain required. Never delete receipt identities or safety holds to clear a backlog; use the [bounded retention procedure](deployment.md#intake-retention-operations-and-backup-restore).

### Google result and availability

The existing `/api/integrations/google/start` link is implemented. OAuth returns to `/integrations?google=connected|cancelled|error`. Read this finite result parameter to show a success/cancellation/retry notice and refresh the workspace. Callback redirects never include tokens, codes or raw provider errors.

Availability is available to owners, admins and counsellors:

```text
GET /api/integrations/google/busy?from=<ISO timestamp>&to=<ISO timestamp>
-> { connected, busy: [{ start, end }], checkedAt }
```

Backend booking code may call `calendarBusy(workspaceId, from, to)` and `overlapsBusy(startsAt, duration, busy)` before accepting a slot. An unavailable/unconfigured calendar returns `connected: false`; provider failures throw rather than pretending the calendar is free. The maximum lookup window is 31 days. Availability is advisory, not an atomic reservation, and includes AdmitFlow events already present in Google. Rescheduling callers must account for the appointment's existing event when deciding whether a busy interval is a conflict.

When the parent-owned `appointment.status` action enqueues a cancellation sync, set `appointment.syncStatus = "pending"` at the same time. The provider changes this to `synced` only after a successful/previously-completed Google deletion, or `failed` on a provider error.

### Live updates

The existing provider listener is compatible:

```ts
const events = new EventSource("/api/events");
events.addEventListener("change", refresh);
events.addEventListener("revoked", () => { events.close(); location.assign("/login"); });
```

`change` carries only `{ workspaceId, revision }`, with the revision as the SSE ID. The tenant comes exclusively from the authenticated session. Revisions are checked every 5 seconds; membership is revalidated against WorkOS before every changed revision and independently every 30 seconds. Role changes and membership loss revoke the stream. SSE-comment heartbeats run independently every 15 seconds. Streams close after 55 seconds to allow renewed session verification, and all timers/listeners are cleaned up on cancellation/abort. Transient authorization-service failures close for reconnect rather than falsely announcing revocation.

## Onboarding and sign-out

`/onboarding` is independent of `useData` and can render before a workspace exists. It calls the existing organization endpoints:

- `GET /api/organizations` → `{ organizations, current, name, scope, provisioning }`; active memberships are fully paginated. `scope` binds browser intent to the WorkOS client and actor.
- `POST /api/organizations` with `{ type: "create", requestId: "<UUID>", name }` returns `{ provisioning }` (200 when ready, otherwise 202). Retain the same request UUID and immutable name across retries; only one unacknowledged operation is allowed per actor/client.
- `{ type: "continue", id: "<operation UUID>" }` checks positive provider evidence and may perform the next never-dispatched step. It never replays an uncertain organization or membership write.
- `{ type: "open", id }` revalidates ownership and updates the session independently of creation. A 503 with `PROVISIONING_SESSION_INCOMPLETE` means retry Open/sign-in, not create a replacement.
- `{ type: "acknowledge", id }` explicitly acknowledges verified completion before another create intent. `{ organizationId }` or `{ type: "switch", organizationId }` selects an existing active membership.

Provisioning states are `pending`, `continue`, `review_required` and `ready`; responses include operation/request IDs, name, message, acknowledgement and confirmed organization ID when available. The onboarding UI retains actor/client-scoped sessionStorage intent but treats server state as authoritative. Review-required evidence is sticky. See [organization provisioning recovery](deployment.md#organization-provisioning-recovery).

Successful selection uses a full navigation to `/`, resetting the workspace query cache after the organization cookie changes. Loading, errors, no memberships, invitation refresh, and unconfigured/local installation states are explicit.

`GET /logout` calls AuthKit 4.3's `signOut({ returnTo: APP_BASE_URL + "/onboarding" })`. AuthKit deletes its session/PKCE cookies and redirects through WorkOS's end-session URL. Do not catch that Next.js redirect and turn it into JSON. Register `/onboarding` as an allowed WorkOS post-logout return URL. Local sign-out ends the SQLite session and removes its cookie.

## Configuration

### Shared

- `APP_BASE_URL`: the canonical application origin. Google OAuth requires HTTPS except for a loopback development origin.
- Existing `DATABASE_URL`, WorkOS/AuthKit variables and role slugs for hosted operation.
- Existing `KMS_KEY_ID` or 32-byte base64 `INTEGRATION_ENCRYPTION_KEY` for per-institute provider credentials.

### Google Calendar

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_STATE_SECRET`: at least 32 random characters. If omitted, the existing `WORKOS_COOKIE_PASSWORD` or `INTEGRATION_ENCRYPTION_KEY` is used as the signing key, with a Google-specific HMAC domain separator.
- Authorized redirect URI: `${APP_BASE_URL}/api/integrations/google/callback`.
- Enable Calendar API and allow the required scopes in the Google OAuth application.

The flow requests `openid`, `email`, `calendar.events` and `calendar.freebusy`, with offline access and PKCE S256. Signed state expires after ten minutes and is bound to the initiating actor, institute and WorkOS organization. Its HttpOnly SameSite=Lax cookie holds the matching PKCE verifier. Membership/admin rights are checked again before saving the refresh token. The saved connection is `google`, `{ refreshToken }`, Google subject ID, account email label and `{ calendarId: "primary" }`.

Calendar sync is **AdmitFlow → Google only**. The worker invokes `syncAppointment`; no Google push notifications or inbound event change import are implemented. UUID-derived deterministic event IDs prevent duplicate insertions. Insert conflicts are reconciled with PATCH. Cancellation treats already-missing/deleted events as success. Stale in-flight writes leave the appointment pending and queue reconciliation of the latest version. Failed operations mark `syncStatus: "failed"`. Permanently deleted Google tombstones may require a new appointment. Disconnecting credentials does not delete previously-created Google events.

### Meta Lead Ads

- `META_APP_SECRET`: global HMAC signing secret.
- `NEXT_PUBLIC_META_APP_ID` (or server-side `META_APP_ID`).
- `META_LEADS_WEBHOOK_VERIFY_TOKEN`, falling back to `META_WEBHOOK_VERIFY_TOKEN`.
- Existing optional `META_API_VERSION` used by `graph()`.
- Page token with `leads_retrieval`, `pages_manage_metadata`, and the Page/form permissions required by the Meta app.
- Page webhook field: `leadgen`.

The subscription challenge is verified in constant time. POST signatures are checked against the exact bounded UTF-8 body before processing. A `connection_routes` row with `service = 'meta_leads'` maps the verified Page ID to its institute; the saved Page access token fetches the actual form response.

Each leadgen ID has an event receipt and an atomic per-enquiry deduplication marker. Different submissions from the same contact attach a separate internal source note instead of duplicating the enquiry. Existing opt-out/minor/guardian state is preserved. New leads have unknown WhatsApp consent, no WhatsApp reply window and no scheduled AI message. Checkbox names and form submission alone never grant opt-in. Email-only enquiries carry a visibly non-dialable `meta:<page>:<leadgen>` source reference in the existing required phone field until actual contact details are recorded.

Transient import failures retain an unprocessed receipt and safe connection error metadata, and return `503` with `Retry-After`. Successful events remain deduplicated when Meta retries a partially failed batch. Unknown/disconnected Page routes are ignored; reconnect and replay the retained provider event as needed. Hosted webhook routing requires Neon; demo/local previews do not simulate live form delivery. Historical form backfill is not implemented.

### Institute admission payments — locally verified hardening

The institute-specific `/api/webhooks/razorpay/<workspace UUID>` endpoint accepts signed `payment.captured` and `refund.processed` events into the existing server-only `event_receipts` registry. It stores minimal provider references, a connection identity and key-ID fingerprint, not card/customer payloads. The worker reconciles authoritative provider state before committing capture/refund records; a refund can reconstruct its capture when delivered first. Delivery identity derives from the signed body and institute, never the unsigned event-ID header.

PR #13 additionally requires durable proof that AdmitFlow issued the canonical provider payment link before crediting a new payment. The worker verifies the payment-to-link association and full captured INR amount, then claims that link atomically with the financial write. Provider notes cannot authorize attribution. Previously credited receipts retain their refund path; older uncredited links without issuance evidence, partial payments and ambiguous associations require the [issued-link recovery procedure](payment-link-recovery.md). These changes are locally verified and await release.

Integer-paise checks, streamed body limits, exact UTF-8 signatures, retry/backoff, stale-claim fencing and explicit operator replay passed **15 payment regression tests** on 17 September. The whole application suite and fresh browser run also passed; real merchant verification remains pending. See [payment recovery](deployment.md#admission-payment-recovery) for inspection/replay, changed-merchant and rollback boundaries. No new database migration was added. This path does not enforce the institute's subscription lifecycle or issue a charge/refund at the provider.

### AdmitFlow SaaS billing

- `BILLING_RAZORPAY_KEY_ID`
- `BILLING_RAZORPAY_KEY_SECRET`
- `BILLING_RAZORPAY_WEBHOOK_SECRET`
- Optional `BILLING_RAZORPAY_ACCOUNT_ID` to additionally validate the webhook's account ID.
- `BILLING_PLANS_JSON`: a server-owned catalog, not a browser-provided price or provider plan ID.

Configuration shape (replace the placeholder with an existing Razorpay plan):

```json
[
  {
    "id": "institute",
    "name": "Institute",
    "description": "Your configured institute subscription",
    "razorpayPlanId": "plan_REPLACE_WITH_YOUR_PLAN_ID",
    "totalCount": 12
  }
]
```

The catalog supports 1–12 entries, unique public/provider IDs and positive integer cycle counts up to 1,200. Amount, currency, interval and period come from Razorpay's Plan API, not hardcoded prices. Actual provider duration limits still apply. Provision plans in Razorpay separately; this code does not create cloud resources or paid plans.

```text
GET /api/billing
  -> { mode, subscription, plans, providerStatus?, checkoutUrl?, canCancel, message }

POST /api/billing
  { type: "subscribe", planId: "institute", requestId: "<UUID>" }
  -> { subscription, providerStatus, checkoutUrl? }

POST /api/billing
  { type: "cancel" }
  -> { subscription, providerStatus, message }
```

Only hosted WorkOS owners/admins may purchase or cancel. Subscription creation uses the configured plan ID, quantity 1, configured cycle count, a one-day authorization-link expiry and server-written institute/product/operation notes. The checkout URL is restricted to Razorpay hosts. Opening/returning from checkout never marks the workspace paid; the server verifies the provider state.

Subscribe the dedicated `${APP_BASE_URL}/api/webhooks/billing` endpoint to:

```text
subscription.authenticated, subscription.activated, subscription.charged,
subscription.pending, subscription.halted, subscription.cancelled,
subscription.completed, subscription.paused, subscription.resumed,
subscription.updated
```

The global billing secret is separate from institute Razorpay receipt secrets. `payment.captured` and refund events are ignored by this endpoint. Billing never changes institute revenue, admissions or receipt records.

Subscriptions are routed using `connection_routes.service = 'billing'`. A webhook arriving before the create response can establish its route only when the provider's verified notes match a persisted server checkout operation. Historical subscription events cannot replace a newer subscription. The provider snapshot is fetched while holding the tenant organization lock, preventing out-of-order callbacks from regressing state. Event receipts are marked processed only after a successful transaction; failed events return a retryable status. Cancelled subscriptions cannot be revived by an old checkout response.

### Subscription permission and deferred intake

Each hosted WorkOS organization gets one exact 168-hour trial; workspace deletion/recreation, checkout and subscription replacement cannot reset it. The migration grants eligible unlinked legacy trial institutes a transition interval anchored at migration, not next login. Activated/terminal history cannot fall back to unused trial time. Local/demo previews retain their existing behavior.

Verified active permission lasts at most five minutes and never beyond the current billing-period end. Known past-due/terminal states restrict immediately, with no grace period. Authorization runs first; entitlement never elevates a role. Outbound, AI (including speech and embeddings), new enquiries, invitations and reactivations are guarded at mutation and final provider boundaries. Coded failures use `SUBSCRIPTION_RESTRICTED`: HTTP 402 for policy restriction or 503 when verification is required/unavailable. Existing-data reads/exports, drafts/notes, ordinary files/local extraction, manual counselling/calendar work, billing, callbacks and safety controls remain authorized independently.

The worker reconciles subscriptions every 60 seconds using bounded organization-route pages (10 by default, capped at 20), independently of payment recovery and UI visits. It needs the shared billing API keys and plan catalog; webhook secrets remain web-only. Old blocked AI/campaign jobs do not automatically resume when payment recovers. Confirmation of an already-dispatched team/provider operation remains permitted; uncertainty never authorizes a resend.

Signed WhatsApp/Meta callbacks are not blanket-blocked. Existing-record updates, opt-outs, delivery status and Business-app echoes still apply. Validated new-enquiry events are durably deferred while restricted; fetched Meta forms are retained rather than depending on indefinite provider retention. Receipt identity binds tenant/provider route/event and the accepted payload; receipt and aggregate changes commit atomically. Pending normalized-phone matches hold cross-channel automation until reviewed. Email-only Meta forms have no normalized-phone cross-channel key.

- `GET /api/intake`: hosted owner/admin-only summary `{ count, capped, expiredCount, needsConnection, message }`; count is capped at 1,000 (returned with `capped: true` when more exist). No raw payloads are returned; expired content cannot be imported.
- `POST /api/intake`: `{ type: "import", after?: "<64 lowercase hex receipt cursor>" }`. Each call processes at most 25 events with a fresh tenant/actor/connection/entitlement/quota check. The response contains `result`, `summary` and public `workspace`; `result` reports imported/blocked counts and continuation. Quota failure rolls back the batch; changed connections remain retained.
- Recovery requires an explicit click for each batch; it preserves accepted timestamps/opt-out ordering and forces human ownership/stops jobs on imported contacts. Import does not schedule replies or campaigns. **Review from beginning** revisits previously blocked rows; cursors are receipt order, not chronological event order.
- Payloads are validated and bounded to 128 KiB at the database layer. Durable persistence failures remain retryable, not acknowledged as accepted. Raw content expires 30 elapsed days from receipt, or seven days after import when earlier. Readers/importers enforce expiry; bounded worker/operator cleanup redacts raw payloads while preserving immutable deduplication/binding evidence and tenant-keyed contact safety holds. Expired Meta forms are not refetched. Tenant deletion cascades intake, but never the immutable trial ledger. Backup copies require separately verified finite retention and scrubbing before restored writers resume. See [rollout, restore and retention](deployment.md#subscription-rollout-and-recovery).

Clients redirect HTTP 409 to onboarding only for `ORGANIZATION_REQUIRED`; ordinary conflicts remain in place. The restricted-mode banner anchors each capability observation once, expires open tabs even when the same response is replayed, and offers billing to administrators or contact-admin guidance to other roles. Server checks remain authoritative.

### Operational limits and recovery

- Razorpay subscription creation has no documented create-idempotency parameter. A durable per-institute claim and permanent request-ID receipts prevent a second POST after an uncertain result. A retry searches up to 500 provider subscriptions for the original operation marker; it never blindly purchases another subscription. If the provider outcome cannot be found, an operator must inspect the recorded operation and reconcile it before another create.
- WorkOS invitation sends use a durable per-email claim plus the institute-wide access gate. Pending provider invitations are reused without another email; invitation and seat receipts reconcile from positive evidence. Once provider dispatch was invoked, the access gate remains closed even on explicit rejection until reviewed or positively confirmed; a per-email failed receipt alone does not authorize a retry. Pre-dispatch failures can release the access intent safely. No invitation acceptance tokens/URLs are exposed in the team API.
- Cancellation ends billing **immediately**. Selected subscription-lifecycle entitlements, verified invoice reads and configured member/enquiry quotas are implemented. Cycle-end cancellation, plan upgrades/proration, SaaS refunds and comprehensive usage/spend accounting remain unimplemented. A retry fetches current provider state and skips already-completed cancellation.
- Provider configuration and real accounts are required for end-to-end delivery. Local tests use mocked HTTP responses and an in-memory PostgreSQL-compatible database; they do not establish live WorkOS, Google, Meta or Razorpay connectivity.

## Verification

`tests/connected-services.test.ts` covers signed OAuth/PKCE state binding, stable member projections, ownership checks, explicitly non-delivering demo invitations, Meta consent/deduplication, safe billing projections/redirects, SSE revocation/abort cleanup, deterministic Calendar insertion/cancellation/stale-write handling, webhook boundary/retry behavior, and persisted billing lifecycle/retry behavior. Run:

```sh
node --import tsx --test tests/connected-services.test.ts
npm run typecheck
npm test
```
