import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { useTestDatabase, closeDatabase, type Database } from "../src/lib/db/client";
import { createWorkspace } from "../src/lib/seed";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import { TRIAL_MS, BILLING_FRESH_MS, subscriptionCapabilities, actionCapability, SubscriptionRestricted } from "../src/lib/subscription-policy";
import { requirePaidCapability, assertWorkspaceCapability } from "../src/lib/subscription-access";
import { projectBillingSubscription, refreshBillingAccess } from "../src/lib/providers/billing";
import { apiError } from "../src/lib/api";
import { AppError } from "../src/lib/errors";
import type { Subscription } from "../src/lib/domain";

const now = Date.parse("2026-09-18T12:00:00Z");
const trial = { startedAt: new Date(now).toISOString(), endsAt: new Date(now + TRIAL_MS).toISOString(), consumed: false };
const base = { demo: false, subscription: { status: "trial", plan: "Pilot" } as Subscription, trial };

test("seven-day trial has an exclusive end, cannot reset through checkout, and rejects missing/invalid grants", () => {
  assert.equal(subscriptionCapabilities(base, true, now).allowed, true);
  assert.equal(subscriptionCapabilities(base, true, now + TRIAL_MS - 1).allowed, true);
  assert.equal(subscriptionCapabilities(base, true, now + TRIAL_MS).reason, "trial_expired");
  for (const bad of [undefined, { ...trial, consumed: true }, { ...trial, endsAt: "invalid" }, { ...trial, endsAt: new Date(now + TRIAL_MS + 1).toISOString() }]) assert.equal(subscriptionCapabilities({ ...base, trial: bad }, true, now).allowed, false);
  assert.equal(subscriptionCapabilities(base, true, now - 1).allowed, false);
  for (const providerStatus of ["created", "authenticated"] as const) assert.equal(subscriptionCapabilities({ ...base, subscription: { ...base.subscription, providerId: "sub_test", providerStatus } }, true, now + TRIAL_MS).allowed, false);
  assert.equal(subscriptionCapabilities({ demo: true }, true, now).allowed, true);
  assert.equal(subscriptionCapabilities({ demo: false }, false, now).allowed, true);
});

test("paid coverage is bounded by freshness and current_end, never charge_at; known restrictions have no grace", () => {
  const subscription = projectBillingSubscription(undefined, { id: "sub_test", plan_id: "plan_test", status: "active", notes: {}, current_end: Math.floor((now + 120_000) / 1000), charge_at: Math.floor((now + TRIAL_MS) / 1000) }, "Paid");
  subscription.verifiedAt = new Date(now).toISOString();
  const workspace = { ...base, subscription };
  assert.equal(subscriptionCapabilities(workspace, true, now).allowed, true);
  assert.equal(subscriptionCapabilities(workspace, true, now + 120_000).allowed, false);
  assert.equal(subscriptionCapabilities({ ...workspace, subscription: { ...subscription, currentPeriodEnd: new Date(now + TRIAL_MS).toISOString() } }, true, now + BILLING_FRESH_MS).allowed, false);
  assert.equal(subscriptionCapabilities({ ...workspace, subscription: { ...subscription, verifiedAt: undefined } }, true, now).allowed, false);
  assert.equal(subscriptionCapabilities({ ...workspace, subscription: { ...subscription, currentPeriodEnd: undefined } }, true, now).allowed, false);
  for (const status of ["past_due", "cancelled"] as const) assert.equal(subscriptionCapabilities({ ...base, subscription: { ...subscription, status } }, true, now).allowed, false);
  const late = projectBillingSubscription(subscription, { id: "sub_test", plan_id: "plan_test", status: "created", notes: {} }, "Paid");
  assert.equal(late.verifiedAt, subscription.verifiedAt, "stale checkout cannot extend verification");
});

test("safety changes stay available while paid actions are classified and coded errors stay distinct", async () => {
  const workspace = createWorkspace(false);
  for (const type of ["lead.create", "lead.import", "message.suggest", "message.send", "campaign.create"]) assert.ok(actionCapability(workspace, { type }));
  for (const action of [{ type: "ai.save", settings: { mode: "paused" } }, { type: "sequence.save", enabled: false }, { type: "lead.update", changes: { humanOwned: true } }, { type: "lead.update", changes: { consent: "opted_out" } }, { type: "message.note" }, { type: "appointment.status" }]) assert.equal(actionCapability(workspace, action), undefined);
  assert.equal((await apiError(new AppError("Choose institute", 409, "ORGANIZATION_REQUIRED")).json()).code, "ORGANIZATION_REQUIRED");
  assert.equal((await apiError(new AppError("Access busy", 409)).json()).code, undefined);
  assert.equal(apiError(new SubscriptionRestricted(subscriptionCapabilities(base, true, now + TRIAL_MS))).status, 402);
});

test("subscription snapshots form an additive chain without modeled schema drift", async () => {
  const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
  const five = JSON.parse(await readFile("drizzle/meta/0005_snapshot.json", "utf8"));
  const six = JSON.parse(await readFile("drizzle/meta/0006_snapshot.json", "utf8"));
  const seven = JSON.parse(await readFile("drizzle/meta/0007_snapshot.json", "utf8"));
  assert.equal(six.prevId, five.id); assert.equal(seven.prevId, six.id);
  assert.deepEqual(Object.keys(six.tables).filter(name => !five.tables[name]), ["public.institute_trials"]);
  assert.deepEqual(Object.keys(seven.tables).filter(name => !six.tables[name]), ["public.intake_inbox"]);
  for (const [name, table] of Object.entries(five.tables)) assert.deepEqual(six.tables[name], table);
  for (const [name, table] of Object.entries(six.tables)) assert.deepEqual(seven.tables[name], table);
  const eight = JSON.parse(await readFile("drizzle/meta/0008_snapshot.json", "utf8"));
  const nine = JSON.parse(await readFile("drizzle/meta/0009_snapshot.json", "utf8"));
  assert.equal(eight.prevId, seven.id); assert.equal(nine.prevId, eight.id);
  assert.deepEqual(Object.keys(eight.tables).filter(name => !seven.tables[name]), ["public.organization_provisioning"]);
  for (const [name, table] of Object.entries(seven.tables)) assert.deepEqual(eight.tables[name], table);
  assert.deepEqual(Object.keys(nine.tables), Object.keys(eight.tables));
  for (const [name, table] of Object.entries(eight.tables)) {
    if (!["public.connections", "public.intake_inbox"].includes(name)) assert.deepEqual(nine.tables[name], table);
  }
  const ten = JSON.parse(await readFile("drizzle/meta/0010_snapshot.json", "utf8"));
  assert.equal(ten.prevId, nine.id);
  assert.deepEqual(Object.keys(ten.tables), Object.keys(nine.tables));
  let latest = ten;
  for (const file of (await readdir("drizzle/meta")).filter(file => /^\d{4}_snapshot\.json$/.test(file) && file > "0010_snapshot.json").sort()) {
    const snapshot = JSON.parse(await readFile(`drizzle/meta/${file}`, "utf8"));
    assert.equal(snapshot.prevId, latest.id, `${file} must extend the previous snapshot`);
    latest = snapshot;
  }
  assert.deepEqual(await generateMigration(latest, generateDrizzleJson(schema, latest.id)), []);
  // RLS, immutable-ledger triggers and custom SQL checks are migration-owned, as in prior snapshots.
  // Their behavior is exercised separately against all SQL migrations in PGlite.
});

test("hosted trial survives persistence, concurrent provisioning, deletion and verified subscription replacement", async t => {
  const pg = new PGlite(), oldUrl = process.env.DATABASE_URL, oldFetch = globalThis.fetch;
  const oldKey = process.env.BILLING_RAZORPAY_KEY_ID, oldSecret = process.env.BILLING_RAZORPAY_KEY_SECRET;
  try {
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    process.env.DATABASE_URL = "postgresql://injected-pglite-only";
    const workspace = createWorkspace(false);
    await createPostgresWorkspace(workspace, "org_trial");
    const loaded = await loadPostgresWorkspace(workspace.id);
    assert.equal(Date.parse(loaded.trial!.endsAt!) - Date.parse(loaded.trial!.startedAt!), TRIAL_MS);
    await requirePaidCapability(workspace.id);
    await t.test("aggregate writes cannot reset the ledger", async () => {
      await mutatePostgresWorkspace(workspace.id, current => { current.trial = { ...trial }; });
      assert.deepEqual((await loadPostgresWorkspace(workspace.id)).trial, loaded.trial);
      await assert.rejects(() => db.update(schema.instituteTrials).set({ endsAt: new Date(Date.parse(loaded.trial!.endsAt!) + 1000).toISOString() }).where(eq(schema.instituteTrials.workosId, "org_trial")));
      await assert.rejects(() => db.delete(schema.instituteTrials).where(eq(schema.instituteTrials.workosId, "org_trial")));
    });
    await t.test("one organization cannot acquire concurrent new grants", async () => {
      const a = createWorkspace(false), b = createWorkspace(false);
      const result = await Promise.allSettled([createPostgresWorkspace(a, "org_race"), createPostgresWorkspace(b, "org_race")]);
      assert.equal(result.filter(item => item.status === "fulfilled").length, 1);
      assert.equal((await db.select().from(schema.instituteTrials).where(eq(schema.instituteTrials.workosId, "org_race"))).length, 1);
    });
    await t.test("same identity reuses its original deadline after deletion", async () => {
      await tenantTransaction(workspace.id, tx => tx.delete(schema.organizations).where(eq(schema.organizations.id, workspace.id)));
      const recreated = createWorkspace(false); await createPostgresWorkspace(recreated, "org_trial");
      assert.deepEqual((await loadPostgresWorkspace(recreated.id)).trial, loaded.trial);
    });
    await t.test("authoritative refresh consumes trial, bounds reads, and fails closed on outage", async () => {
      const paid = createWorkspace(false); await createPostgresWorkspace(paid, "org_paid");
      await mutatePostgresWorkspace(paid.id, current => { current.subscription = { status: "active", plan: "Paid", providerId: "sub_paid" }; });
      process.env.BILLING_RAZORPAY_KEY_ID = "test-only"; process.env.BILLING_RAZORPAY_KEY_SECRET = "test-only";
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json({ id: "sub_paid", plan_id: "plan_paid", status: "active", current_end: Math.floor(Date.now() / 1000) + 3600, notes: { admitflow_product: "admitflow_saas", admitflow_workspace_id: paid.id } }); };
      await requirePaidCapability(paid.id); await requirePaidCapability(paid.id);
      assert.equal(calls, 1);
      assert.equal((await loadPostgresWorkspace(paid.id)).trial?.consumed, true);
      await mutatePostgresWorkspace(paid.id, current => { current.subscription!.verifiedAt = new Date(Date.now() - BILLING_FRESH_MS).toISOString(); });
      globalThis.fetch = async () => { throw new TypeError("Mock outage"); };
      await assert.rejects(() => refreshBillingAccess(paid.id));
      assert.throws(() => assertWorkspaceCapability({ ...(base), subscription: { status: "active", plan: "Paid", providerId: "sub_paid" } }));
      await mutatePostgresWorkspace(paid.id, current => { current.subscription = { status: "trial", plan: "Replacement", providerId: "sub_new", providerStatus: "created", verifiedAt: new Date().toISOString() }; });
      await assert.rejects(() => requirePaidCapability(paid.id), SubscriptionRestricted);
    });
  } finally {
    globalThis.fetch = oldFetch; await closeDatabase(); await pg.close();
    for (const [key, value] of Object.entries({ DATABASE_URL: oldUrl, BILLING_RAZORPAY_KEY_ID: oldKey, BILLING_RAZORPAY_KEY_SECRET: oldSecret })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
