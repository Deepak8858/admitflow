import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { closeDatabase, useTestDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace, queryPostgresLeads, tenantTransaction } from "../src/lib/db/repository";
import { acceptIntake, intakeSummary, importIntake, storedMetaIntake } from "../src/lib/db/intake";
import { cleanIntakeRetention, inspectIntakeRetention, sweepIntakeRetention } from "../src/lib/db/intake-retention";
import { intakeContactIdentity, intakeContactKeys, intakeExpiry, intakeHeldPhones, INTAKE_MAX_AGE_MS, INTAKE_IMPORTED_AGE_MS } from "../src/lib/intake-retention-policy";
import { createWorkspace } from "../src/lib/seed";
import { uid, isoNow, replyBlock, type Workspace } from "../src/lib/domain";
import { intakePayloadSchema, type IntakePayload } from "../src/lib/intake-types";

const key = Buffer.alloc(32, 17).toString("base64"), nextKey = Buffer.alloc(32, 18).toString("base64");
const migrations = async () => (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort();
test("retention policy uses elapsed deadlines and tenant-scoped rotating keys", () => {
  const previous = process.env.INTAKE_CONTACT_KEYS;
  try {
    process.env.INTAKE_CONTACT_KEYS = JSON.stringify([key]);
    const received = "2026-03-01T00:00:00.000Z";
    assert.equal(Date.parse(intakeExpiry(received)) - Date.parse(received), INTAKE_MAX_AGE_MS);
    assert.equal(intakeExpiry(received, "2026-03-29T00:00:00.000Z"), "2026-03-31T00:00:00.000Z");
    const first = intakeContactIdentity("tenant-a", "+919876543210");
    assert.notEqual(first.contactKey, intakeContactIdentity("tenant-b", "+919876543210").contactKey);
    process.env.INTAKE_CONTACT_KEYS = JSON.stringify([nextKey, key]);
    assert.notEqual(first.contactKey, intakeContactIdentity("tenant-a", "+919876543210").contactKey);
    assert.deepEqual([...intakeHeldPhones("tenant-a", ["+919876543210"], [first])], ["+919876543210"]);
    process.env.INTAKE_CONTACT_KEYS = JSON.stringify([nextKey]);
    assert.throws(() => intakeHeldPhones("tenant-a", [], [first]), /unavailable/);
    for (const value of ["", "null", "[]", JSON.stringify([key, key]), JSON.stringify(["bad"])]) assert.throws(() => intakeContactKeys({ INTAKE_CONTACT_KEYS: value }));
  } finally { if (previous === undefined) delete process.env.INTAKE_CONTACT_KEYS; else process.env.INTAKE_CONTACT_KEYS = previous; }
});

test("retention upgrade backfills populated receipts without erasing identity or changing age", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await migrations()).filter(file => file < "0011")) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const workspace = createWorkspace(false), db = drizzle(pg, { schema }), connectionId = uid();
    await db.insert(schema.organizations).values({ id: workspace.id, name: "Legacy", ownerName: "Owner", sequence: workspace.sequence, ai: workspace.ai!, subscription: workspace.subscription! });
    await db.insert(schema.connections).values({ id: connectionId, organizationId: workspace.id, service: "whatsapp", status: "connected", externalId: "991", label: "Legacy", metadata: {}, updatedAt: isoNow() });
    const receivedAt = new Date(Date.now() - INTAKE_MAX_AGE_MS - 1).toISOString();
    const raw = JSON.stringify({ service: "whatsapp", event: { id: "old", from: "919876543210", body: "STOP", verified: true } });
    await pg.query("insert into intake_inbox (id, organization_id, connection_id, service, external_id, contact_key, received_at, state, payload) values ('legacy', $1, $2, 'whatsapp', '991', '+919876543210', $3, 'deferred', $4::jsonb)", [workspace.id, connectionId, receivedAt, raw]);
    await pg.exec(await readFile("drizzle/0011_intake_retention.sql", "utf8"));
    useTestDatabase(db as unknown as Database);
    const [before] = await db.select().from(schema.intakeInbox);
    assert.match(before.payloadDigest, /^[a-f0-9]{64}$/); assert.equal(before.receivedAt, receivedAt);
    assert.equal(before.expiresAt, intakeExpiry(receivedAt)); assert.equal(before.contactKeyVersion, ""); assert.ok(before.payload);
    const oldKeys = process.env.INTAKE_CONTACT_KEYS; process.env.INTAKE_CONTACT_KEYS = JSON.stringify([key]);
    try {
      const result = await cleanIntakeRetention(workspace.id);
      assert.equal(result.redacted, 1); assert.equal(result.rekeyed, 1);
      const [after] = await db.select().from(schema.intakeInbox);
      assert.equal(after.payload, null); assert.equal(after.state, "expired"); assert.equal(after.payloadDigest, before.payloadDigest);
      assert.equal(after.receivedAt, before.receivedAt); assert.notEqual(after.contactKey, before.contactKey);
      assert.deepEqual(intakeHeldPhones(workspace.id, [before.contactKey], [after]), new Set([before.contactKey]));
    } finally { if (oldKeys === undefined) delete process.env.INTAKE_CONTACT_KEYS; else process.env.INTAKE_CONTACT_KEYS = oldKeys; }
  } finally { await closeDatabase(); await pg.close(); }
});

test("raw intake expiry preserves deduplication and safety without provider calls", { timeout: 120000 }, async t => {
  const env = { DATABASE_URL: "postgresql://injected-pglite-only", APP_BASE_URL: "", BILLING_PLANS_JSON: "", INTAKE_CONTACT_KEYS: JSON.stringify([key]) };
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]])); Object.assign(process.env, env);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  const pg = new PGlite();
  try {
    for (const file of await migrations()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    // Pause after a real query resolves, before hydration/persistence resumes. No wall-clock sleeps.
    let afterQuery: ((query: string) => Promise<void>) | undefined;
    const transaction = pg.transaction.bind(pg);
    t.mock.method(pg, "transaction", (action: Parameters<typeof pg.transaction>[0]) => transaction(async client => {
      const query = client.query.bind(client);
      t.mock.method(client, "query", async (...args: Parameters<typeof client.query>) => {
        const result = await query(...args);
        await afterQuery?.(args[0]);
        return result;
      });
      return action(client);
    }));
    let index = 0;
    async function fixture() {
      const workspace = createWorkspace(false), suffix = ++index;
      workspace.members = [{ id: `om_retention${suffix}`, workosId: `user_retention${suffix}`, name: "Owner", email: "owner@example.invalid", role: "owner", status: "active" }];
      workspace.connections = [{ id: uid(), service: "whatsapp", status: "connected", externalId: `${9000 + suffix}`, label: "Phone", metadata: { wabaId: "100" }, updatedAt: isoNow() }];
      await createPostgresWorkspace(workspace, `org_retention${suffix}`);
      const actor: NonNullable<Workspace["actor"]> = { id: workspace.members[0].workosId!, memberId: workspace.members[0].id, name: "Owner", email: "owner@example.invalid", role: "owner", backend: "workos" };
      const accept = (id: string, body = "Hello", from = "919876543210") => acceptIntake(workspace.id, workspace.connections![0].id, workspace.connections![0].externalId, { service: "whatsapp", event: { id, body, from, verified: true } });
      const restrict = () => mutatePostgresWorkspace(workspace.id, current => { current.subscription = { status: "cancelled", plan: "Ended" }; });
      const restore = () => mutatePostgresWorkspace(workspace.id, current => { current.subscription = { status: "active", plan: "Paid", providerId: `sub_${suffix}`, providerPlanId: "plan_test", providerStatus: "active", verifiedAt: isoNow(), currentPeriodEnd: new Date(Date.now() + 3600000).toISOString() }; });
      const rows = () => tenantTransaction(workspace.id, tx => tx.select().from(schema.intakeInbox).where(eq(schema.intakeInbox.organizationId, workspace.id)));
      const expire = () => tenantTransaction(workspace.id, tx => tx.update(schema.intakeInbox).set({ expiresAt: new Date(Date.now() - 1).toISOString() }).where(eq(schema.intakeInbox.organizationId, workspace.id)));
      return { workspace, actor, accept, restrict, restore, rows, expire };
    }
    const hydrationRead = (query: string) => query.startsWith("select") && query.includes('from "leads"');
    const importPage = (query: string) => query.startsWith("select") && query.includes('from "intake_inbox"') && query.includes("limit");
    const evidence = (row: typeof schema.intakeInbox.$inferSelect) => ({ id: row.id, connectionId: row.connectionId, externalId: row.externalId, receivedAt: row.receivedAt, expiresAt: row.expiresAt, payloadDigest: row.payloadDigest, contactKey: row.contactKey, contactKeyVersion: row.contactKeyVersion });
    async function emptyCrm(workspaceId: string) {
      const workspace = await loadPostgresWorkspace(workspaceId);
      assert.equal(workspace.leads.length, 0); assert.equal(workspace.messages.length, 0); assert.equal(workspace.jobs.length, 0);
      return workspace;
    }
    for (const phase of ["hydration", "persistence", "receipt-write"] as const) {
      await t.test(`acceptance crossing ${phase} records only an expired receipt with the original hold`, async c => {
        const f = await fixture(), start = Date.now(), deadline = start + 1000;
        const receivedAt = new Date(deadline - INTAKE_MAX_AGE_MS).toISOString();
        c.mock.timers.enable({ apis: ["Date"], now: start });
        let crossed = false;
        afterQuery = async query => {
          const hit = phase === "hydration" ? hydrationRead(query) : phase === "persistence" ? query.startsWith('insert into "leads"') : query.startsWith('insert into "intake_inbox"');
          if (!crossed && hit) { crossed = true; await Promise.resolve(); c.mock.timers.setTime(deadline); }
        };
        try {
          const payload: IntakePayload = { service: "whatsapp", event: { id: `late-${phase}`, body: "Private expired enquiry", from: "919876543210", verified: true } };
          const result = await acceptIntake(f.workspace.id, f.workspace.connections![0].id, f.workspace.connections![0].externalId, payload, receivedAt);
          afterQuery = undefined;
          assert.equal(crossed, true); assert.deepEqual(result.result, { duplicate: false, deferred: true, expired: true });
          assert.equal(result.workspace.leads.length, 0); await emptyCrm(f.workspace.id);
          const [row] = await f.rows();
          assert.equal(row.receivedAt, receivedAt); assert.equal(row.expiresAt, new Date(deadline).toISOString());
          assert.equal(row.state, "expired"); assert.equal(row.payload, null); assert.equal(row.processedAt, null); assert.equal(row.redactedAt, isoNow());
          assert.deepEqual(intakeHeldPhones(f.workspace.id, ["+919876543210"], [row]), new Set(["+919876543210"]));
          assert.equal((await acceptIntake(f.workspace.id, row.connectionId, row.externalId, payload)).result.duplicate, true);
          await assert.rejects(() => acceptIntake(f.workspace.id, row.connectionId, row.externalId, { ...payload, event: { ...payload.event, body: "Changed" } }), /different payload/);
          assert.deepEqual(await f.rows(), [row]); assert.equal((await cleanIntakeRetention(f.workspace.id)).redacted, 0);
          assert.equal((await f.accept("held-after-expiry")).result.deferred, true); await emptyCrm(f.workspace.id);
        } finally { afterQuery = undefined; c.mock.timers.reset(); }
      });
    }
    await t.test("acceptance processedAt follows delayed hydration rather than pre-read time", async c => {
      const f = await fixture(), start = Date.now(); c.mock.timers.enable({ apis: ["Date"], now: start });
      afterQuery = async query => { if (hydrationRead(query)) { afterQuery = undefined; c.mock.timers.setTime(start + 1000); } };
      try {
        await f.accept("delayed-live"); const [row] = await f.rows();
        assert.equal(row.receivedAt, new Date(start).toISOString()); assert.equal(row.processedAt, new Date(start + 1000).toISOString());
        assert.equal(row.expiresAt, intakeExpiry(row.receivedAt, row.processedAt));
      } finally { afterQuery = undefined; c.mock.timers.reset(); }
    });
    for (const phase of ["hydration", "persistence", "receipt-write"] as const) {
      await t.test(`import crossing ${phase} leaves no imported CRM payload and preserves expiry evidence`, async c => {
        const f = await fixture(); await f.restrict(); await f.accept(`import-${phase}`, "STOP"); await f.restore();
        const start = Date.now(), deadline = start + 1000;
        await tenantTransaction(f.workspace.id, tx => tx.update(schema.intakeInbox).set({ expiresAt: new Date(deadline).toISOString() }).where(eq(schema.intakeInbox.organizationId, f.workspace.id)));
        const [before] = await f.rows(); c.mock.timers.enable({ apis: ["Date"], now: start });
        let selected = false, crossed = false;
        afterQuery = async query => {
          if (importPage(query)) selected = true;
          const hit = phase === "hydration" ? hydrationRead(query) : phase === "persistence" ? query.startsWith('insert into "leads"') : query.startsWith('update "intake_inbox"');
          if (selected && !crossed && hit) { crossed = true; await Promise.resolve(); c.mock.timers.setTime(deadline); }
        };
        try {
          if (phase === "hydration") assert.equal((await importIntake(f.workspace.id, f.actor)).result.imported, 0);
          else await assert.rejects(() => importIntake(f.workspace.id, f.actor), /Intake expired during processing/);
          afterQuery = undefined; assert.equal(crossed, true); await emptyCrm(f.workspace.id);
          const [row] = await f.rows(); assert.deepEqual(evidence(row), evidence(before));
          assert.equal(row.state, "expired"); assert.equal(row.payload, null); assert.equal(row.processedAt, null); assert.equal(row.redactedAt, isoNow());
          assert.deepEqual(intakeHeldPhones(f.workspace.id, ["+919876543210"], [row]), new Set(["+919876543210"]));
          assert.equal((await cleanIntakeRetention(f.workspace.id)).redacted, 0); assert.deepEqual(await f.rows(), [row]);
          assert.equal((await f.accept(`import-${phase}`, "STOP")).result.duplicate, true);
        } finally { afterQuery = undefined; c.mock.timers.reset(); }
      });
    }
    await t.test("each row rechecks time after parsing and keeps its own processedAt and shortened deadline", async c => {
      const f = await fixture(); await f.restrict();
      for (let i = 0; i < 3; i++) await f.accept(`per-row-${i}`, "Hello", `91987654321${i}`);
      await f.restore(); const start = Date.now(), rows = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 0; i < rows.length; i++) await tenantTransaction(f.workspace.id, tx => tx.update(schema.intakeInbox).set({ expiresAt: new Date(start + (i === 1 ? 1000 : 10000)).toISOString() }).where(eq(schema.intakeInbox.id, rows[i].id)));
      const before = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
      c.mock.timers.enable({ apis: ["Date"], now: start });
      const parse = intakePayloadSchema.parse.bind(intakePayloadSchema); let parsed = 0;
      c.mock.method(intakePayloadSchema, "parse", (value: unknown) => {
        const payload = parse(value); parsed++;
        if (parsed === 2) c.mock.timers.setTime(start + 1000);
        if (parsed === 3) c.mock.timers.setTime(start + 2000);
        return payload;
      });
      try {
        const result = await importIntake(f.workspace.id, f.actor); assert.equal(result.result.imported, 2); assert.equal(parsed, 3);
        const after = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
        for (let i = 0; i < after.length; i++) assert.deepEqual(evidence(after[i]), evidence(before[i]));
        assert.equal(after[0].processedAt, new Date(start).toISOString()); assert.equal(after[1].state, "expired"); assert.equal(after[1].payload, null);
        assert.equal(after[2].processedAt, new Date(start + 2000).toISOString());
        const workspace = await loadPostgresWorkspace(f.workspace.id); assert.equal(workspace.leads.length, 2); assert.equal(workspace.messages.length, 2); assert.equal(workspace.jobs.length, 0);
      } finally { c.mock.timers.reset(); }
    });
    await t.test("a deadline crossed by a later receipt write rolls back the entire imported batch", async c => {
      const f = await fixture(); await f.restrict(); await f.accept("batch-first"); await f.accept("batch-second", "Hello", "919876543211"); await f.restore();
      const start = Date.now(), rows = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
      for (let i = 0; i < rows.length; i++) await tenantTransaction(f.workspace.id, tx => tx.update(schema.intakeInbox).set({ expiresAt: new Date(start + (i === 0 ? 1000 : 10000)).toISOString() }).where(eq(schema.intakeInbox.id, rows[i].id)));
      const before = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
      c.mock.timers.enable({ apis: ["Date"], now: start }); let writes = 0;
      afterQuery = async query => { if (query.startsWith('update "intake_inbox"') && ++writes === 2) c.mock.timers.setTime(start + 1000); };
      try {
        await assert.rejects(() => importIntake(f.workspace.id, f.actor), /Intake expired during processing/);
        afterQuery = undefined; await emptyCrm(f.workspace.id);
        const after = (await f.rows()).sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(evidence(after[0]), evidence(before[0])); assert.equal(after[0].state, "expired"); assert.equal(after[0].payload, null); assert.equal(after[0].processedAt, null);
        assert.deepEqual(after[1], before[1], "the still-live receipt is not marked imported by a rolled-back batch");
      } finally { afterQuery = undefined; c.mock.timers.reset(); }
    });
    await t.test("cleanup queued during hydration cannot resurrect or rewrite the expiring receipt", async c => {
      const f = await fixture(); await f.restrict(); await f.accept("cleanup-race", "STOP"); await f.restore();
      const start = Date.now(), deadline = start + 1000;
      await tenantTransaction(f.workspace.id, tx => tx.update(schema.intakeInbox).set({ expiresAt: new Date(deadline).toISOString() }).where(eq(schema.intakeInbox.organizationId, f.workspace.id)));
      const [before] = await f.rows(); c.mock.timers.enable({ apis: ["Date"], now: start });
      let selected = false, cleanup: ReturnType<typeof cleanIntakeRetention> | undefined;
      afterQuery = async query => {
        if (importPage(query)) selected = true;
        if (selected && hydrationRead(query)) {
          afterQuery = undefined; c.mock.timers.setTime(deadline);
          cleanup = cleanIntakeRetention(f.workspace.id); await Promise.resolve();
        }
      };
      try {
        assert.equal((await importIntake(f.workspace.id, f.actor)).result.imported, 0);
        assert.ok(cleanup); assert.equal((await cleanup).redacted, 0);
        const [row] = await f.rows(); assert.deepEqual(evidence(row), evidence(before)); assert.equal(row.state, "expired"); assert.equal(row.payload, null); assert.equal(row.processedAt, null);
        await emptyCrm(f.workspace.id); assert.equal((await f.accept("cleanup-race", "STOP")).result.duplicate, true);
        assert.deepEqual(await f.rows(), [row]);
      } finally { afterQuery = undefined; await cleanup; c.mock.timers.reset(); }
    });
    await t.test("reader/import deadlines work while worker is down; expired holds block automation", async () => {
      const f = await fixture(); await f.restrict(); await f.accept("stop", "STOP"); await f.expire(); await f.restore();
      assert.equal((await intakeSummary(f.workspace.id, f.actor)).count, 0);
      assert.equal((await intakeSummary(f.workspace.id, f.actor)).expiredCount, 1);
      assert.equal((await importIntake(f.workspace.id, f.actor)).result.imported, 0);
      assert.equal((await f.accept("new-contact")).result.deferred, true);
      await cleanIntakeRetention(f.workspace.id, 1);
      const erased = (await f.rows()).find(row => row.state === "expired")!;
      assert.equal(erased.payload, null); assert.ok(erased.redactedAt);
      const replay = await f.accept("stop", "STOP"); assert.equal(replay.result.duplicate, true);
      await assert.rejects(() => f.accept("stop", "changed"), /different payload/);
      await importIntake(f.workspace.id, f.actor);
      const workspace = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(workspace.leads[0].intakePending, true); assert.ok(replyBlock(workspace.leads[0])); assert.equal(workspace.jobs.length, 0);
      assert.equal((await inspectIntakeRetention(f.workspace.id)).expiredHolds, 1);
    });
    await t.test("import deadline is seven days or original thirty-day bound; imported replay cannot resurrect", async () => {
      const f = await fixture(); await f.accept("immediate"); const [before] = await f.rows();
      assert.equal(Date.parse(before.expiresAt) - Date.parse(before.processedAt!), INTAKE_IMPORTED_AGE_MS);
      await f.expire(); await cleanIntakeRetention(f.workspace.id); const [erased] = await f.rows();
      assert.equal(erased.state, "imported"); assert.equal(erased.payload, null);
      await f.accept("immediate"); assert.deepEqual(await f.rows(), [erased]);
      await assert.rejects(() => db.update(schema.intakeInbox).set({ payload: before.payload, redactedAt: null }).where(eq(schema.intakeInbox.id, erased.id)));
      for (const change of [{ expiresAt: before.expiresAt }, { receivedAt: isoNow() }, { payloadDigest: "a".repeat(64) }, { state: "deferred" as const }, { contactKey: "b".repeat(64) }, { processedAt: isoNow() }]) await assert.rejects(() => db.update(schema.intakeInbox).set(change).where(eq(schema.intakeInbox.id, erased.id)));
      await assert.rejects(() => db.delete(schema.intakeInbox).where(eq(schema.intakeInbox.id, erased.id)));
      await db.delete(schema.organizations).where(eq(schema.organizations.id, f.workspace.id)); assert.equal((await f.rows()).length, 0);
    });
    await t.test("cleanup pages are bounded, idempotent and tenant isolated; financial receipts untouched", async () => {
      const a = await fixture(), b = await fixture(); await a.restrict(); await b.restrict();
      for (let i = 0; i < 3; i++) await a.accept(`batch${i}`); await b.accept("other"); await a.expire(); await b.expire();
      const receiptAt = new Date(Date.now() - INTAKE_MAX_AGE_MS - 1).toISOString();
      await db.insert(schema.eventReceipts).values(["razorpay", "meta_leads"].map(provider => ({ id: `${provider}:${uid()}`, organizationId: a.workspace.id, provider, receivedAt: receiptAt, payload: { original: true } })));
      assert.equal((await cleanIntakeRetention(a.workspace.id, 2)).redacted, 2);
      assert.equal((await inspectIntakeRetention(a.workspace.id)).expiredPayloads, 1); assert.equal((await inspectIntakeRetention(b.workspace.id)).expiredPayloads, 1);
      const events = await db.select().from(schema.eventReceipts).where(eq(schema.eventReceipts.organizationId, a.workspace.id));
      assert.deepEqual(events.find(row => row.provider === "razorpay")!.payload, { original: true }); assert.deepEqual(events.find(row => row.provider === "meta_leads")!.payload, {});
      assert.equal((await cleanIntakeRetention(a.workspace.id, 2)).redacted, 1); assert.equal((await cleanIntakeRetention(a.workspace.id, 2)).selected, 0);
      await assert.rejects(() => cleanIntakeRetention(a.workspace.id, 501));
      const page = await sweepIntakeRetention(undefined, 1); assert.equal(page.selected, 1); assert.ok(page.after);
      await pg.exec("CREATE ROLE retention_reader NOLOGIN; GRANT SELECT ON intake_inbox TO retention_reader;");
      const foreign = await tenantTransaction(a.workspace.id, async tx => { await tx.execute(sql`set local role retention_reader`); return tx.select().from(schema.intakeInbox).where(eq(schema.intakeInbox.organizationId, b.workspace.id)); }); assert.equal(foreign.length, 0);
    });
    await t.test("Meta stored reader hides expired raw forms and JSONB digest ignores object property order", async () => {
      const f = await fixture(); await f.restrict(); const connectionId = uid();
      await mutatePostgresWorkspace(f.workspace.id, w => { w.connections!.push({ id: connectionId, service: "meta_leads", status: "connected", externalId: "7766", label: "Page", metadata: {}, updatedAt: isoNow() }); });
      const payload: IntakePayload = { service: "meta_leads", event: { pageId: "7766", leadgenId: "7767" }, form: { id: "7767", field_data: [{ name: "phone_number", values: ["+919876543210"] }] } };
      await acceptIntake(f.workspace.id, connectionId, "7766", payload);
      assert.equal((await acceptIntake(f.workspace.id, connectionId, "7766", { form: payload.form, event: { leadgenId: "7767", pageId: "7766" }, service: "meta_leads" })).result.duplicate, true);
      await f.expire(); assert.equal((await storedMetaIntake(f.workspace.id, "7766", "7767"))!.payload, null);
      assert.ok((await f.rows())[0].payload, "reader expiry must work before physical cleanup");
    });
    await t.test("repository bounds reject excessive and malformed pages directly", async () => {
      const f = await fixture();
      for (const [page, pageSize] of [[1001, 100], [0, 100], [1.5, 100], [1, 101], [1, 0]]) await assert.rejects(() => queryPostgresLeads(f.workspace.id, f.actor, { page, pageSize }), /pagination/);
      await f.accept("one"); const result = await queryPostgresLeads(f.workspace.id, f.actor, { page: 1000, pageSize: 1 }); assert.equal(result.total, 1); assert.equal(result.hasMore, false);
    });
  } finally {
    await closeDatabase(); await pg.close();
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
