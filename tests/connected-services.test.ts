import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { createGoogleState, verifyGoogleState } from "../src/app/api/integrations/google/oauth";
import { authorizeMemberChange, projectMembers, type MemberSnapshot } from "../src/app/api/team/members";
import { POST as teamPost } from "../src/app/api/team/route";
import { claimInvitation, finishInvitation } from "../src/app/api/team/invitations";
import { revisionEvent, workspaceEventStream } from "../src/app/api/events/stream";
import { POST as metaWebhook, GET as verifyMetaWebhook } from "../src/app/api/webhooks/meta-leads/route";
import { POST as billingWebhook } from "../src/app/api/webhooks/billing/route";
import { GET as invoiceGet } from "../src/app/api/billing/invoices/route";
import { applyMetaLead, processMetaLeadPayload, registerMetaLeadPage, type MetaLeadForm } from "../src/lib/providers/meta-leads";
import { assertBillingTenant, assertEnquiryEntitlement, billingCheckoutUrl, billingEntitlementPolicy, billingSeatUsage, cancelBillingSubscription, confirmBillingSeat, createBillingCheckout, failBillingSeat, listBillingInvoices, normalizedPlanLimits, parseBillingPlans, prepareBillingEntitlements, processBillingWebhook, projectBillingInvoice, projectBillingSubscription, readBillingEntitlements, reconcileBillingSeats, reserveBillingSeat, type BillingSeatClaim, type BillingSubscription } from "../src/lib/providers/billing";
import { calendarBusy, calendarEventId, calendarSyncKey, overlapsBusy, syncAppointment } from "../src/lib/providers/calendar";
import { createWorkspace } from "../src/lib/seed";
import { normalizePhone, uid, type Member } from "../src/lib/domain";
import { createDemo, loadWorkspace, mutateWorkspace, saveNewWorkspace } from "../src/lib/store";
import { saveConnection } from "../src/lib/connections";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import * as schema from "../src/lib/db/schema";
import { applyAction } from "../src/lib/actions";
import { AppError } from "../src/lib/errors";

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const decode = (value?: Uint8Array) => new TextDecoder().decode(value);
const providerPlan: ReturnType<typeof parseBillingPlans>[number] = { id: "institute", name: "Institute", razorpayPlanId: "plan_ConnectedTest", totalCount: 12 };

test("Google state rejects tampering, cookie swaps, PKCE substitution, expiry and another actor or institute", () => {
  const key = "a-dedicated-random-test-signing-key-at-least-32-bytes";
  const now = Date.now();
  const context = { workspaceId: uid(), workosOrganizationId: "org_original", actor: { id: "user_original", name: "Admin", email: "admin@example.com", role: "owner" as const, backend: "workos" as const } };
  const proof = createGoogleState(context, now, key);
  const verifier = verifyGoogleState(proof.state, proof.cookie, context, now + 1000, key);
  assert.equal(createHash("sha256").update(verifier).digest("base64url"), proof.challenge);
  assert.throws(() => verifyGoogleState(proof.state, undefined, context, now, key));
  assert.throws(() => verifyGoogleState(proof.state, createGoogleState(context, now, key).cookie, context, now, key));
  assert.throws(() => verifyGoogleState(`${proof.state}x`, proof.cookie, context, now, key));
  assert.throws(() => verifyGoogleState(proof.state, proof.cookie, { ...context, workspaceId: uid() }, now, key));
  assert.throws(() => verifyGoogleState(proof.state, proof.cookie, { ...context, workosOrganizationId: "org_other" }, now, key));
  assert.throws(() => verifyGoogleState(proof.state, proof.cookie, { ...context, actor: { ...context.actor, id: "user_other" } }, now, key));
  assert.throws(() => verifyGoogleState(proof.state, proof.cookie, context, now + 600_000, key));
  const cookie = JSON.parse(Buffer.from(proof.cookie, "base64url").toString());
  cookie.verifier = "a".repeat(43);
  assert.throws(() => verifyGoogleState(proof.state, Buffer.from(JSON.stringify(cookie)).toString("base64url"), context, now, key));
});

test("membership projections preserve stable IDs, reconcile invitations and never link identities by display name", () => {
  const original: Member[] = [
    { id: "member_old", workosId: "user_a", name: "Same Name", email: "a@example.com", role: "counsellor", status: "active" },
    { id: "departed", workosId: "user_departed", name: "Departed", email: "departed@example.com", role: "admin", status: "active" },
    { id: "invitation_accepted", name: "Invite display", email: "b@example.com", role: "admin", status: "invited" },
  ];
  const snapshot: MemberSnapshot = {
    memberships: [
      { id: "membership_recreated", userId: "user_a", organizationId: "org_a", status: "active", role: { slug: "analyst" } },
      { id: "membership_b", userId: "user_b", organizationId: "org_a", status: "active", role: { slug: "counsellor" } },
      { id: "foreign_member", userId: "user_foreign", organizationId: "org_other", status: "active", role: { slug: "owner" } },
    ],
    users: [
      { id: "user_a", email: "a@example.com", firstName: "Changed", lastName: "Name" },
      { id: "user_b", email: "b@example.com", firstName: "Same", lastName: "Name" },
    ],
    invitations: [{ id: "invitation_accepted", email: "b@example.com", organizationId: "org_a", acceptedUserId: "user_b", state: "accepted", roleSlug: "counsellor", expiresAt: new Date(Date.now() + 86400_000).toISOString() }],
  };
  const next = projectMembers(original, snapshot, "org_a");
  assert.equal(next.find(member => member.workosId === "user_a")?.id, "member_old");
  assert.equal(next.find(member => member.workosId === "user_a")?.name, "Changed Name");
  assert.equal(next.find(member => member.workosId === "user_a")?.role, "analyst");
  assert.equal(next.find(member => member.workosId === "user_b")?.id, "membership_b");
  assert.equal(next.find(member => member.workosId === "user_departed")?.status, "inactive");
  assert.ok(!next.some(member => member.id === "invitation_accepted" || member.id === "foreign_member"));
  assert.deepEqual(projectMembers(next, snapshot, "org_a"), next);
});

test("team administration checks WorkOS identity, ownership roles and the last active owner", () => {
  const owner: Member = { id: "membership_a", workosId: "user_a", name: "Alex", email: "a@example.com", role: "owner", status: "active" };
  const other: Member = { id: "membership_b", workosId: "user_b", name: "Alex", email: "b@example.com", role: "counsellor", status: "active" };
  assert.throws(() => authorizeMemberChange({ id: "user_b", role: "admin" }, owner, "role", [owner, other], "counsellor"), /Only an owner/);
  assert.throws(() => authorizeMemberChange({ id: "user_a", role: "owner" }, owner, "deactivate", [owner, other]), /another administrator/);
  assert.throws(() => authorizeMemberChange({ id: "user_a", role: "owner" }, owner, "role", [owner, other], "analyst"), /at least one/);
  assert.doesNotThrow(() => authorizeMemberChange({ id: "user_a", role: "owner" }, other, "deactivate", [owner, other]));
});

test("Meta lead forms deduplicate repeated deliveries and submissions without inventing messaging consent", () => {
  const workspace = createWorkspace(false);
  workspace.courses = ["NEET"];
  workspace.members = [{ id: "member_counsellor", workosId: "user_counsellor", name: "Counsellor", email: "team@example.com", role: "counsellor", status: "active" }];
  const event = { pageId: "100", leadgenId: "200", formId: "300", adId: "400" };
  const form: MetaLeadForm = { id: "200", form_id: "300", field_data: [{ name: "full_name", values: ["Student One"] }, { name: "phone_number", values: ["9876543210"] }, { name: "email", values: ["STUDENT@example.com"] }, { name: "course", values: ["neet"] }, { name: "whatsapp_opt_in", values: ["yes"] }] };
  assert.equal(applyMetaLead(workspace, event, form).created, true);
  const lead = workspace.leads[0];
  assert.equal(lead.ownerId, "member_counsellor");
  assert.equal(lead.phone, "+919876543210");
  assert.equal(lead.course, "NEET");
  assert.equal(lead.consent, "unknown");
  assert.equal(lead.consentAt, null);
  assert.equal(lead.lastInboundAt, null);
  assert.equal(lead.humanOwned, true);
  assert.equal(workspace.messages[0].direction, "internal");
  assert.equal(workspace.jobs.length, 0);
  assert.equal(applyMetaLead(workspace, event, form).duplicate, true);
  lead.consent = "opted_out"; lead.consentSource = "Student requested STOP";
  assert.equal(applyMetaLead(workspace, { ...event, leadgenId: "201" }, { ...form, id: "201" }).created, false);
  assert.equal(lead.consent, "opted_out");
  assert.equal(lead.consentSource, "Student requested STOP");
  assert.equal(workspace.leads.length, 1);
  assert.equal(workspace.messages.length, 2);
  applyMetaLead(workspace, event, form);
  assert.equal(workspace.messages.length, 2, "a newer submission must not erase the original deduplication marker");
  assert.throws(() => applyMetaLead(workspace, { ...event, leadgenId: "999" }, form), /different form/);
});

test("email-only Meta enquiries use an explicitly non-dialable source reference", () => {
  const workspace = createWorkspace(false);
  const form: MetaLeadForm = { id: "501", field_data: [{ name: "email", values: ["email-only@example.com"] }] };
  applyMetaLead(workspace, { pageId: "100", leadgenId: "501" }, form);
  assert.equal(workspace.leads[0].phone, "meta:100:501");
  assert.equal(normalizePhone(workspace.leads[0].phone), null);
  assert.equal(workspace.leads[0].ownerId, null);
  applyMetaLead(workspace, { pageId: "100", leadgenId: "502" }, { ...form, id: "502" });
  assert.equal(workspace.leads.length, 1);
});

test("billing plans, tenant binding, lifecycle projection and checkout redirects reject unsafe input", () => {
  assert.equal(parseBillingPlans(JSON.stringify([providerPlan]))[0].razorpayPlanId, providerPlan.razorpayPlanId);
  assert.throws(() => parseBillingPlans(JSON.stringify([providerPlan, providerPlan])), /unique/);
  assert.throws(() => parseBillingPlans(JSON.stringify([{ ...providerPlan, amount: 1 }])));
  assert.throws(() => parseBillingPlans("not json"));
  assert.equal(billingCheckoutUrl("https://rzp.io/i/valid"), "https://rzp.io/i/valid");
  for (const url of ["javascript:alert(1)", "http://rzp.io/i/a", "https://rzp.io.attacker.example/a", "https://user:secret@rzp.io/a", "https://rzp.io:8443/i/a"]) assert.equal(billingCheckoutUrl(url), undefined);
  const entity: BillingSubscription = { id: "sub_Original", plan_id: providerPlan.razorpayPlanId, status: "active", notes: { admitflow_product: "admitflow_saas", admitflow_workspace_id: "workspace_a" }, current_end: 2000000000 };
  assertBillingTenant(entity, "workspace_a");
  assert.throws(() => assertBillingTenant(entity, "workspace_b"));
  const active = projectBillingSubscription(undefined, entity, "Institute");
  assert.equal(active.status, "active");
  assert.equal(active.renewsAt, new Date(2000000000 * 1000).toISOString());
  assert.deepEqual(projectBillingSubscription(active, { ...entity, status: "created" }, "Institute"), active);
  const due = projectBillingSubscription(active, { ...entity, status: "halted" }, "Institute");
  assert.equal(due.status, "past_due");
  const ended = projectBillingSubscription(due, { ...entity, status: "cancelled" }, "Institute");
  assert.equal(ended.status, "cancelled");
  assert.equal(ended.renewsAt, undefined);
  assert.deepEqual(projectBillingSubscription(ended, entity, "Institute"), ended);
  assert.throws(() => projectBillingSubscription(active, { ...entity, id: "sub_Other" }, "Institute"));
});

test("SSE validates membership before changes, heartbeats, and closes on revocation", { timeout: 10000 }, async t => {
  const abort = new AbortController(); t.after(() => abort.abort());
  let revision = 4, allowed = true, checks = 0;
  const reader = workspaceEventStream({ workspaceId: "institute_a", signal: abort.signal, initialRevision: revision, readRevision: async () => revision, validateMembership: async () => { checks++; return allowed; }, pollMs: 10, heartbeatMs: 20, lifetimeMs: 8000 }).getReader();
  assert.match(decode((await reader.read()).value), /event: change\ndata: \{"workspaceId":"institute_a","revision":4\}/);
  revision = 5;
  assert.match(decode((await reader.read()).value), /id: 5\nevent: change/);
  assert.equal(checks, 1);
  assert.match(decode((await reader.read()).value), /: heartbeat/);
  assert.ok(checks >= 2);
  allowed = false; revision = 6;
  assert.match(decode((await reader.read()).value), /event: revoked/);
  assert.equal((await reader.read()).done, true);
  assert.throws(() => revisionEvent("institute_a", NaN));
});

test("SSE abort/cancel removes polling and an authorization outage closes without a false revocation", { timeout: 3000 }, async t => {
  const abort = new AbortController(); t.after(() => abort.abort());
  let polls = 0;
  const reader = workspaceEventStream({ workspaceId: "a", signal: abort.signal, initialRevision: 0, readRevision: async () => { polls++; return 0; }, validateMembership: async () => true, pollMs: 10 }).getReader();
  await reader.read(); abort.abort();
  assert.equal((await reader.read()).done, true);
  await sleep(25); assert.equal(polls, 0);
  const another = new AbortController(); t.after(() => another.abort());
  const failed = workspaceEventStream({ workspaceId: "a", signal: another.signal, initialRevision: 0, readRevision: async () => 1, validateMembership: async () => { throw new Error("WorkOS unavailable"); }, pollMs: 5 }).getReader();
  await failed.read();
  assert.equal((await failed.read()).done, true);
  const cancelled = workspaceEventStream({ workspaceId: "a", signal: another.signal, initialRevision: 0, readRevision: async () => { polls++; return 1; }, validateMembership: async () => true, pollMs: 5 }).getReader();
  await cancelled.cancel(); await sleep(20); assert.equal(polls, 0);
});

test("calendar IDs, identity-sensitive snapshots and half-open busy intervals are deterministic", () => {
  const appointment = createWorkspace().appointments[0];
  assert.equal(calendarEventId(appointment.id), appointment.id.replaceAll("-", ""));
  assert.match(calendarEventId("legacy event with spaces"), /^[0-9a-v]{5,1024}$/);
  assert.equal(calendarEventId("legacy event with spaces"), calendarEventId("legacy event with spaces"));
  assert.notEqual(calendarSyncKey({ ...appointment, ownerId: "first" }), calendarSyncKey({ ...appointment, ownerId: "second" }));
  const busy = [{ start: "2026-10-12T10:00:00Z", end: "2026-10-12T10:30:00Z" }];
  assert.equal(overlapsBusy("2026-10-12T09:30:00Z", 30, busy), false);
  assert.equal(overlapsBusy("2026-10-12T10:30:00Z", 30, busy), false);
  assert.equal(overlapsBusy("2026-10-12T10:15:00Z", 30, busy), true);
  assert.throws(() => overlapsBusy("invalid", 30, busy));
});

test("local team invitations are labelled previews, deduplicate, and never dispatch provider email", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", APP_BASE_URL: undefined });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("A demo must not contact a provider."); });
  const demo = createDemo();
  const request = () => new NextRequest("http://127.0.0.1:3000/api/team", { method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", Cookie: `admitflow_session=${demo.token}` }, body: JSON.stringify({ type: "invite", name: "Demo teammate", email: "demo-teammate@example.com", role: "counsellor" }) });
  for (let i = 0; i < 2; i++) {
    const response = await teamPost(request());
    const result = await response.json();
    assert.equal(response.status, 200, result.error);
    assert.equal(result.emailSent, false);
    assert.match(result.message, /No email was sent/);
    assert.equal(result.member.status, "invited");
  }
  const current = await loadWorkspace(demo.workspace.id);
  assert.equal(current.members?.filter(member => member.email === "demo-teammate@example.com").length, 1);
  assert.ok(!current.team.includes("Demo teammate"));
});

test("calendar synchronization retries deterministic IDs, cancels absent events and detects a stale in-flight write", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"), GOOGLE_CLIENT_ID: "google-test-id", GOOGLE_CLIENT_SECRET: "google-test-secret" });
  const workspace = createWorkspace(); workspace.demo = false; saveNewWorkspace(workspace);
  const appointment = workspace.appointments[0];
  await saveConnection(workspace.id, "google", { refreshToken: "long-test-refresh-token" }, "google-account", "Google test", { calendarId: "primary" });
  let inserts = 0, patches = 0, cancellations = 0, stale = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "token" });
    if (url.endsWith("/freeBusy")) return Response.json({ calendars: { primary: { busy: [{ start: "2026-10-12T10:00:00Z", end: "2026-10-12T10:30:00Z" }] } } });
    if (init?.method === "PATCH") {
      patches++;
      if (stale) { stale = false; await mutateWorkspace(workspace.id, current => { current.appointments[0].startsAt = new Date(Date.parse(current.appointments[0].startsAt) + 3600_000).toISOString(); current.appointments[0].status = "scheduled"; }); }
      return patches === 1 ? new Response(null, { status: 404 }) : Response.json({ id: calendarEventId(appointment.id) });
    }
    if (init?.method === "POST") { inserts++; assert.equal(JSON.parse(String(init.body)).id, calendarEventId(appointment.id)); return new Response(null, { status: 409 }); }
    if (init?.method === "DELETE") { cancellations++; return new Response(null, { status: 404 }); }
    throw new Error(`Unexpected calendar request: ${url}`);
  });
  await syncAppointment(workspace.id, appointment.id);
  await syncAppointment(workspace.id, appointment.id);
  assert.equal(inserts, 1, "an insert conflict should be reconciled with PATCH, not another event ID");
  assert.equal((await loadWorkspace(workspace.id)).appointments[0].syncStatus, "synced");
  assert.equal((await calendarBusy(workspace.id, "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z")).busy.length, 1);
  stale = true;
  await syncAppointment(workspace.id, appointment.id);
  const changed = await loadWorkspace(workspace.id);
  assert.equal(changed.appointments[0].syncStatus, "pending");
  assert.ok(changed.jobs.some(job => job.kind === "calendar.sync" && job.status === "pending" && job.payload?.appointmentId === appointment.id));
  await mutateWorkspace(workspace.id, current => { current.appointments[0].status = "cancelled"; });
  await syncAppointment(workspace.id, appointment.id);
  assert.equal(cancellations, 1);
  assert.equal((await loadWorkspace(workspace.id)).appointments[0].syncStatus, "synced");
});

test("webhook boundaries reject forged/oversized payloads and request retries when routing is unavailable", async t => {
  environment(t, { DATABASE_URL: undefined, META_APP_SECRET: "meta-secret", META_LEADS_WEBHOOK_VERIFY_TOKEN: "verify-secret", BILLING_RAZORPAY_WEBHOOK_SECRET: "billing-secret" });
  const meta = JSON.stringify({ object: "page", entry: [{ id: "100", changes: [{ field: "leadgen", value: { leadgen_id: "200" } }] }] });
  const metaRequest = (signature: string, length?: string) => new NextRequest("http://127.0.0.1:3000/api/webhooks/meta-leads", { method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": signature, ...(length ? { "content-length": length } : {}) }, body: meta });
  assert.equal((await metaWebhook(metaRequest("sha256=forged"))).status, 403);
  assert.equal((await metaWebhook(metaRequest("sha256=forged", "1000001"))).status, 413);
  const validMeta = `sha256=${createHmac("sha256", "meta-secret").update(meta).digest("hex")}`;
  const retry = await metaWebhook(metaRequest(validMeta));
  assert.equal(retry.status, 503); assert.equal(retry.headers.get("Retry-After"), "30");
  const verified = await verifyMetaWebhook(new NextRequest("http://127.0.0.1:3000/api/webhooks/meta-leads?hub.mode=subscribe&hub.verify_token=verify-secret&hub.challenge=123"));
  assert.equal(await verified.text(), "123");
  const billing = JSON.stringify({ event: "subscription.activated", payload: { subscription: { entity: { id: "sub_Test" } } } });
  const signed = createHmac("sha256", "billing-secret").update(billing).digest("hex");
  const response = await billingWebhook(new NextRequest("http://127.0.0.1:3000/api/webhooks/billing", { method: "POST", headers: { "Content-Type": "application/json", "x-razorpay-signature": signed }, body: billing }));
  assert.equal(response.status, 503);
});

test("connected-service persistence isolates tenants, deduplicates side effects and retries failed provider events", { timeout: 60000 }, async t => {
  environment(t, { DATABASE_URL: "postgresql://test.invalid/admitflow", BILLING_RAZORPAY_KEY_ID: "rzp_test_connected123", BILLING_RAZORPAY_KEY_SECRET: "platform-test-secret", BILLING_RAZORPAY_WEBHOOK_SECRET: "platform-webhook-secret", BILLING_PLANS_JSON: JSON.stringify([providerPlan]), BILLING_RAZORPAY_ACCOUNT_ID: undefined, META_APP_SECRET: "meta-app-secret", META_APP_ID: "10101", KMS_KEY_ID: undefined, INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
  const pg = new PGlite(); t.after(() => pg.close());
  for (const name of (await readdir(path.join(process.cwd(), "drizzle"))).filter(name => name.endsWith(".sql")).sort()) await pg.exec(await readFile(path.join(process.cwd(), "drizzle", name), "utf8"));
  const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
  const workspace = createWorkspace(false), other = createWorkspace(false);
  await createPostgresWorkspace(workspace, "org_connected_a"); await createPostgresWorkspace(other, "org_connected_b");
  const subscriptions = new Map<string, BillingSubscription>();
  let creates = 0, cancels = 0, failRead = false, loseCreateResponse = false, failMeta = false;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "graph.facebook.com") {
      const endpoint = url.pathname.split("/").slice(2).join("/");
      if (endpoint === "debug_token") return Response.json({ data: { is_valid: true, app_id: "10101", scopes: ["leads_retrieval", "pages_manage_metadata"] } });
      if (endpoint === "me") return Response.json({ id: "100", name: "Connected Test Page" });
      if (endpoint === "100/leadgen_forms") return Response.json({ data: [{ id: "300" }] });
      if (endpoint === "100/subscribed_apps") {
        if (init?.method === "POST") { assert.deepEqual(JSON.parse(String(init.body)).subscribed_fields, ["feed", "leadgen"]); return Response.json({ success: true }); }
        return Response.json({ data: [{ id: "10101", subscribed_fields: ["feed"] }] });
      }
      if (endpoint === "200" || endpoint === "201") {
        if (failMeta) return Response.json({ error: { code: 1 } }, { status: 503 });
        return Response.json({ id: endpoint, form_id: "300", field_data: [{ name: "full_name", values: ["Meta Student"] }, { name: "phone_number", values: ["9876501234"] }] });
      }
      throw new Error(`Unexpected Meta request: ${url}`);
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from("rzp_test_connected123:platform-test-secret").toString("base64")}`);
    if (url.pathname.startsWith("/v1/plans/")) return Response.json({ id: providerPlan.razorpayPlanId, period: "monthly", interval: 1, item: { amount: 150000, currency: "INR" } });
    if (url.pathname === "/v1/subscriptions" && init?.method === "POST") {
      creates++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.plan_id, providerPlan.razorpayPlanId); assert.equal(body.total_count, providerPlan.totalCount);
      const entity: BillingSubscription = { id: `sub_Test${creates}`, plan_id: body.plan_id, status: "created", notes: body.notes, short_url: `https://rzp.io/i/Test${creates}`, current_end: null };
      subscriptions.set(entity.id, entity);
      if (loseCreateResponse) { loseCreateResponse = false; throw new TypeError("The provider response was lost after creation."); }
      return Response.json(entity);
    }
    if (url.pathname === "/v1/subscriptions") return Response.json({ items: [...subscriptions.values()] });
    const id = url.pathname.split("/")[3], entity = subscriptions.get(id);
    assert.ok(entity, `Unknown mock subscription ${id}`);
    if (url.pathname.endsWith("/cancel")) { cancels++; assert.equal(JSON.parse(String(init?.body)).cancel_at_cycle_end, false); entity.status = "cancelled"; return Response.json(entity); }
    if (failRead) return new Response(null, { status: 503 });
    return Response.json(entity);
  });
  const requestId = uid();
  const created = await createBillingCheckout(workspace.id, providerPlan.id, requestId);
  assert.equal(created.subscription.status, "trial");
  assert.equal(created.subscription.providerId, "sub_Test1");
  const initial = await loadPostgresWorkspace(workspace.id);
  await createBillingCheckout(workspace.id, providerPlan.id, requestId);
  assert.equal(creates, 1);
  const refreshed = await loadPostgresWorkspace(workspace.id);
  assert.ok(Date.parse(refreshed.subscription!.verifiedAt!) >= Date.parse(initial.subscription!.verifiedAt!));
  const { verifiedAt: _initialVerification, ...initialSubscription } = initial.subscription!;
  const { verifiedAt: _refreshedVerification, ...refreshedSubscription } = refreshed.subscription!;
  assert.deepEqual(refreshedSubscription, initialSubscription, "a refresh may advance verification evidence, not provider lifecycle or entitlements");
  const first = subscriptions.get("sub_Test1")!;
  const event = (id: string, name = "subscription.activated") => ({ event: name, payload: { subscription: { entity: { id } } } });
  first.status = "active"; first.charge_at = 2000000000; first.current_end = Math.floor(Date.now() / 1000) + 86400;
  await processBillingWebhook(event(first.id), "activated");
  assert.equal((await loadPostgresWorkspace(workspace.id)).subscription?.status, "active");
  assert.deepEqual(await processBillingWebhook(event(first.id), "activated"), { duplicate: true });
  failRead = true;
  await assert.rejects(() => processBillingWebhook(event(first.id, "subscription.pending"), "pending"));
  const [failedReceipt] = await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, "billing:event:pending"));
  assert.equal(failedReceipt.processedAt, null); assert.ok(failedReceipt.error);
  failRead = false; first.status = "pending";
  await processBillingWebhook(event(first.id, "subscription.pending"), "pending");
  assert.equal((await loadPostgresWorkspace(workspace.id)).subscription?.status, "past_due");
  first.status = "active";
  await cancelBillingSubscription(workspace.id); await cancelBillingSubscription(workspace.id);
  assert.equal(cancels, 1, "retrying cancellation must not repeat the provider side effect");
  await processBillingWebhook(event(first.id), "late-activation");
  assert.equal((await loadPostgresWorkspace(workspace.id)).subscription?.status, "cancelled");
  await assert.rejects(() => createBillingCheckout(workspace.id, providerPlan.id, requestId), /already completed/);
  const second = await createBillingCheckout(workspace.id, providerPlan.id, uid());
  assert.equal(creates, 2);
  assert.equal((await processBillingWebhook(event(first.id, "subscription.cancelled"), "old-subscription")).ignored, true);
  assert.equal((await loadPostgresWorkspace(workspace.id)).subscription?.providerId, second.subscription.providerId);
  assert.equal((await loadPostgresWorkspace(workspace.id)).revenue.length, 0);
  assert.equal((await loadPostgresWorkspace(other.id)).subscription?.providerId, undefined);

  loseCreateResponse = true;
  const uncertainId = uid();
  await assert.rejects(() => createBillingCheckout(other.id, providerPlan.id, uncertainId), /response was lost/);
  const [operation] = await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, `billing:checkout:${other.id}`));
  assert.equal(operation.payload.phase, "uncertain");
  await tenantTransaction(other.id, tx => tx.update(schema.eventReceipts).set({ payload: { ...operation.payload, startedAt: Date.now() - 60_000 } }).where(and(eq(schema.eventReceipts.id, operation.id), eq(schema.eventReceipts.organizationId, other.id))));
  const recovered = await createBillingCheckout(other.id, providerPlan.id, uncertainId);
  assert.equal(recovered.subscription.providerId, "sub_Test3");
  assert.equal(creates, 3, "an uncertain create is recovered by its operation marker, never another POST");

  const replacement = subscriptions.get(second.subscription.providerId!)!;
  replacement.status = "active"; replacement.current_end = Math.floor(Date.now() / 1000) + 86400;
  await processBillingWebhook(event(replacement.id), "replacement-activated");
  await claimInvitation(workspace.id, "invitee@example.com", []);
  await assert.rejects(() => claimInvitation(workspace.id, "invitee@example.com", []), /awaiting WorkOS confirmation/);
  await claimInvitation(other.id, "invitee@example.com", []);
  await finishInvitation(workspace.id, "invitee@example.com", "invitation_test");
  await assert.rejects(() => claimInvitation(workspace.id, "invitee@example.com", []), /already has an invitation record/);

  await mutateWorkspace(workspace.id, current => { current.members = [{ id: "member_meta", workosId: "user_meta", name: "Meta Counsellor", email: "meta-team@example.com", role: "counsellor", status: "active" }]; current.team = ["Meta Counsellor"]; });
  await registerMetaLeadPage(workspace.id, { pageId: "100", accessToken: "meta-page-test-token" });
  const metaEvent = (leadgenId: string) => ({ object: "page", entry: [{ id: "100", changes: [{ field: "leadgen", value: { page_id: "100", leadgen_id: leadgenId, form_id: "300" } }] }] });
  await processMetaLeadPayload(metaEvent("200"));
  await processMetaLeadPayload(metaEvent("200"));
  let imported = await loadPostgresWorkspace(workspace.id);
  assert.equal(imported.leads.length, 1); assert.equal(imported.messages.length, 1);
  assert.equal(imported.leads[0].ownerId, "member_meta"); assert.equal(imported.leads[0].consent, "unknown");
  assert.equal((await loadPostgresWorkspace(other.id)).leads.length, 0);
  failMeta = true;
  await assert.rejects(() => processMetaLeadPayload(metaEvent("201")), /Retry delivery/);
  const [metaReceipt] = await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, "meta_leads:100:201"));
  assert.equal(metaReceipt.processedAt, null); assert.ok(metaReceipt.error);
  assert.ok((await loadPostgresWorkspace(workspace.id)).connections?.find(connection => connection.service === "meta_leads")?.metadata.lastLeadError);
  failMeta = false;
  await processMetaLeadPayload(metaEvent("201"));
  imported = await loadPostgresWorkspace(workspace.id);
  assert.equal(imported.leads.length, 1); assert.equal(imported.messages.length, 2);
  assert.equal(imported.connections?.find(connection => connection.service === "meta_leads")?.metadata.lastLeadError, undefined);
  assert.equal(imported.revenue.length, 0);
});

test("optional catalog limits retain legacy compatibility and bind entitlements by provider ID rather than a plan label", () => {
  const limited = { ...providerPlan, limits: { members: 3, leads: 5 } };
  assert.deepEqual(parseBillingPlans(JSON.stringify([providerPlan])), [providerPlan]);
  assert.deepEqual(normalizedPlanLimits(providerPlan), { members: null, leads: null });
  assert.deepEqual(normalizedPlanLimits(parseBillingPlans(JSON.stringify([{ ...providerPlan, limits: { members: null, leads: 10 } }]))[0]), { members: null, leads: 10 });
  for (const members of [0, -1, 2.5, "3", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => parseBillingPlans(JSON.stringify([{ ...providerPlan, limits: { members } }])));
  assert.throws(() => parseBillingPlans(JSON.stringify([{ ...providerPlan, limits: { seats: 10 } }])));
  const workspace = createWorkspace(false);
  const entity: BillingSubscription = { id: "sub_Limits", plan_id: providerPlan.razorpayPlanId, status: "created", notes: { admitflow_product: "admitflow_saas", admitflow_workspace_id: workspace.id } };
  workspace.subscription = projectBillingSubscription(undefined, entity, "Any display label", limited);
  assert.equal(workspace.subscription.status, "trial", "recording entitlements must not activate checkout");
  assert.equal(workspace.subscription.planId, providerPlan.id);
  assert.equal(workspace.subscription.providerPlanId, providerPlan.razorpayPlanId);
  assert.deepEqual(workspace.subscription.entitlements?.limits, limited.limits);
  assert.deepEqual(billingEntitlementPolicy(workspace, JSON.stringify([limited]), true).limits, limited.limits);
  workspace.subscription.plan = "A completely different label";
  assert.equal(billingEntitlementPolicy(workspace, JSON.stringify([limited]), true).state, "catalog");
  assert.equal(billingEntitlementPolicy(workspace, undefined, true).state, "snapshot");
  assert.equal(billingEntitlementPolicy(workspace, "invalid JSON", true).state, "invalid");
  const foreignPlan = { ...workspace, subscription: { status: "active" as const, plan: providerPlan.name, providerId: "sub_Other", providerPlanId: "plan_Unconfigured", planId: "other" } };
  assert.deepEqual(billingEntitlementPolicy(foreignPlan, JSON.stringify([limited]), true).limits, { members: null, leads: null });
  assert.equal(billingEntitlementPolicy({ ...workspace, subscription: { ...workspace.subscription, providerId: "sub_Foreign" } }, undefined, true).state, "invalid", "a snapshot from another subscription cannot grant capacity");
  assert.equal(billingEntitlementPolicy(workspace, JSON.stringify([limited]), false).state, "local");
  assert.deepEqual(billingEntitlementPolicy({ ...workspace, demo: true }, "invalid JSON", true).limits, { members: null, leads: null });
  workspace.subscription = projectBillingSubscription(workspace.subscription, { ...entity, status: "cancelled" }, providerPlan.name, limited);
  assert.equal(workspace.subscription.status, "cancelled");
  assert.deepEqual(billingEntitlementPolicy(workspace, JSON.stringify([limited]), true).limits, limited.limits, "cancellation does not erase the verified capacity policy");
});

const invoiceFixture = (subscriptionId: string, id = "inv_Verified") => ({ id, entity: "invoice", subscription_id: subscriptionId, customer_id: "cust_Billing", invoice_number: "AF-1001", status: "paid", amount: 125050, amount_paid: 125050, amount_due: 0, currency: "INR", created_at: 1700000000, issued_at: 1700000001, paid_at: 1700000002, short_url: "https://rzp.io/i/Verified", customer_details: { email: "private@example.com", billing_address: "private" }, notes: { private: "not for the browser" } });

test("invoice projections verify subscription/customer binding and expose no malicious URLs or private provider fields", () => {
  const subscription: BillingSubscription = { id: "sub_Verified", plan_id: providerPlan.razorpayPlanId, status: "active", customer_id: "cust_Billing", notes: {} };
  const raw = invoiceFixture(subscription.id), invoice = projectBillingInvoice(raw, subscription);
  assert.equal(invoice.total, 125050); assert.equal(invoice.paid, 125050); assert.equal(invoice.due, 0);
  assert.equal(invoice.issuedAt, new Date(1700000001 * 1000).toISOString());
  assert.equal(invoice.status, "paid"); assert.equal(invoice.hostedUrl, raw.short_url);
  assert.equal("customer_details" in invoice, false); assert.equal("notes" in invoice, false);
  assert.throws(() => projectBillingInvoice({ ...raw, subscription_id: "sub_Foreign" }, subscription), /does not match/);
  assert.throws(() => projectBillingInvoice({ ...raw, customer_id: "cust_Foreign" }, subscription), /does not match/);
  for (const short_url of ["javascript:alert(1)", "//rzp.io/i/unsafe", "https://rzp.io.evil.example/i/a", "https://checkout.razorpay.com.evil.example/invoice", "https://user:password@rzp.io/i/a", "https://rzp.io:8443/i/a", "https://evil.example/invoice.pdf"]) assert.equal(projectBillingInvoice({ ...raw, short_url }, subscription).hostedUrl, null);
  assert.equal(projectBillingInvoice({ ...raw, short_url: null }, subscription).hostedUrl, null);
  assert.throws(() => projectBillingInvoice({ ...raw, amount: -1 }, subscription));
  assert.throws(() => projectBillingInvoice({ ...raw, created_at: 1e20 }, subscription));
});

test("invoice API demo/local/unauthenticated states are explicit and never accept a browser subscription ID", async t => {
  environment(t, { DATABASE_URL: undefined, ADMITFLOW_DB: ":memory:", BILLING_RAZORPAY_KEY_ID: "rzp_test_global", BILLING_RAZORPAY_KEY_SECRET: "global-secret" });
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Local invoice previews must not call a provider."); });
  const demo = createDemo(), cookie = { cookie: `admitflow_session=${demo.token}` };
  const response = await invoiceGet(new NextRequest("http://127.0.0.1:3000/api/billing/invoices", { headers: cookie }));
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.state, "demo"); assert.deepEqual(body.invoices, []);
  assert.equal((await invoiceGet(new NextRequest("http://127.0.0.1:3000/api/billing/invoices?subscriptionId=sub_Foreign", { headers: cookie }))).status, 400);
  assert.equal((await invoiceGet(new NextRequest("http://127.0.0.1:3000/api/billing/invoices?page=0", { headers: cookie }))).status, 400);
  assert.equal((await invoiceGet(new NextRequest("http://127.0.0.1:3000/api/billing/invoices"))).status, 401);
  assert.equal((await listBillingInvoices(createWorkspace(false))).state, "setup");
  assert.equal(network.mock.callCount(), 0);
});

test("invoice reads and configured quotas use tenant transactions under concurrent app writes", { timeout: 90000 }, async t => {
  const limitedPlan = { ...providerPlan, limits: { members: 3, leads: 3 } };
  environment(t, { DATABASE_URL: "postgresql://test.invalid/billing-limits", BILLING_RAZORPAY_KEY_ID: "rzp_test_quota123", BILLING_RAZORPAY_KEY_SECRET: "billing-invoice-key", BILLING_RAZORPAY_WEBHOOK_SECRET: "webhook-key", BILLING_PLANS_JSON: JSON.stringify([limitedPlan]) });
  const pg = new PGlite(); t.after(() => pg.close());
  for (const name of (await readdir(path.join(process.cwd(), "drizzle"))).filter(name => name.endsWith(".sql")).sort()) await pg.exec(await readFile(path.join(process.cwd(), "drizzle", name), "utf8"));
  const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
  const first = createWorkspace(false), second = createWorkspace(false), imports = createWorkspace(false);
  const entities = new Map<string, BillingSubscription>();
  for (const [index, workspace] of [first, second, imports].entries()) {
    workspace.members = [{ id: `member_quota_${index}`, workosId: `user_quota_${index}`, name: "Same Name", email: `owner-${index}@example.com`, status: "active", role: "owner" }];
    workspace.team = ["Same Name"];
    const entity: BillingSubscription = { id: `sub_Quota${index}`, plan_id: limitedPlan.razorpayPlanId, status: "created", customer_id: "cust_Billing", notes: { admitflow_product: "admitflow_saas", admitflow_workspace_id: workspace.id } };
    // Provision the institute before checkout, as the production signup flow does.
    await createPostgresWorkspace(workspace, `org_quota_${index}`);
    workspace.subscription = projectBillingSubscription(undefined, entity, limitedPlan.name, limitedPlan);
    entities.set(entity.id, entity);
    await mutateWorkspace(workspace.id, current => { current.subscription = workspace.subscription; });
  }
  let invoiceRows: Record<string, unknown>[] = [invoiceFixture(first.subscription!.providerId!)];
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); paths.push(url.pathname + url.search);
    assert.equal(url.hostname, "api.razorpay.com"); assert.equal(init?.method, "GET", "invoice/quota reconciliation cannot initiate a provider charge");
    assert.equal(new Headers(init?.headers).get("Authorization"), `Basic ${Buffer.from("rzp_test_quota123:billing-invoice-key").toString("base64")}`);
    if (url.pathname.startsWith("/v1/subscriptions/")) { const entity = entities.get(url.pathname.split("/")[3]); assert.ok(entity); return Response.json(entity); }
    if (url.pathname === "/v1/invoices") {
      assert.equal(url.searchParams.get("subscription_id"), first.subscription!.providerId);
      const skip = Number(url.searchParams.get("skip")), amount = Number(url.searchParams.get("count")); assert.equal(amount, 11);
      return Response.json({ items: invoiceRows.slice(skip, skip + amount), count: invoiceRows.length });
    }
    throw new Error(`Unexpected provider call ${url}`);
  });

  await t.test("current subscription binding is read from the database and invoice access never writes billing/revenue state", async () => {
    const before = await loadPostgresWorkspace(first.id);
    entities.get(first.subscription!.providerId!)!.status = "active";
    const result = await listBillingInvoices({ ...before, subscription: second.subscription });
    assert.equal(result.invoices[0].id, "inv_Verified"); assert.equal(result.mode, "test");
    assert.deepEqual(await loadPostgresWorkspace(first.id), before, "a verified invoice read must not activate a trial, advance revision, or create a student receipt");
    assert.equal((await loadPostgresWorkspace(second.id)).revenue.length, 0);
    invoiceRows = [invoiceFixture(first.subscription!.providerId!), invoiceFixture(second.subscription!.providerId!, "inv_Foreign")];
    await assert.rejects(() => listBillingInvoices(before), /does not match/);
    const original = entities.get(first.subscription!.providerId!)!;
    entities.set(original.id, { ...original, notes: { ...original.notes, admitflow_workspace_id: second.id } });
    const previousCalls = paths.length;
    await assert.rejects(() => listBillingInvoices(before), /does not belong/);
    assert.equal(paths.length, previousCalls + 1, "foreign subscription binding must fail before listing invoices");
    entities.set(original.id, original);
  });

  await t.test("invoice pagination validates look-ahead rows and handles unsafe links, empty pages and missing keys", async child => {
    invoiceRows = Array.from({ length: 12 }, (_, index) => invoiceFixture(first.subscription!.providerId!, `inv_Page${index}`));
    invoiceRows[0].short_url = "https://evil.example/not-an-invoice";
    const pageOne = await listBillingInvoices(first);
    assert.equal(pageOne.invoices.length, 10); assert.equal(pageOne.hasMore, true); assert.equal(pageOne.invoices[0].hostedUrl, null);
    const pageTwo = await listBillingInvoices(first, 2);
    assert.equal(pageTwo.invoices.length, 2); assert.equal(pageTwo.hasMore, false);
    invoiceRows[10] = invoiceFixture(second.subscription!.providerId!, "inv_LookaheadForeign");
    await assert.rejects(() => listBillingInvoices(first), /does not match/);
    invoiceRows = [];
    assert.equal((await listBillingInvoices(first)).state, "empty");
    const calls = paths.length;
    environment(child, { BILLING_RAZORPAY_KEY_SECRET: undefined });
    const setup = await listBillingInvoices(first); assert.equal(setup.state, "setup"); assert.equal(paths.length, calls);
  });

  const lead = (workspace: typeof first, suffix: number) => ({ name: `Student ${suffix}`, phone: `+91990${String(suffix).padStart(7, "0")}`, ownerId: workspace.members![0].id });
  const intake = (workspaceId: string, action: { type: "lead.create"; lead: Record<string, unknown> } | { type: "lead.import"; rows: Record<string, unknown>[] }) => mutateWorkspace(workspaceId, current => {
    const previousCount = current.leads.length;
    const result = applyAction(current, action);
    assertEnquiryEntitlement(current, previousCount, action.type);
    return result;
  });

  await t.test("concurrent enquiry creation shares the last available slot; old IDs can be reconciled without a name match", async () => {
    await intake(first.id, { type: "lead.create", lead: lead(first, 1) });
    await intake(first.id, { type: "lead.create", lead: lead(first, 2) });
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => intake(first.id, { type: "lead.create", lead: lead(first, 10 + index) })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    for (const result of results) if (result.status === "rejected") assert.equal((result.reason as AppError).status, 409);
    const current = await loadPostgresWorkspace(first.id);
    assert.equal(current.leads.length, 3);
    const duplicate = await intake(first.id, { type: "lead.import", rows: [lead(first, 1), { name: "Invalid phone", phone: "not-a-phone" }] });
    assert.equal((duplicate.result as { imported: number }).imported, 0);
    assert.equal((duplicate.result as { duplicates: number }).duplicates, 1);
    assert.equal((duplicate.result as { errors: unknown[] }).errors.length, 1);
    await mutateWorkspace(second.id, workspace => { workspace.subscription = { status: "trial", providerId: second.subscription!.providerId, plan: "Wrong display name" }; });
    await prepareBillingEntitlements(await loadPostgresWorkspace(second.id));
    const repaired = await loadPostgresWorkspace(second.id);
    assert.equal(repaired.subscription?.providerPlanId, limitedPlan.razorpayPlanId); assert.equal(repaired.subscription?.planId, limitedPlan.id);
    assert.equal(repaired.subscription?.status, "trial");
  });

  await t.test("over-limit imports roll back all rows, courses, activity and revision; valid duplicate-aware imports still report row errors", async () => {
    await intake(imports.id, { type: "lead.create", lead: lead(imports, 100) });
    const before = await loadPostgresWorkspace(imports.id);
    const rows = [lead(imports, 100), { ...lead(imports, 101), course: "New course from import" }, lead(imports, 102), lead(imports, 103), { name: "Invalid", phone: "bad" }];
    await assert.rejects(() => intake(imports.id, { type: "lead.import", rows }), /No import rows were saved/);
    assert.deepEqual(await loadPostgresWorkspace(imports.id), before);
    const accepted = await intake(imports.id, { type: "lead.import", rows: [rows[0], rows[1], rows[2], rows[4]] });
    assert.equal((accepted.result as { imported: number }).imported, 2); assert.equal((accepted.result as { duplicates: number }).duplicates, 1); assert.equal((accepted.result as { errors: unknown[] }).errors.length, 1);
    const current = await loadPostgresWorkspace(imports.id); assert.equal(current.leads.length, 3); assert.equal(current.courses.filter(course => course === "New course from import").length, 1);
  });

  await t.test("seat reservations prevent concurrent overbooking and duplicate invitations never reserve a second seat", async () => {
    await mutateWorkspace(first.id, workspace => { workspace.members!.push({ id: "member_same_name", workosId: "user_same_name", name: "Same Name", email: "another@example.com", status: "active", role: "counsellor" }); });
    assert.equal(billingSeatUsage((await loadPostgresWorkspace(first.id)).members!).members, 2);
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => reserveBillingSeat(first.id, { email: `seat-${index}@example.com`, kind: "invite" })));
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<BillingSeatClaim | null> => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1);
    const claim = fulfilled[0].value!;
    const index = results.findIndex(result => result.status === "fulfilled"), email = `seat-${index}@example.com`;
    const duplicates = await Promise.all(Array.from({ length: 4 }, () => reserveBillingSeat(first.id, { email: email.toUpperCase(), kind: "invite" })));
    assert.ok(duplicates.every(item => item?.requestId === claim.requestId && !item.owned));
    let usage = await readBillingEntitlements(await loadPostgresWorkspace(first.id));
    assert.equal(usage.usage.members, 3); assert.equal(usage.usage.reservedMembers, 1);
    await failBillingSeat(duplicates[0], new AppError("Duplicate request", 409), true);
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(first.id))).usage.members, 3, "a non-owning duplicate cannot release the in-flight seat");
    await confirmBillingSeat(claim, "invitation_quota");
    await mutateWorkspace(first.id, workspace => { workspace.members!.push({ id: "member_pending_seat", workosId: "user_pending_seat", name: "Invitee", email, role: "counsellor", status: "invited" }, { id: "invitation_quota", name: "Invitee", email, role: "counsellor", status: "invited" }); });
    usage = await readBillingEntitlements(await loadPostgresWorkspace(first.id));
    assert.equal(usage.usage.members, 3); assert.equal(usage.usage.reservedMembers, 0);
    await mutateWorkspace(first.id, workspace => { workspace.members = workspace.members!.filter(member => !["member_pending_seat", "invitation_quota"].includes(member.id)); });
    await reconcileBillingSeats(first.id, "org_quota_0", { observedAt: Date.now() + 100, memberships: [], invitations: [] });
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(first.id))).usage.members, 3, "missing projections cannot free a confirmed reservation");
    await assert.rejects(() => reconcileBillingSeats(first.id, "org_quota_1", { observedAt: Date.now() + 100, memberships: [], invitations: [] }), /another institute/);
    await reconcileBillingSeats(first.id, "org_quota_0", { observedAt: 0, memberships: [], invitations: [{ id: "invitation_quota", email, organizationId: "org_quota_0", state: "revoked", acceptedUserId: null }] });
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(first.id))).usage.members, 3, "stale evidence cannot release a newer reservation");
    await reconcileBillingSeats(first.id, "org_quota_0", { observedAt: Date.now() + 100, memberships: [], invitations: [{ id: "invitation_quota", email, organizationId: "org_quota_0", state: "revoked", acceptedUserId: null }] });
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(first.id))).usage.members, 2);
    const next = await reserveBillingSeat(first.id, { email, kind: "invite" }); assert.ok(next?.owned); assert.notEqual(next.requestId, claim.requestId);
    await failBillingSeat(claim, new AppError("Old failure", 400), true);
    await assert.rejects(() => confirmBillingSeat(claim, "invitation_old"), /reservation changed/);
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(first.id))).usage.members, 3);
    await failBillingSeat(next, new TypeError("Unknown provider outcome"));
    await assert.rejects(() => reserveBillingSeat(first.id, { email: "overbooked@example.com", kind: "invite" }), /member limit/);
    const otherTenant = await reserveBillingSeat(second.id, { email: "overbooked@example.com", kind: "invite" }); assert.ok(otherTenant?.owned);
  });

  await t.test("reactivation uses a seat and positive inactive evidence releases it; explicit unlimited settings preserve app intake", async child => {
    await mutateWorkspace(second.id, workspace => { workspace.members!.push({ id: "member_inactive", workosId: "user_inactive", name: "Inactive", email: "inactive@example.com", status: "inactive", role: "counsellor" }); });
    const seat = await reserveBillingSeat(second.id, { email: "inactive@example.com", kind: "reactivate", memberId: "member_inactive", workosId: "user_inactive" });
    assert.ok(seat?.owned);
    await assert.rejects(() => reserveBillingSeat(second.id, { email: "extra@example.com", kind: "invite" }), /member limit/);
    await confirmBillingSeat(seat, "om_reactivated", "user_inactive");
    await mutateWorkspace(second.id, workspace => { workspace.members!.find(member => member.id === "member_inactive")!.status = "active"; });
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(second.id))).usage.members, 3);
    await mutateWorkspace(second.id, workspace => { workspace.members!.find(member => member.id === "member_inactive")!.status = "inactive"; });
    await reconcileBillingSeats(second.id, "org_quota_1", { observedAt: Date.now() + 100, memberships: [{ id: "om_reactivated", userId: "user_inactive", organizationId: "org_quota_1", status: "inactive" }], invitations: [] });
    assert.equal((await readBillingEntitlements(await loadPostgresWorkspace(second.id))).usage.members, 2);
    environment(child, { BILLING_PLANS_JSON: JSON.stringify([{ ...limitedPlan, limits: { members: null, leads: null } }]) });
    await intake(first.id, { type: "lead.create", lead: lead(first, 999) });
    const policy = await readBillingEntitlements(await loadPostgresWorkspace(first.id)); assert.deepEqual(policy.limits, { members: null, leads: null }); assert.equal(policy.usage.leads, 4);
    const unlimitedSeat = await reserveBillingSeat(first.id, { email: "unlimited@example.com", kind: "invite" }); assert.ok(unlimitedSeat?.owned);
  });
});
