import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import { acceptPaymentEvent, recoverPaymentEvents } from "../src/lib/db/payment-inbox";
import { createPaymentLink, paymentEventReference } from "../src/lib/providers/payments";
import { createWorkspace } from "../src/lib/seed";
import { isoNow, uid } from "../src/lib/domain";
import { sealSecret } from "../src/lib/secrets";
import * as schema from "../src/lib/db/schema";

test("restricted runtime recovery pages empty/failing tenants, wraps capped backlogs and respects leases", { timeout: 120_000 }, async t => {
  const env = { DATABASE_URL: "postgresql://injected-pglite-only", INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"), KMS_KEY_ID: "" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const pg = new PGlite(); t.after(() => pg.close());
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
  const keyId = "rzp_test_RecoveryAccount123";
  const tenants: ReturnType<typeof createWorkspace>[] = [];
  const authoritative = new Map<string, Record<string, unknown>>();
  const requests: string[] = [];
  let links = 0;
  const providerLinks = new Map<string, Record<string, unknown>>(), paymentLinks = new Map<string, string>();
  t.mock.method(globalThis, "fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      assert.equal(String(url), "https://api.razorpay.com/v1/payment_links");
      const body = JSON.parse(String(init.body));
      assert.equal(body.accept_partial, false);
      return Response.json({ id: `plink_Recovery${++links}`, short_url: `https://rzp.io/i/recovery${links}`, amount: body.amount, currency: body.currency, accept_partial: false });
    }
    assert.equal(init?.method, "GET");
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/payment_links") {
      assert.ok(paymentLinks.has(parsed.searchParams.get("payment_id")!));
      return Response.json({ payment_links: [{ id: paymentLinks.get(parsed.searchParams.get("payment_id")!) }] });
    }
    if (parsed.pathname.startsWith("/v1/payment_links/")) {
      const id = parsed.pathname.split("/").at(-1)!;
      assert.ok(providerLinks.has(id));
      return Response.json(providerLinks.get(id));
    }
    const paymentId = String(url).split("/").at(-1)!;
    assert.ok(authoritative.has(paymentId), "Only fixture provider reads are allowed"); requests.push(paymentId);
    return Response.json(authoritative.get(paymentId));
  });
  for (let index = 1; index <= 6; index++) {
    const workspace = createWorkspace(); workspace.id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    workspace.demo = false; workspace.revenue = []; workspace.refunds = [];
    workspace.connections = [{ id: uid(), service: "razorpay", externalId: workspace.id, label: "Fixture", status: "connected", updatedAt: isoNow(), metadata: {}, secret: await sealSecret({ keyId, keySecret: "fixture-payment-api-key-secret" }, workspace.id) }];
    await createPostgresWorkspace(workspace, `org_recovery_${index}`); tenants.push(workspace);
  }
  async function receipt(tenant: number, suffix: string, lease?: "expired" | "active") {
    const workspace = tenants[tenant], paymentId = `pay_${suffix}`;
    const entity = { id: paymentId, amount: 100, currency: "INR", status: "captured", captured: true, notes: null };
    const link = await createPaymentLink(workspace, workspace.leads[0].id, 1);
    paymentLinks.set(paymentId, link.id);
    providerLinks.set(link.id, { id: link.id, amount: 100, amount_paid: 100, currency: "INR", accept_partial: false, status: "paid",
      payments: [{ payment_id: paymentId, plink_id: link.id, amount: 100, status: "captured" }],
    });
    const event = { event: "payment.captured", payload: { payment: { entity } } }, body = JSON.stringify(event);
    authoritative.set(paymentId, entity);
    await acceptPaymentEvent(workspace.id, paymentEventReference(event)!, body, workspace.connections![0], keyId);
    const id = `razorpay_admission:${workspace.id}:${createHash("sha256").update(body).digest("hex")}`;
    await tenantTransaction(workspace.id, async tx => {
      const [row] = await tx.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, id));
      await tx.update(schema.eventReceipts).set({ payload: { ...row.payload, nextAttemptAt: lease === "active" ? "9999-01-01T00:00:00.000Z" : "2000-01-01T00:00:00.000Z", ...(lease ? { status: "processing", attempts: 1, claim: uid() } : {}) } }).where(eq(schema.eventReceipts.id, id));
    });
    return id;
  }
  const errored = await receipt(1, "Error");
  const backlog = [await receipt(2, "BacklogA"), await receipt(2, "BacklogB"), await receipt(2, "BacklogC")];
  const expired = await receipt(3, "Expired", "expired"), active = await receipt(4, "Active", "active"), last = await receipt(5, "Last");
  const activeBefore = (await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, active)))[0];
  await pg.exec(`CREATE FUNCTION payment_recovery_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.organization_id = '${tenants[1].id}'::uuid THEN RAISE EXCEPTION 'Fixture tenant database outage'; END IF;
    RETURN NEW; END; $$;
    CREATE TRIGGER payment_recovery_fixture_failure BEFORE UPDATE ON event_receipts FOR EACH ROW EXECUTE FUNCTION payment_recovery_fixture_failure();
    CREATE ROLE payment_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO payment_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO payment_runtime;
    SET ROLE payment_runtime;`);
  assert.equal((await db.select().from(schema.eventReceipts)).length, 0, "global runtime receipt scans must be empty");
  const first = await recoverPaymentEvents(undefined, 2, 2);
  assert.deepEqual(first, { tenants: 2, tenantFailures: 1, selected: 1, processed: 0, ignored: 0, pending: 0, failed: 0, skipped: 0, after: tenants[1].id });
  const second = await recoverPaymentEvents(first.after, 2, 2);
  assert.deepEqual(second, { tenants: 2, tenantFailures: 0, selected: 3, processed: 3, ignored: 0, pending: 0, failed: 0, skipped: 0, after: tenants[3].id });
  const third = await recoverPaymentEvents(second.after, 2, 2);
  assert.equal(third.selected, 1); assert.equal(third.processed, 1); assert.equal(third.after, tenants[5].id);
  const end = await recoverPaymentEvents(third.after, 2, 2);
  assert.equal(end.tenants, 0); assert.equal(end.selected, 0); assert.equal(end.after, undefined);
  assert.equal(requests.length, 4); assert.ok(!requests.includes("pay_Active") && !requests.includes("pay_Error"));
  const state = async (tenant: number, id: string) => (await tenantTransaction(tenants[tenant].id, tx => tx.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.id, id))))[0];
  assert.equal((await state(3, expired)).payload.attempts, 2);
  assert.ok((await state(5, last)).processedAt);
  assert.equal((await loadPostgresWorkspace(tenants[2].id)).revenue.length, 2);
  assert.deepEqual(await state(4, active), activeBefore);
  await pg.exec("RESET ROLE; DROP TRIGGER payment_recovery_fixture_failure ON event_receipts; SET ROLE payment_runtime;");
  let after: string | undefined = end.after, processed = 0;
  do {
    const result = await recoverPaymentEvents(after, 2, 2); after = result.after; processed += result.processed;
    assert.equal(result.tenantFailures, 0);
  } while (after !== undefined);
  assert.equal(processed, 2, "wraparound recovers the failed tenant and the remainder of a capped backlog");
  assert.ok((await state(1, errored)).processedAt);
  for (const id of backlog) assert.ok((await state(2, id)).processedAt);
  assert.equal((await loadPostgresWorkspace(tenants[2].id)).revenue.length, 3);
  assert.equal(new Set(requests).size, requests.length, "completed receipts must not replay provider reads");
  assert.equal((await recoverPaymentEvents(undefined, 20, 2)).selected, 0);
  assert.deepEqual(await state(4, active), activeBefore);
  for (const limit of [0, -1, 1.5, 21]) await assert.rejects(recoverPaymentEvents(undefined, limit, 2));
  for (const limit of [0, -1, 1.5, 101]) await assert.rejects(recoverPaymentEvents(undefined, 2, limit));
  await assert.rejects(recoverPaymentEvents("invalid", 2, 2));
  await pg.exec("RESET ROLE;");
});
