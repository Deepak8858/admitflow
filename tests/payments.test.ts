import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { applyPaymentEvent, createPaymentLink, paymentEventReference } from "../src/lib/providers/payments";
import { acceptPaymentEvent, inspectPaymentEvents, processPaymentReceipt, recoverPaymentEvents, retryPaymentEvent, PAYMENT_MAX_ATTEMPTS } from "../src/lib/db/payment-inbox";
import { KMSClient } from "@aws-sdk/client-kms";
import { POST } from "../src/app/api/webhooks/razorpay/[workspaceId]/route";
import { createWorkspace } from "../src/lib/seed";
import { uid } from "../src/lib/domain";
import { sealSecret } from "../src/lib/secrets";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace } from "../src/lib/db/repository";
import * as schema from "../src/lib/db/schema";

const capture = (workspaceId: string, leadId: string, id = "pay_Test", amount = 30) => ({ event: "payment.captured", payload: { payment: { entity: { id, amount, currency: "INR", status: "captured", captured: true, notes: { admitflow_workspace_id: workspaceId, admitflow_lead_id: leadId } } } } });
const refund = (id = "rfnd_Test", amount = 10, paymentId = "pay_Test") => ({ event: "refund.processed", payload: { refund: { entity: { id, payment_id: paymentId, amount, currency: "INR", status: "processed" } } } });

test("payment amounts are integer paise; partial-to-full refunds and conflicting duplicates are correct", () => {
  const workspace = createWorkspace(); workspace.revenue = []; workspace.refunds = [];
  const event = capture(workspace.id, workspace.leads[0].id);
  assert.throws(() => applyPaymentEvent(workspace, refund()), /before its refund/);
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
  for (const patch of [{ id: "../pay_Test" }, { status: "pending" }, { currency: "USD" }, { captured: false }]) {
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
  let beforeResponse: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    requests++; assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    const hook = beforeResponse; beforeResponse = undefined;
    await hook?.();
    if (outage) throw new Error("sensitive provider exception must not be stored");
    if (String(input).includes("/refunds/")) return Response.json(refundValue);
    assert.ok(String(input).startsWith("https://api.razorpay.com/v1/payments/"));
    return Response.json(payment);
  });
  t.mock.method(console, "error", () => undefined);
  const rawFor = (value: unknown) => JSON.stringify(value);
  const idFor = (value: unknown) => `razorpay_admission:${workspace.id}:${createHash("sha256").update(rawFor(value)).digest("hex")}`;
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
  await t.test("refund before capture is durable before acknowledgement and reconstructs the payment", async () => {
    const first = refund();
    assert.equal((await deliver(first)).status, 200); assert.equal(requests, 0);
    const saved = await state(idFor(first)); assert.ok(saved && !saved.processedAt);
    assert.ok(!JSON.stringify(saved.payload).includes("notes")); assert.ok(!JSON.stringify(saved.payload).includes(webhookSecret));
    payment = { ...payment, status: "refunded", captured: true };
    assert.equal(await processPaymentReceipt(workspace.id, idFor(first)), "processed");
    let current = await loadPostgresWorkspace(workspace.id); assert.equal(current.revenue.length, 1); assert.equal(current.refunds!.length, 1);
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
    payment = next.payload.payment.entity;
    await Promise.all([deliver(next), deliver(next)]);
    const result = await Promise.all([processPaymentReceipt(workspace.id, idFor(next)), processPaymentReceipt(workspace.id, idFor(next))]);
    assert.equal(result.filter(value => value === "processed").length, 1);
    assert.equal((await loadPostgresWorkspace(workspace.id)).revenue.filter(row => row.providerId === "pay_Concurrent").length, 1);
    const wrong = capture(workspace.id, workspace.leads[2].id, "pay_Wrong", 100);
    await deliver(wrong); assert.equal(await processPaymentReceipt(workspace.id, idFor(wrong)), "pending");
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === "pay_Wrong"));
  });
  await t.test("a failed durable insert returns retryable failure without acknowledging or fetching", async () => {
    const next = capture(workspace.id, workspace.leads[0].id, "pay_IntakeFailure", 100);
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
    const next = refund("rfnd_Rollback", 40, payment.id); refundValue = next.payload.refund.entity;
    await deliver(next);
    const before = await loadPostgresWorkspace(workspace.id);
    await pg.exec("alter table refunds add constraint fixture_refund_failure check (reference <> 'rfnd_Rollback')");
    try {
      assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
      assert.deepEqual(await loadPostgresWorkspace(workspace.id), before);
      assert.equal((await state(idFor(next))).processedAt, null);
    } finally { await pg.exec("alter table refunds drop constraint fixture_refund_failure"); }
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
    const current = await loadPostgresWorkspace(workspace.id);
    assert.equal(current.revenue.filter(row => row.providerId === payment.id).length, 1);
    assert.equal(current.refunds!.filter(row => row.reference === refundValue.id).length, 1);
  });
  await t.test("a replaced claim cannot be completed or failed by an older worker", async () => {
    for (const fails of [false, true]) {
      const next = capture(workspace.id, workspace.leads[0].id, fails ? "pay_StaleFailure" : "pay_StaleSuccess", 100);
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
    payment = next.payload.payment.entity; await deliver(next);
    const rotated = await sealSecret({ keyId, keySecret: "fixture-rotated-api-key-secret", webhookSecret }, workspace.id);
    beforeResponse = async () => { await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].secret = rotated; }); };
    assert.equal(await processPaymentReceipt(workspace.id, idFor(next)), "pending");
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === payment.id));
    // Same key ID can recover with fresh credentials; changing the key ID above cannot.
    assert.equal(await retryPaymentEvent(workspace.id, idFor(next)), "processed");
  });
  await t.test("unrelated merchant payments are ignored; connection changes block stale events", async () => {
    const unrelated = capture(uid(), uid(), "pay_Unrelated", 500); payment = unrelated.payload.payment.entity;
    await deliver(unrelated); assert.equal(await processPaymentReceipt(workspace.id, idFor(unrelated)), "ignored");
    const changed = capture(workspace.id, workspace.leads[0].id, "pay_Changed", 500); payment = changed.payload.payment.entity;
    await deliver(changed);
    await mutatePostgresWorkspace(workspace.id, current => { current.connections![0].status = "error"; });
    assert.equal(await processPaymentReceipt(workspace.id, idFor(changed)), "pending");
    assert.equal((await deliver(changed)).status, 503);
    assert.ok(!(await loadPostgresWorkspace(workspace.id)).revenue.some(row => row.providerId === "pay_Changed"));
  });
});
