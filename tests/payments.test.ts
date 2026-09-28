import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { applyPaymentEvent, createPaymentLink, paymentEventReference, reconcilePayment } from "../src/lib/providers/payments";
import { acceptPaymentEvent, inspectPaymentEvents, processPaymentReceipt, recoverPaymentEvents, retryPaymentEvent, PAYMENT_MAX_ATTEMPTS } from "../src/lib/db/payment-inbox";
import { KMSClient } from "@aws-sdk/client-kms";
import { POST } from "../src/app/api/webhooks/razorpay/[workspaceId]/route";
import { createWorkspace } from "../src/lib/seed";
import { uid } from "../src/lib/domain";
import { sealSecret } from "../src/lib/secrets";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace } from "../src/lib/db/repository";
import * as schema from "../src/lib/db/schema";

const capture = (workspaceId: string, leadId: string, id = "pay_Test", amount = 30) => ({ event: "payment.captured", payload: { payment: { entity: { id, amount, currency: "INR", status: "captured", captured: true, notes: { admitflow_workspace_id: workspaceId, admitflow_lead_id: leadId } as Record<string, unknown> } } } });
const refund = (id = "rfnd_Test", amount = 10, paymentId = "pay_Test") => ({ event: "refund.processed", payload: { refund: { entity: { id, payment_id: paymentId, amount, currency: "INR", status: "processed" } } } });

test("payment amounts are integer paise; partial-to-full refunds and conflicting duplicates are correct", () => {
  const workspace = createWorkspace(); workspace.revenue = []; workspace.refunds = [];
  const event = capture(workspace.id, workspace.leads[0].id);
  assert.throws(() => applyPaymentEvent(workspace, refund()), /before its refund/);
  const uncaptured = structuredClone(event); uncaptured.payload.payment.entity.captured = false;
  assert.throws(() => applyPaymentEvent(workspace, uncaptured));
  const ambiguous = structuredClone(event); ambiguous.payload.payment.entity.status = "refunded";
  Reflect.deleteProperty(ambiguous.payload.payment.entity, "captured");
  assert.throws(() => applyPaymentEvent(workspace, ambiguous), /not been captured/);
  applyPaymentEvent(workspace, event);
  applyPaymentEvent(workspace, refund()); applyPaymentEvent(workspace, refund("rfnd_Balance", 20));
  assert.equal(workspace.refunds.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 30);
  assert.equal(applyPaymentEvent(workspace, refund()), "duplicate");
  assert.throws(() => applyPaymentEvent(workspace, refund("rfnd_Test", 11)), /conflicts/);
  assert.throws(() => applyPaymentEvent(workspace, refund("rfnd_Extra", 1)), /Invalid refund/);
  assert.throws(() => applyPaymentEvent(workspace, capture(workspace.id, workspace.leads[0].id, "pay_Test", 31)), /conflicts/);
  for (const amount of [0, -1, 0.1, Number.NaN, Infinity, 1_000_000_001, "30"]) {
    const value = structuredClone(event); Object.assign(value.payload.payment.entity, { amount });
    assert.throws(() => paymentEventReference(value));
    const valueRefund = refund(); Object.assign(valueRefund.payload.refund.entity, { amount });
    assert.throws(() => paymentEventReference(valueRefund));
  }
  for (const patch of [{ id: "../pay_Test" }, { status: "pending" }, { currency: "USD" }, { captured: false }, { captured: undefined }]) {
    const value = structuredClone(event); Object.assign(value.payload.payment.entity, patch);
    assert.throws(() => paymentEventReference(value));
  }
  assert.equal(paymentEventReference({ event: "subscription.charged" }), null);
});

test("payment links reject fractional paise before accessing credentials or providers", async t => {
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("No external requests permitted"); });
  const workspace = createWorkspace();
  for (const amount of [0, -1, NaN, Infinity, 0.001, 0.009, 0.019, 1.001, 10_000_000.01]) {
    await assert.rejects(() => createPaymentLink(workspace, workspace.leads[0].id, amount), /valid payment amount/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("admission webhook enforces streamed byte limits and malformed input without provider calls", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No external requests permitted"); });
  const params = { params: Promise.resolve({ workspaceId: uid() }) };
  const request = (body: BodyInit, headers: Record<string, string> = {}) => new NextRequest("http://localhost/api/webhooks/razorpay/test", { method: "POST", body, headers, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
  assert.equal((await POST(request("x".repeat(500001)), params)).status, 413);
  assert.equal((await POST(request("é".repeat(250001), { "content-length": "1" }), params)).status, 413);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(300000)); }, cancel() { cancelled = true; } });
  assert.equal((await POST(request(stream), params)).status, 413); assert.equal(cancelled, true);
  assert.equal((await POST(request("{}", { "content-length": "99999999" }), params)).status, 413);
  assert.equal((await POST(request(new Uint8Array([255])), params)).status, 400);
  assert.equal((await POST(request("{}"), params)).status, 503);
  assert.equal((await POST(request("{}"), { params: Promise.resolve({ workspaceId: "invalid" }) })).status, 400);
});

test("durable signed payment inbox reconciles out-of-order delivery, failures, crashes and tenant boundaries", async t => {
  const previous = { ...process.env };
  process.env.DATABASE_URL = "postgresql://injected-pglite-only";
  process.env.ADMITFLOW_DB = ":memory:";
  process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString("base64"); delete process.env.KMS_KEY_ID;
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const pg = new PGlite(); t.after(() => pg.close());
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
  const workspace = createWorkspace(); workspace.demo = false; workspace.revenue = []; workspace.refunds = [];
  const keyId = "rzp_test_TestAccount123", webhookSecret = "fixture-webhook-signing-only";
  workspace.connections = [{ id: uid(), service: "razorpay", externalId: workspace.id, label: "Test", status: "connected", updatedAt: new Date().toISOString(), metadata: {}, secret: await sealSecret({ keyId, keySecret: "fixture-payment-api-key-secret", webhookSecret }, workspace.id) }];
  await createPostgresWorkspace(workspace, "org_payments");
  const event = capture(workspace.id, workspace.leads[0].id);
  let payment = event.payload.payment.entity, refundValue = refund().payload.refund.entity, outage = false, requests = 0;
  let beforeResponse: (() => Promise<void>) | undefined, links = 0;
  const providerLinks = new Map<string, Record<string, unknown>>(), paymentLinks = new Map<string, string[]>();
  const authoritative = new Map<string, typeof payment>(), requestPaths: string[] = [];
  const canonicalContext = new AsyncLocalStorage<Record<string, unknown>>();
  let canonicalBarrier: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.razorpay.com");
    if (init?.method === "POST") {
      assert.equal(String(input), "https://api.razorpay.com/v1/payment_links");
      const body = JSON.parse(String(init.body));
      assert.equal(body.accept_partial, false); assert.deepEqual(body.notify, { sms: false, email: false });
      return Response.json({ id: `plink_Fixture${++links}`, short_url: `https://rzp.io/i/fixture${links}`, amount: body.amount, currency: body.currency, accept_partial: false, notes: null });
    }
    requests++; assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    requestPaths.push(url.pathname + url.search);
    assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    const hook = beforeResponse; beforeResponse = undefined;
    await hook?.();
    if (outage) throw new Error("sensitive provider exception must not be stored");
    if (String(input).includes("/refunds/")) return Response.json(refundValue);
    if (url.pathname === "/v1/payment_links") {
      assert.deepEqual([...url.searchParams.keys()], ["payment_id"]);
      return Response.json({ payment_links: (paymentLinks.get(url.searchParams.get("payment_id")!) || []).map(id => ({ id, payments: [] })) });
    }
    if (url.pathname.startsWith("/v1/payment_links/")) {
      const id = url.pathname.split("/").at(-1)!;
      assert.ok(providerLinks.has(id), "Only fixture link reads are allowed");
      await canonicalBarrier?.();
      return Response.json(canonicalContext.getStore() || providerLinks.get(id));
    }
    assert.ok(String(input).startsWith("https://api.razorpay.com/v1/payments/"));
    return Response.json(authoritative.get(url.pathname.split("/").at(-1)!) || payment);
  });
  t.mock.method(console, "error", () => undefined);
  const rawFor = (value: unknown) => JSON.stringify(value);
  const idFor = (value: unknown) => `razorpay_admission:${workspace.id}:${createHash("sha256").update(rawFor(value)).digest("hex")}`;
  const issue = async (entity: typeof payment) => {
    const link = await createPaymentLink(await loadPostgresWorkspace(workspace.id), String(entity.notes.admitflow_lead_id), entity.amount / 100);
    providerLinks.set(link.id, { id: link.id, amount: entity.amount, amount_paid: entity.amount, currency: "INR", accept_partial: false, status: "paid", notes: null,
      payments: [{ payment_id: entity.id, amount: entity.amount, status: "captured" }],
    });
    paymentLinks.set(entity.id, [link.id]);
    return link.id;
  };
  const issuedId = (id: string) => `razorpay_link:${workspace.id}:${id}`;
  const deliver = (value: unknown, headerId = "same-unsigned-id", signature?: string) => {
    const body = rawFor(value);
    return POST(new NextRequest(`http://localhost/api/webhooks/razorpay/${workspace.id}`, { method: "POST", body, headers: { "x-razorpay-event-id": headerId, "x-razorpay-signature": signature ?? createHmac("sha256", webhookSecret).update(body).digest("hex") } }), { params: Promise.resolve({ workspaceId: workspace.id }) });
  };
  const state = async (id: string) => (await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, id)))[0];
  const change = async (id: string, patch: Record<string, unknown>, processedAt: string | null = null) => {
    const row = await state(id);
    await db.update(schema.eventReceipts).set({ payload: { ...row.payload, ...patch }, processedAt }).where(eq(schema.eventReceipts.id, id));
  };

  await t.test("signature and payload errors do not persist receipts", async () => {
    assert.equal((await deliver(event, "x", "0".repeat(64))).status, 403);
    const raw = rawFor(event), signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
    const altered = new NextRequest(`http://localhost/api/webhooks/razorpay/${workspace.id}`, { method: "POST", body: `\uFEFF${raw}`, headers: { "x-razorpay-signature": signature } });
    assert.equal((await POST(altered, { params: Promise.resolve({ workspaceId: workspace.id }) })).status, 403);
    const bad = structuredClone(event); bad.payload.payment.entity.amount = -1;
    assert.equal((await deliver(bad)).status, 400);
    assert.equal((await deliver({ event: "subscription.charged" })).status, 200);
    assert.equal((await db.select().from(schema.eventReceipts)).length, 0); assert.equal(requests, 0);
  });
  await t.test("only demos are permanently ignored; missing live identity and disconnected credentials remain retryable", async st => {
    const kms = st.mock.method(KMSClient.prototype, "send", async () => assert.fail("No KMS for demo delivery"));
    const before = requests;
    await db.update(schema.organizations).set({ demo: true }).where(eq(schema.organizations.id, workspace.id));
    try {
      const unsigned = new NextRequest(`http://localhost/api/webhooks/razorpay/${workspace.id}`, { method: "POST", body: "not even JSON" });
      const response = await POST(unsigned, { params: Promise.resolve({ workspaceId: workspace.id }) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { received: true, ignored: true });
      const raced = await acceptPaymentEvent(workspace.id, paymentEventReference(event)!, rawFor(event), workspace.connections![0], keyId);
      assert.deepEqual(raced, { received: true, ignored: true });
      assert.equal((await db.select().from(schema.eventReceipts)).length, 0);
      assert.equal(kms.mock.callCount(), 0); assert.equal(requests, before);
    } finally { await db.update(schema.organizations).set({ demo: false, workosId: null }).where(eq(schema.organizations.id, workspace.id)); }
    try {
      assert.equal((await deliver(event)).status, 503);
      assert.equal((await db.select().from(schema.eventReceipts)).length, 0);
    } finally { await db.update(schema.organizations).set({ workosId: "org_payments" }).where(eq(schema.organizations.id, workspace.id)); }
    const connection = workspace.connections![0];
    await db.update(schema.connections).set({ status: "disconnected", secret: null }).where(eq(schema.connections.id, connection.id));
    try {
      const response = await deliver(event);
      assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
      assert.equal((await db.select().from(schema.eventReceipts)).length, 0);
    } finally { await db.update(schema.connections).set({ status: "connected", secret: connection.secret }).where(eq(schema.connections.id, connection.id)); }
    assert.equal(requests, before);
  });
  const firstLink = await issue(payment);
  await t.test("issuance durably binds the provider link ID, tenant, lead, amount and merchant", async () => {
    const row = await state(issuedId(firstLink)); assert.ok(row.processedAt);
    assert.equal(row.provider, "razorpay_link"); assert.equal(row.organizationId, workspace.id);
    assert.deepEqual(row.payload, { version: 2, providerLinkId: firstLink, leadId: workspace.leads[0].id,
      amountPaise: 30, currency: "INR", connectionId: workspace.connections![0].id, keyFingerprint: createHash("sha256").update(keyId).digest("hex") });
  });
  await t.test("refund before capture reconstructs payment from canonical link even without propagated notes", async () => {
    const first = refund();
    assert.equal((await deliver(first)).status, 200); assert.equal(requests, 0);
    const saved = await state(idFor(first)); assert.ok(saved && !saved.processedAt);
    assert.ok(!JSON.stringify(saved.payload).includes("notes")); assert.ok(!JSON.stringify(saved.payload).includes(webhookSecret));
    payment = { ...payment, status: "refunded", captured: true, notes: {} };
    assert.equal(await processPaymentReceipt(workspace.id, idFor(first)), "processed");
    let current = await loadPostgresWorkspace(workspace.id); assert.equal(current.revenue.length, 1); assert.equal(current.refunds!.length, 1);
    assert.equal((await state(issuedId(firstLink))).payload.creditedPaymentId, payment.id);
    assert.equal((await deliver(event)).status, 200);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(event)), "processed");
    const balance = refund("rfnd_Balance", 20); refundValue = balance.payload.refund.entity;
    await deliver(balance); await processPaymentReceipt(workspace.id, idFor(balance));
    current = await loadPostgresWorkspace(workspace.id);
    assert.equal(current.revenue.length, 1); assert.equal(current.refunds!.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 30);
    const before = requests; await deliver(first, "changed-unsigned-header");
    assert.equal(await processPaymentReceipt(workspace.id, idFor(first)), "skipped"); assert.equal(requests, before);
  });
  await t.test("outage persists backoff, exhausted events require explicit tenant-scoped replay", async () => {
    const second = capture(workspace.id, workspace.leads[1].id, "pay_Second", 100);
    await issue(second.payload.payment.entity);
    payment = second.payload.payment.entity; outage = true;
    await deliver(second); const id = idFor(second);
    assert.equal(await processPaymentReceipt(workspace.id, id), "pending");
    let row = await state(id); assert.equal(row.payload.attempts, 1); assert.equal(row.processedAt, null);
    assert.ok(!JSON.stringify(row).includes("sensitive"));
    const before = requests; assert.equal(await processPaymentReceipt(workspace.id, id), "skipped"); assert.equal(requests, before);
    await change(id, { attempts: PAYMENT_MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0).toISOString() });
    assert.equal(await processPaymentReceipt(workspace.id, id), "failed");
    row = await state(id); assert.equal(row.payload.nextAttemptAt, null);
    await assert.rejects(() => retryPaymentEvent(uid(), id));
    assert.equal((await inspectPaymentEvents(workspace.id))[0].status, "failed");
    outage = false; assert.equal(await retryPaymentEvent(workspace.id, id), "processed");
  });
  await t.test("stale claims replay a previously committed payment without duplicating financial records", async () => {
    const id = idFor(event); payment = event.payload.payment.entity;
    await change(id, { status: "processing", claim: uid(), attempts: 1, nextAttemptAt: new Date(0).toISOString() });
    const before = (await loadPostgresWorkspace(workspace.id)).revenue.length;
    const results = await recoverPaymentEvents(); assert.equal(results.processed, 1);
    assert.equal((await loadPostgresWorkspace(workspace.id)).revenue.length, before);
  });
  await t.test("concurrent deliveries and workers share a lease; wrong authoritative IDs never post money", async () => {
    const next = capture(workspace.id, workspace.leads[2].id, "pay_Concurrent", 100);
    await issue(next.payload.payment.entity);
    payment = next.payload.payment.entity;
    await Promise.all([deliver(next), deliver(next)]);
    const result = await Promise.all([processPaymentReceipt(workspace.id, idFor(next)), processPaymentReceipt(workspace.id, idFor(next))]);
    assert.equal(result.filter(value => value === "processed").length, 1);
    assert.equal((await loadPostgresWorkspace(workspace.id)).revenue.filter(row => row.providerId === "pay_Concurrent").length, 1);
    const wrong = capture(workspace.id, workspace.leads[2].id, "pay_Wrong", 100);
    await issue(wrong.payload.payment.entity);
    await deliver(wrong); assert.equal(await processPaymentReceipt(workspace.id, idFor(wrong)), "pending");
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === "pay_Wrong"));
  });
  await t.test("a failed durable insert returns retryable failure without acknowledging or fetching", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_IntakeFailure", 100);
    await issue(next.payload.payment.entity);
    const before = requests;
    await pg.exec("alter table event_receipts add constraint fixture_intake_failure check ((payload->'reference'->>'paymentId') is distinct from 'pay_IntakeFailure')");
    try {
      const response = await deliver(next);
      assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "30");
      assert.equal(await state(idFor(next)), undefined); assert.equal(requests, before);
    } finally { await pg.exec("alter table event_receipts drop constraint fixture_intake_failure"); }
  });
  await t.test("refund persistence failure rolls back capture and side effects, then replays once", async () => {
    payment = capture(workspace.id, workspace.leads[0].id, "pay_Rollback", 100).payload.payment.entity;
    const linkId = await issue(payment), issuedBefore = await state(issuedId(linkId));
    const next = refund("rfnd_Rollback", 40, payment.id); refundValue = next.payload.refund.entity;
    await deliver(next);
    const before = await loadPostgresWorkspace(workspace.id);
    await pg.exec("alter table refunds add constraint fixture_refund_failure check (reference <> 'rfnd_Rollback')");
    try {
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.deepEqual(await state(issuedId(linkId)), issuedBefore, "link consumption rolls back with the ledger");
      assert.equal((await state(idFor(next))).processedAt, null);
    } finally { await pg.exec("alter table refunds drop constraint fixture_refund_failure"); }
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
    const current = await loadPostgresWorkspace(workspace.id);
    assert.equal(current.revenue.filter(row => row.providerId === payment.id).length, 1);
    assert.equal(current.refunds!.filter(row => row.reference === refundValue.id).length, 1);
    assert.equal((await state(issuedId(linkId))).payload.creditedPaymentId, payment.id);
  });
  await t.test("a replaced claim cannot be completed or failed by an older worker", async () => {
    for (const fails of [false, true]) {
      const next = capture(workspace.id, workspace.leads[0].id, fails ? "pay_StaleFailure" : "pay_StaleSuccess", 100);
      await issue(next.payload.payment.entity);
      payment = next.payload.payment.entity; await deliver(next);
      const id = idFor(next), replacement = uid();
      beforeResponse = () => change(id, { claim: replacement }); outage = fails;
      try {
        assert.equal(await processPaymentReceipt(workspace.id, id), "skipped");
        const row = await state(id);
        assert.equal(row.payload.claim, replacement); assert.equal(row.payload.status, "processing");
        assert.equal(row.processedAt, null); assert.equal(row.error, null);
        await assert.rejects(() => retryPaymentEvent(workspace.id, id), /still being processed/);
      } finally { outage = false; beforeResponse = undefined; }
      await change(id, { nextAttemptAt: new Date(0).toISOString() });
      assert.equal(await retryPaymentEvent(workspace.id, id), "processed");
      assert.equal((await loadPostgresWorkspace(workspace.id)).revenue.filter(row => row.providerId === payment.id).length, 1);
    }
  });
  await t.test("operator replay cannot silently bind an old event to a different merchant key", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_KeyChange", 100);
    await issue(next.payload.payment.entity);
    payment = next.payload.payment.entity; await deliver(next);
    const original = workspace.connections![0].secret;
    const rotated = await sealSecret({ keyId: "rzp_test_DifferentAccount123", keySecret: "fixture-payment-api-key-secret", webhookSecret }, workspace.id);
    await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].secret = rotated; });
    const before = requests;
    try {
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "pending");
      assert.equal(requests, before);
      assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === payment.id));
    } finally { await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].secret = original; }); }
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
  });
  await t.test("connection changes during a provider read prevent stale financial commits", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_MidFetch", 100);
    await issue(next.payload.payment.entity);
    payment = next.payload.payment.entity; await deliver(next);
    const rotated = await sealSecret({ keyId, keySecret: "fixture-rotated-api-key-secret", webhookSecret }, workspace.id);
    beforeResponse = async () => { await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].secret = rotated; }); };
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === payment.id));
    // Same key ID can recover with fresh credentials; changing the key ID above cannot.
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
  });
  await t.test("copied notes on an unrelated payment cannot claim a recorded link", async () => {
    const missing = capture(workspace.id, workspace.leads[0].id, "pay_NoIssuedLink", 100);
    missing.payload.payment.entity.notes.admitflow_link_id = firstLink;
    payment = missing.payload.payment.entity;
    const before = await loadPostgresWorkspace(workspace.id);
    await deliver(missing);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(missing)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
  });
  await t.test("absent, empty and hostile notes do not override durable link attribution", async () => {
    for (const [index, notes] of [undefined, null, [], {}, { admitflow_workspace_id: uid(), admitflow_lead_id: workspace.leads[1].id, admitflow_link_id: firstLink }].entries()) {
      const next = capture(workspace.id, workspace.leads[0].id, `pay_Notes${index}`, 100);
      const linkId = await issue(next.payload.payment.entity);
      Object.assign(next.payload.payment.entity, { notes });
      payment = next.payload.payment.entity;
      await deliver(next);
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "processed");
      const row = (await loadPostgresWorkspace(workspace.id)).revenue.find(item => item.providerId === payment.id);
      assert.equal(row?.leadId, workspace.leads[0].id);
      assert.equal((await state(issuedId(linkId))).payload.creditedPaymentId, payment.id);
    }
  });
  await t.test("ambiguous or conflicting canonical link associations fail closed", async st => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["DifferentLink", { id: "plink_Other" }],
      ["DifferentPayment", { payments: [{ payment_id: "pay_Other", amount: 100, status: "captured" }] }],
      ["NoPayments", { payments: [] }], ["NullPayments", { payments: null }],
      ["DifferentAmount", { amount: 101 }], ["Underpaid", { amount_paid: 99 }], ["Overpaid", { amount_paid: 101 }],
      ["DifferentCurrency", { currency: "USD" }], ["PartialAllowed", { accept_partial: true }], ["Unpaid", { status: "created" }],
    ];
    for (const [name, patch] of cases) await st.test(name, async () => {
      const next = capture(workspace.id, workspace.leads[0].id, `pay_${name}`, 100);
      const linkId = await issue(next.payload.payment.entity);
      providerLinks.set(linkId, { ...providerLinks.get(linkId), ...patch });
      payment = next.payload.payment.entity;
      const before = await loadPostgresWorkspace(workspace.id);
      await deliver(next);
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.equal((await state(issuedId(linkId))).payload.creditedPaymentId, undefined);
    });
    for (const name of ["WrongEntryAmount", "WrongEntryLink", "PendingEntry", "MultiplePayments", "MultipleLinks", "UnsafeLinkId"]) await st.test(name, async () => {
      const next = capture(workspace.id, workspace.leads[0].id, `pay_${name}`, 100);
      const linkId = await issue(next.payload.payment.entity), link = providerLinks.get(linkId)!;
      const entry = { payment_id: next.payload.payment.entity.id, amount: 100, status: "captured" };
      if (name === "WrongEntryAmount") link.payments = [{ ...entry, amount: 99 }];
      if (name === "WrongEntryLink") link.payments = [{ ...entry, plink_id: "plink_Other" }];
      if (name === "PendingEntry") link.payments = [{ ...entry, status: "authorized" }];
      if (name === "MultiplePayments") link.payments = [entry, { ...entry, payment_id: "pay_Other" }];
      if (name === "MultipleLinks") paymentLinks.set(next.payload.payment.entity.id, [linkId, "plink_Other"]);
      if (name === "UnsafeLinkId") paymentLinks.set(next.payload.payment.entity.id, ["../payments/pay_Other"]);
      payment = next.payload.payment.entity;
      const before = await loadPostgresWorkspace(workspace.id), pathsBefore = requestPaths.length;
      await deliver(next);
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.equal((await state(issuedId(linkId))).payload.creditedPaymentId, undefined);
      if (name === "UnsafeLinkId") assert.equal(requestPaths.length - pathsBefore, 2, "invalid link IDs never reach a provider URL");
    });
  });
  await t.test("provider truth cannot override a durable amount, merchant, link or format mismatch", async () => {
    const cases = [
      { amountPaise: 101 }, { currency: "USD" }, { connectionId: uid() },
      { keyFingerprint: "f".repeat(64) }, { providerLinkId: "plink_Other" }, { version: 1 },
    ];
    for (const [index, patch] of cases.entries()) {
      const next = capture(workspace.id, workspace.leads[0].id, `pay_DurableMismatch${index}`, 100);
      const linkId = await issue(next.payload.payment.entity), row = await state(issuedId(linkId));
      await db.update(schema.eventReceipts).set({ payload: { ...row.payload, ...patch } }).where(eq(schema.eventReceipts.id, row.id));
      payment = next.payload.payment.entity;
      const before = await loadPostgresWorkspace(workspace.id);
      await deliver(next);
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.equal((await state(row.id)).payload.creditedPaymentId, undefined);
    }
  });
  await t.test("a fully refunded link cannot credit a second payment even if canonical membership changes", async () => {
    const next = capture(workspace.id, workspace.leads[1].id, "pay_ReuseRefundedLink", 30);
    next.payload.payment.entity.notes.admitflow_link_id = firstLink;
    paymentLinks.set(next.payload.payment.entity.id, [firstLink]);
    const oldLink = providerLinks.get(firstLink)!;
    providerLinks.set(firstLink, { ...oldLink, payments: [{ payment_id: next.payload.payment.entity.id, amount: 30, status: "captured" }] });
    payment = next.payload.payment.entity;
    const before = await loadPostgresWorkspace(workspace.id);
    await deliver(next);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
    assert.equal((await state(issuedId(firstLink))).payload.creditedPaymentId, "pay_Test");
    providerLinks.set(firstLink, oldLink);
  });
  await t.test("two concurrent payments claiming one issued link can credit only one fee", { timeout: 15_000 }, async () => {
    const a = capture(workspace.id, workspace.leads[0].id, "pay_LinkRaceA", 100).payload.payment.entity;
    const b = capture(workspace.id, workspace.leads[1].id, "pay_LinkRaceB", 100).payload.payment.entity;
    const linkId = await issue(a);
    authoritative.set(a.id, a); authoritative.set(b.id, b); paymentLinks.set(b.id, [linkId]);
    let ready = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    canonicalBarrier = async () => { if (++ready === 2) release(); await barrier; };
    const expected = { connectionId: workspace.connections![0].id, keyFingerprint: createHash("sha256").update(keyId).digest("hex") };
    try {
      const results = await Promise.allSettled([a, b].map(entity => canonicalContext.run({
        ...providerLinks.get(linkId), payments: [{ payment_id: entity.id, amount: 100, status: "captured", plink_id: linkId }],
      }, () => reconcilePayment(workspace.id, { event: "payment.captured", paymentId: entity.id, amount: 100 }, expected))));
      assert.equal(ready, 2, "both workers verified provider data before contending for the claim");
      assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
      const rejected = results.find(item => item.status === "rejected") as PromiseRejectedResult;
      assert.match(String(rejected.reason), /already credited another payment/);
      const rows = (await loadPostgresWorkspace(workspace.id)).revenue.filter(item => [a.id, b.id].includes(item.providerId!));
      assert.equal(rows.length, 1); assert.equal(rows[0].amount, 1); assert.equal(rows[0].leadId, workspace.leads[0].id);
      assert.equal((await state(issuedId(linkId))).payload.creditedPaymentId, rows[0].providerId);
    } finally { canonicalBarrier = undefined; authoritative.clear(); release(); }
  });
  await t.test("failure saving a link claim rolls back the entire financial transaction", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_ClaimRollback", 100);
    const linkId = await issue(next.payload.payment.entity), row = await state(issuedId(linkId));
    payment = next.payload.payment.entity;
    await deliver(next);
    const before = await loadPostgresWorkspace(workspace.id);
    await pg.exec("alter table event_receipts add constraint fixture_claim_failure check ((payload->>'creditedPaymentId') is distinct from 'pay_ClaimRollback')");
    try {
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.deepEqual(await state(row.id), row);
    } finally { await pg.exec("alter table event_receipts drop constraint fixture_claim_failure"); }
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
    assert.equal((await state(row.id)).payload.creditedPaymentId, payment.id);
  });
  await t.test("a consumed link with a missing ledger record cannot silently recreate credit", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_MissingCredit", 100);
    const linkId = await issue(next.payload.payment.entity), row = await state(issuedId(linkId));
    await db.update(schema.eventReceipts).set({ payload: { ...row.payload, creditedPaymentId: next.payload.payment.entity.id } }).where(eq(schema.eventReceipts.id, row.id));
    payment = next.payload.payment.entity;
    const before = await loadPostgresWorkspace(workspace.id);
    await deliver(next);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
  });
  await t.test("legacy uncredited markers are never silently backfilled from provider notes", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_LegacyUncredited", 100);
    const marker = uid(), linkId = "plink_LegacyUncredited", markerId = issuedId(marker);
    Object.assign(next.payload.payment.entity.notes, { admitflow_link_id: marker });
    const timestamp = new Date().toISOString();
    await db.insert(schema.eventReceipts).values({ id: markerId, organizationId: workspace.id, provider: "razorpay_link", receivedAt: timestamp, processedAt: timestamp,
      payload: { version: 1, leadId: workspace.leads[0].id, amountPaise: 100, currency: "INR", connectionId: workspace.connections![0].id, keyFingerprint: createHash("sha256").update(keyId).digest("hex") },
    });
    paymentLinks.set(next.payload.payment.entity.id, [linkId]);
    providerLinks.set(linkId, { id: linkId, amount: 100, amount_paid: 100, currency: "INR", accept_partial: false, status: "paid",
      notes: next.payload.payment.entity.notes, payments: [{ payment_id: next.payload.payment.entity.id, amount: 100, status: "captured" }],
    });
    payment = next.payload.payment.entity;
    const before = await loadPostgresWorkspace(workspace.id), markerBefore = await state(markerId);
    await deliver(next);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
    assert.deepEqual(await state(markerId), markerBefore); assert.equal(await state(issuedId(linkId)), undefined);
  });
  await t.test("a provider link recorded only in another tenant cannot credit this tenant", async () => {
    const other = createWorkspace(); other.demo = false;
    await createPostgresWorkspace(other, "org_other_payments");
    const next = capture(workspace.id, workspace.leads[0].id, "pay_ForeignLink", 100);
    const linkId = await issue(next.payload.payment.entity), row = await state(issuedId(linkId));
    await db.update(schema.eventReceipts).set({ id: `razorpay_link:${other.id}:${linkId}`, organizationId: other.id }).where(eq(schema.eventReceipts.id, row.id));
    payment = next.payload.payment.entity;
    const before = await loadPostgresWorkspace(workspace.id);
    await deliver(next);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
  });
  await t.test("refunds of previously credited payments remain reconcilable without a link marker", async () => {
    const legacy = capture(workspace.id, workspace.leads[0].id, "pay_LegacyCredited", 100);
    payment = legacy.payload.payment.entity;
    await mutatePostgresWorkspace(workspace.id, current => {
      current.revenue.push({
        id: uid(), leadId: workspace.leads[0].id, amount: 1, recordedAt: new Date().toISOString(),
        campaignId: null, reference: payment.id, origin: "razorpay", providerId: payment.id,
      });
    });
    const next = refund("rfnd_LegacyCredited", 20, payment.id);
    refundValue = next.payload.refund.entity;
    Object.assign(payment, { notes: null });
    const before = requestPaths.length;
    await deliver(next);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "processed");
    assert.deepEqual(requestPaths.slice(before), [`/v1/payments/${payment.id}`, `/v1/refunds/${refundValue.id}`], "legacy refunds need no link lookup or notes");
    const current = await loadPostgresWorkspace(workspace.id);
    assert.equal(current.refunds!.filter(row => row.reference === refundValue.id).length, 1);
    payment.amount = 101;
    const mismatch = refund("rfnd_LegacyMismatch", 10, payment.id); refundValue = mismatch.payload.refund.entity;
    await deliver(mismatch);
    assert.equal(await processPaymentReceipt(workspace.id, idFor(mismatch)), "pending");
    assert.deepEqual(await loadPostgresWorkspace(workspace.id), current);
  });
  await t.test("unassociated merchant payments remain held; connection changes block stale events", async () => {
    const unrelated = capture(uid(), uid(), "pay_Unrelated", 500); payment = unrelated.payload.payment.entity;
    await deliver(unrelated); assert.equal(await processPaymentReceipt(workspace.id, idFor(unrelated)), "pending");
    const changed = capture(workspace.id, workspace.leads[0].id, "pay_Changed", 500);
    await issue(changed.payload.payment.entity);
    payment = changed.payload.payment.entity;
    await deliver(changed);
    await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].status = "error"; });
    assert.equal(await processPaymentReceipt(workspace.id, idFor(changed)), "pending");
    assert.equal((await deliver(changed)).status, 503);
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === "pay_Changed"));
  });
});
