import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { useTestDatabase, closeDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import { acceptIntake, importIntake, intakeSummary } from "../src/lib/db/intake";
import { createWorkspace } from "../src/lib/seed";
import { uid, isoNow, replyBlock, type Workspace } from "../src/lib/domain";
import { TRIAL_MS, SubscriptionRestricted } from "../src/lib/subscription-policy";
import { requirePaidCapability } from "../src/lib/subscription-access";
import { refreshBillingAccess } from "../src/lib/providers/billing";
import { recoverWorkspaceJobs, processJobs, publicWorkspace } from "../src/lib/integrations";
import { POST as whatsappPost } from "../src/app/api/webhooks/whatsapp/route";
import type { IntakePayload } from "../src/lib/intake-types";

type Actor = NonNullable<Workspace["actor"]>;
const migrationFiles = async () => (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort();
async function isolatedModule<T>(file: string, overrides: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports);
  return module.exports as T;
}

test("legacy upgrade grants one migration-anchored trial only to eligible unlinked institutes", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await migrationFiles()).filter(file => file < "0006")) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema });
    const cases = ["eligible-a", "eligible-b", "linked", "history", "active", "ambiguous", "demo"];
    for (const name of cases) {
      const workspace = createWorkspace(name === "demo");
      const subscription = name === "linked" ? { status: "trial", plan: "Pilot", providerId: "sub_legacy" } : name === "active" ? { status: "active", plan: "Paid" } : name === "ambiguous" ? { plan: "Unknown" } : workspace.subscription!;
      await db.insert(schema.organizations).values({ id: workspace.id, workosId: `org_${name}`, name, ownerName: "Owner", demo: workspace.demo, sequence: workspace.sequence, ai: workspace.ai!, subscription: subscription as Workspace["subscription"] & {} });
      await db.insert(schema.organizationRoutes).values({ organizationId: workspace.id, workosId: `org_${name}` });
      if (name === "history") await db.insert(schema.eventReceipts).values({ id: uid(), organizationId: workspace.id, provider: "billing_checkout", receivedAt: isoNow(), payload: {} });
    }
    const before = Date.now();
    for (const file of (await migrationFiles()).filter(file => file >= "0006")) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const rows = await db.select().from(schema.instituteTrials);
    assert.equal(rows.length, 6);
    const grants = rows.filter(row => !row.consumed);
    assert.equal(grants.length, 2); assert.equal(grants[0].startedAt, grants[1].startedAt);
    assert.ok(Date.parse(grants[0].startedAt!) >= before && Date.parse(grants[0].startedAt!) <= Date.now());
    for (const row of grants) assert.equal(Date.parse(row.endsAt!) - Date.parse(row.startedAt!), TRIAL_MS);
    for (const row of rows.filter(row => row.consumed)) { assert.equal(row.startedAt, null); assert.equal(row.endsAt, null); }
    await assert.rejects(() => db.insert(schema.instituteTrials).values({ workosId: "org_invalid", provenance: "test", startedAt: isoNow(), endsAt: isoNow() }));
    await assert.rejects(() => db.update(schema.instituteTrials).set({ consumed: false }).where(eq(schema.instituteTrials.workosId, "org_history")));
  } finally { await pg.close(); }
});

test("hosted intake, actual workspace routes and restricted worker recovery", { timeout: 120_000 }, async t => {
  const env = { DATABASE_URL: "postgresql://injected-pglite-only", APP_BASE_URL: "", META_APP_SECRET: "test-only-meta-signature", BILLING_PLANS_JSON: "" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("Network forbidden in subscription intake tests"); });
  const pg = new PGlite();
  try {
    for (const file of await migrationFiles()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    let sequence = 0;
    async function fixture() {
      const workspace = createWorkspace(false), n = ++sequence;
      workspace.members = [{ id: `om_intake_${n}`, workosId: `user_intake_${n}`, role: "owner", name: "Owner", email: `${n}@example.com`, status: "active" }];
      workspace.connections = [{ id: uid(), service: "whatsapp", status: "connected", externalId: String(100000 + n), label: "Test", updatedAt: isoNow(), metadata: { wabaId: "123" } }];
      workspace.ai!.mode = "autonomous";
      await createPostgresWorkspace(workspace, `org_intake_${n}`);
      const actor: Actor = { id: workspace.members[0].workosId!, memberId: workspace.members[0].id, role: "owner", name: "Owner", email: workspace.members[0].email, backend: "workos" };
      const connection = workspace.connections[0];
      const accept = (id: string, body = "Course fees?", from = "919876543210", timestamp?: string) => acceptIntake(workspace.id, connection.id, connection.externalId, { service: "whatsapp", event: { id, from, body, timestamp, verified: true } });
      const restrict = () => mutatePostgresWorkspace(workspace.id, current => { current.subscription = { status: "cancelled", plan: "Ended" }; });
      const restore = () => mutatePostgresWorkspace(workspace.id, current => { current.subscription = { status: "active", plan: "Paid", providerId: `sub_test${n}`, providerPlanId: "plan_test", providerStatus: "active", verifiedAt: isoNow(), currentPeriodEnd: new Date(Date.now() + 3600_000).toISOString() }; });
      const rows = () => tenantTransaction(workspace.id, tx => tx.select().from(schema.intakeInbox).where(eq(schema.intakeInbox.organizationId, workspace.id)));
      return { workspace, actor, connection, accept, restrict, restore, rows };
    }

    await t.test("durable duplicate receipt, immutable binding, safe recovery and original missing timestamp", async () => {
      const f = await fixture(); await f.restrict();
      const outcomes = await Promise.all([f.accept("missing-timestamp"), f.accept("missing-timestamp")]);
      assert.equal(outcomes.filter(item => item.result.duplicate).length, 1);
      assert.equal((await loadPostgresWorkspace(f.workspace.id)).leads.length, 0);
      assert.equal((await f.rows()).length, 1);
      assert.equal((await intakeSummary(f.workspace.id, f.actor)).count, 1);
      await assert.rejects(() => f.accept("missing-timestamp", "Changed payload"), /different payload/);
      await assert.rejects(() => importIntake(f.workspace.id, f.actor), SubscriptionRestricted);
      const acceptedAt = (await f.rows())[0].receivedAt;
      await f.restore();
      assert.equal((await importIntake(f.workspace.id, f.actor)).result.imported, 1);
      const current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads.length, 1); assert.equal(current.leads[0].humanOwned, true);
      assert.equal(current.messages[0].createdAt, acceptedAt, "Replay must not open a new 24-hour reply window");
      assert.equal(current.messages[0].receivedAt, acceptedAt);
      assert.equal(current.jobs.length, 0); assert.equal(current.leads[0].intakePending, false);
      assert.equal((await importIntake(f.workspace.id, f.actor)).result.imported, 0);
      assert.equal((await f.accept("missing-timestamp")).result.duplicate, true);
      assert.ok(!JSON.stringify(publicWorkspace(current, f.actor)).includes("trial\":"));
    });

    await t.test("existing signed safety/status updates survive mixed restricted intake and replay", async () => {
      const f = await fixture();
      await f.accept("existing", "Hello", "919876543211", String(Math.floor(Date.now() / 1000) - 60));
      const requestId = uid();
      await mutatePostgresWorkspace(f.workspace.id, current => { current.messages.push({ id: requestId, leadId: current.leads[0].id, providerId: "wamid.accepted", direction: "outbound", body: "Accepted", author: "Owner", status: "accepted", createdAt: isoNow(), dispatchedAt: isoNow() }); });
      await f.restrict();
      const raw = JSON.stringify({ entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: f.connection.externalId }, statuses: [{ id: "wamid.accepted", status: "delivered", recipient_id: "919876543211" }], messages: [{ id: "new-restricted", from: "919876543212", type: "text", text: { body: "New enquiry" } }, { id: "stop-existing", from: "919876543211", type: "text", text: { body: "STOP" } }] } }] }] });
      const deliver = () => whatsappPost(new NextRequest("http://127.0.0.1/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", process.env.META_APP_SECRET!).update(raw).digest("hex")}` } }));
      assert.equal((await deliver()).status, 200); assert.equal((await deliver()).status, 200);
      const current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads.length, 1); assert.equal(current.leads[0].consent, "opted_out");
      assert.equal(current.messages.find(message => message.id === requestId)?.status, "delivered");
      assert.equal(current.messages.filter(message => message.providerId === "stop-existing").length, 1);
      assert.ok(!current.jobs.some(job => job.status === "pending"));
      assert.equal((await intakeSummary(f.workspace.id, f.actor)).count, 1);
    });

    await t.test("receipt failure rolls back the aggregate and retries apply exactly once", async () => {
      const f = await fixture();
      await pg.exec("CREATE FUNCTION fail_intake_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test intake unavailable'; END $$; CREATE TRIGGER fail_intake_test BEFORE INSERT ON intake_inbox FOR EACH ROW EXECUTE FUNCTION fail_intake_test();");
      try { await assert.rejects(() => f.accept("atomic")); } finally { await pg.exec("DROP TRIGGER fail_intake_test ON intake_inbox; DROP FUNCTION fail_intake_test();"); }
      assert.equal((await loadPostgresWorkspace(f.workspace.id)).leads.length, 0); assert.equal((await f.rows()).length, 0);
      await f.accept("atomic"); await f.accept("atomic");
      assert.equal((await loadPostgresWorkspace(f.workspace.id)).messages.length, 1);
    });

    await t.test("partial import blocks contact until all earlier STOP events are reviewed", async () => {
      const f = await fixture(); await f.restrict();
      for (let i = 0; i < 27; i++) await f.accept(`page-${i}`, i === 0 ? "STOP" : "Course fees?", "919876543213", String(Math.floor(Date.now() / 1000) - 100 + i));
      await f.restore();
      const first = await importIntake(f.workspace.id, f.actor);
      assert.equal(first.result.imported, 25); assert.equal(first.result.hasMore, true);
      const partial = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(partial.leads[0].intakePending, true); assert.ok(replyBlock(partial.leads[0]));
      await f.accept("after-restore", "Latest message", "919876543213");
      assert.ok(!(await loadPostgresWorkspace(f.workspace.id)).jobs.some(job => job.status === "pending"));
      assert.equal((await importIntake(f.workspace.id, f.actor, first.result.after)).result.imported, 2);
      const current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads[0].intakePending, false); assert.equal(current.leads[0].consent, "opted_out");
      assert.equal(current.leads[0].humanOwned, true); assert.equal(current.jobs.length, 0);
    });

    await t.test("connection changes remain deferred and quota failure rolls back the whole page", async () => {
      const f = await fixture(); await f.restrict();
      await f.accept("quota-a", "Hello", "919876543214"); await f.accept("quota-b", "Hello", "919876543215");
      await f.restore();
      process.env.BILLING_PLANS_JSON = JSON.stringify([{ id: "test", name: "Test", razorpayPlanId: "plan_test", totalCount: 12, limits: { leads: 1 } }]);
      try { await assert.rejects(() => importIntake(f.workspace.id, f.actor), /No import rows were saved/); } finally { process.env.BILLING_PLANS_JSON = ""; }
      assert.equal((await loadPostgresWorkspace(f.workspace.id)).leads.length, 0);
      assert.ok((await f.rows()).every(row => row.state === "deferred"));
      await mutatePostgresWorkspace(f.workspace.id, current => { current.connections![0].externalId = "987654321"; });
      const changed = await importIntake(f.workspace.id, f.actor);
      assert.equal(changed.result.imported, 0); assert.equal(changed.result.blocked, 2);
      assert.equal((await intakeSummary(f.workspace.id, f.actor)).needsConnection, true);
      await assert.rejects(() => acceptIntake(f.workspace.id, uid(), "987654321", { service: "whatsapp", event: { id: "quota-a", from: "919876543214", body: "Hello", verified: true } }), /connection changed/);
    });

    await t.test("retained Meta forms import offline, respect opt-out and enforce payload bounds", async () => {
      const f = await fixture(); await f.restrict();
      const connectionId = uid();
      await mutatePostgresWorkspace(f.workspace.id, current => { current.connections!.push({ id: connectionId, service: "meta_leads", status: "connected", externalId: "5555", label: "Page", updatedAt: isoNow(), metadata: {} }); });
      const payload: IntakePayload = { service: "meta_leads", event: { pageId: "5555", leadgenId: "1234", createdTime: 1700000000 }, form: { id: "1234", field_data: [{ name: "phone_number", values: ["+919876543216"] }, { name: "full_name", values: ["Student"] }] } };
      assert.equal((await acceptIntake(f.workspace.id, connectionId, "5555", payload)).result.deferred, true);
      const large = structuredClone(payload); large.event.leadgenId = large.form.id = "1235"; large.form.field_data = [{ name: "payload", values: Array.from({ length: 20 }, () => "x".repeat(10000)) }];
      await assert.rejects(() => acceptIntake(f.workspace.id, connectionId, "5555", large), /payload limit/);
      await f.restore(); await importIntake(f.workspace.id, f.actor);
      const current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads[0].createdAt, new Date(1700000000000).toISOString());
      assert.equal(current.leads[0].consent, "unknown"); assert.equal(current.jobs.length, 0);
      assert.equal((await acceptIntake(f.workspace.id, connectionId, "5555", payload)).result.duplicate, true);
    });

    await t.test("tenant RLS and actor checks prevent inbox inspection and recovery across institutes", async () => {
      const a = await fixture(), b = await fixture(); await a.restrict(); await a.accept("private");
      await assert.rejects(() => intakeSummary(a.workspace.id, b.actor), /membership has changed/);
      await assert.rejects(() => importIntake(a.workspace.id, b.actor), /membership has changed/);
      await pg.exec("CREATE ROLE intake_reader NOLOGIN; GRANT SELECT ON intake_inbox TO intake_reader;");
      const result = await tenantTransaction(b.workspace.id, async tx => { await tx.execute(sql`set local role intake_reader`); return tx.select().from(schema.intakeInbox); });
      assert.equal(result.length, 0);
    });

    await t.test("actual API rejects paid actions but permits existing-data work, safety and reads", async () => {
      const f = await fixture(); await f.accept("existing-api"); await f.restrict();
      const leadId = (await loadPostgresWorkspace(f.workspace.id)).leads[0].id;
      const route = await isolatedModule<typeof import("../src/app/api/workspace/route")>("src/app/api/workspace/route.ts", { "@/lib/auth": { resolveWorkspace: async () => ({ workspaceId: f.workspace.id, actor: f.actor }) } });
      const request = (action?: Record<string, unknown>) => new NextRequest("http://127.0.0.1:3000/api/workspace", { method: action ? "POST" : "GET", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, ...(action ? { body: JSON.stringify(action) } : {}) });
      for (const action of [
        { type: "lead.create", lead: { name: "New", phone: "+919876543217" } }, { type: "lead.import", rows: [] },
        { type: "message.send", leadId, body: "Hello", requestId: uid() }, { type: "message.suggest", leadId },
        { type: "campaign.create" }, { type: "sequence.save", enabled: true },
        { type: "ai.save", settings: { mode: "autonomous" } }, { type: "lead.update", id: leadId, changes: { humanOwned: false } },
      ]) { const response = await route.POST(request(action)); assert.equal(response.status, 402, String(action.type)); assert.equal((await response.json()).code, "SUBSCRIPTION_RESTRICTED"); }
      for (const action of [{ type: "message.note", leadId, body: "Internal work retained" }, { type: "lead.update", id: leadId, changes: { consent: "opted_out", humanOwned: true } }, { type: "sequence.save", enabled: false, delays: [0, 24, 72] }]) assert.equal((await route.POST(request(action))).status, 200, action.type);
      const read = await route.GET(request()); assert.equal(read.status, 200); assert.equal((await read.json()).capabilities.allowed, false);
      assert.equal((await processJobs(f.workspace.id)).processed, 0);
    });

    await t.test("restriction freezes undispatched processing and future jobs across restoration, preserving uncertainty", async () => {
      const f = await fixture(); await f.accept("worker-existing");
      const ids = [uid(), uid(), uid()];
      await mutatePostgresWorkspace(f.workspace.id, current => {
        current.jobs = [];
        current.jobs.push({ id: ids[0], kind: "knowledge.index", campaignId: "", leadId: "", step: 0, status: "pending", dueAt: new Date(Date.now() + 86400_000).toISOString() });
        current.jobs.push({ id: ids[1], kind: "knowledge.index", campaignId: "", leadId: "", step: 0, status: "processing", dueAt: isoNow(), lockedAt: isoNow(), attempts: 1 });
        const messageId = uid(); current.messages.push({ id: messageId, leadId: current.leads[0].id, body: "Uncertain", direction: "outbound", author: "AI", status: "queued", createdAt: isoNow(), dispatchedAt: isoNow(), dispatchState: "uncertain" });
        current.jobs.push({ id: ids[2], kind: "ai.reply", campaignId: "", leadId: current.leads[0].id, messageId, step: 0, status: "processing", dueAt: isoNow(), lockedAt: new Date(Date.now() - 600_000).toISOString(), dispatchedAt: isoNow(), attempts: 1 });
      });
      await f.restrict(); await refreshBillingAccess(f.workspace.id); await f.restore();
      await mutatePostgresWorkspace(f.workspace.id, current => recoverWorkspaceJobs(current, Date.now() + 600_000));
      const current = await loadPostgresWorkspace(f.workspace.id);
      for (const id of ids.slice(0, 2)) { const job = current.jobs.find(item => item.id === id)!; assert.equal(job.status, "failed"); assert.equal(job.payload?.blockedReason, "subscription"); }
      assert.equal(current.jobs.find(item => item.id === ids[2])?.status, "reconcile");
    });
    await t.test("cancellation before final dispatch prevents sends; after dispatch preserves acceptance", async () => {
      for (const beforeDispatch of [true, false]) {
        const f = await fixture(); await f.accept(`dispatch-${beforeDispatch}`);
        const current = await loadPostgresWorkspace(f.workspace.id), requestId = uid();
        let sends = 0, preparations = 0;
        const meta = await import("../src/lib/providers/meta");
        const integrations = await isolatedModule<typeof import("../src/lib/integrations")>("src/lib/integrations.ts", { "./providers/meta": { ...meta, sendText: async (_workspace: Workspace, _lead: unknown, message: { body: string }, guard: (value: { body: string }) => Promise<void>) => {
          preparations++;
          if (beforeDispatch) await f.restrict();
          await guard({ body: message.body });
          sends++;
          if (!beforeDispatch) await f.restrict();
          return "wamid.dispatch-order";
        } } });
        const send = () => integrations.sendReply(f.workspace.id, current.leads[0].id, "Reply", requestId, { actor: f.actor });
        if (beforeDispatch) await assert.rejects(send, SubscriptionRestricted); else await send();
        const stored = (await loadPostgresWorkspace(f.workspace.id)).messages.find(message => message.id === requestId)!;
        assert.equal(sends, beforeDispatch ? 0 : 1); assert.equal(preparations, 1);
        assert.equal(stored.status, beforeDispatch ? "failed" : "accepted");
        assert.equal(Boolean(stored.dispatchedAt), !beforeDispatch);
        await assert.rejects(send, SubscriptionRestricted); assert.equal(sends, beforeDispatch ? 0 : 1);
      }
    });

    await t.test("voice attachment subscription denial propagates without a second send attempt", async () => {
      const f = await fixture(); await f.accept("voice-attachment");
      const current = await loadPostgresWorkspace(f.workspace.id), lead = current.leads[0], fileId = uid(), requestId = uid();
      await mutatePostgresWorkspace(f.workspace.id, workspace => { workspace.files!.push({ id: fileId, leadId: lead.id, name: "reply.mp3", mime: "audio/mpeg", size: 64, purpose: "attachment", status: "ready", createdAt: isoNow(), objectKey: `${workspace.id}/test-only.mp3`, uploadedBy: f.actor.id }); });
      let attempts = 0;
      const meta = await import("../src/lib/providers/meta");
      const integrations = await isolatedModule<typeof import("../src/lib/integrations")>("src/lib/integrations.ts", { "./providers/meta": { ...meta, sendText: async () => {
        attempts++; await f.restrict(); await requirePaidCapability(f.workspace.id); throw new Error("Must not reach send");
      } } });
      await assert.rejects(() => integrations.sendReply(f.workspace.id, lead.id, "Reply transcript", requestId, { actor: f.actor, fileId, voiceAudio: true }), SubscriptionRestricted);
      assert.equal(attempts, 1);
      const message = (await loadPostgresWorkspace(f.workspace.id)).messages.find(item => item.id === requestId)!;
      assert.equal(message.status, "failed"); assert.equal(message.fileId, fileId);
      assert.equal(message.voiceFallback, undefined); assert.ok(!message.dispatchedAt);
    });

    await t.test("STT/TTS and post-retrieval AI checks reject stale allowed snapshots without a provider call", async () => {
      const f = await fixture(); await f.accept("provider-gates");
      const snapshot = await loadPostgresWorkspace(f.workspace.id);
      const speech = await isolatedModule<typeof import("../src/lib/providers/speech")>("src/lib/providers/speech.ts", { "../connections": { credentials: async () => ({ apiKey: "test-only", voiceId: "testvoice123" }) } });
      await f.restrict();
      await assert.rejects(() => speech.synthesize(snapshot, "Hello"), SubscriptionRestricted);
      await assert.rejects(() => speech.transcribe(snapshot, Buffer.from("OggS" + "\0".repeat(60)), "audio/ogg"), SubscriptionRestricted);
      await f.restore();
      let completions = 0, retrievals = 0;
      const ai = await isolatedModule<typeof import("../src/lib/providers/ai")>("src/lib/providers/ai.ts", {
        "../connections": { credentials: async () => ({ apiKey: "test-only" }) },
        "../db/knowledge": { retrieveKnowledge: async () => { retrievals++; await f.restrict(); return { sources: [], retrievalMode: "full-text" }; } },
        openai: class { chat = { completions: { parse: async () => { completions++; throw new Error("Must not dispatch"); } } }; },
      });
      await assert.rejects(() => ai.generateReply(snapshot, snapshot.leads[0]), SubscriptionRestricted);
      assert.equal(retrievals, 1); assert.equal(completions, 0);
    });
    for (const stage of ["transcription", "synthesis"] as const) await t.test(`voice ${stage} subscription denial cannot produce a text fallback or retry`, async st => {
      const f = await fixture(); await f.accept(`voice-${stage}`);
      let generation = 0, speech = 0, sends = 0, saves = 0;
      const bytes = Buffer.from("OggS" + "\0".repeat(60));
      await mutatePostgresWorkspace(f.workspace.id, current => {
        current.ai!.voiceReplies = true;
        current.messages[0].mediaType = "audio"; current.messages[0].providerMediaId = "123456";
        for (const job of current.jobs) job.dueAt = isoNow();
      });
      const current = await loadPostgresWorkspace(f.workspace.id), job = current.jobs.find(item => item.kind === "ai.reply")!;
      assert.ok(job);
      st.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
        assert.equal(String(input), "https://media.fbcdn.net/test-only.ogg");
        return new Response(bytes, { status: 200 });
      });
      const meta = await import("../src/lib/providers/meta"), files = await import("../src/lib/files");
      const integrations = await isolatedModule<typeof import("../src/lib/integrations")>("src/lib/integrations.ts", {
        "./connections": { credentials: async () => ({ accessToken: "test-only" }), connectionFor: (workspace: Workspace, service: string) => workspace.connections?.find(item => item.service === service) },
        "./providers/meta": { ...meta, graph: async () => ({ url: "https://media.fbcdn.net/test-only.ogg", mime_type: "audio/ogg", file_size: bytes.length }), sendText: async () => { sends++; throw new Error("No outbound fallback allowed"); } },
        "./providers/speech": {
          transcribe: async () => { speech++; if (stage === "transcription") { await f.restrict(); await requirePaidCapability(f.workspace.id); } return "Course fees?"; },
          synthesize: async () => { speech++; await f.restrict(); await requirePaidCapability(f.workspace.id); return bytes; },
        },
        "./providers/ai": { generateReply: async () => { generation++; return { body: "Please speak with a counsellor", source: "Test", sourceIds: [], handoff: true, qualified: false, booking: null }; } },
        "./files": { ...files, saveGeneratedAudio: async () => { saves++; throw new Error("No audio persistence after denial"); } },
      });
      assert.equal(await integrations.processJob(f.workspace.id, job.id), false);
      const stored = await loadPostgresWorkspace(f.workspace.id), failed = stored.jobs.find(item => item.id === job.id)!;
      assert.equal(failed.status, "failed"); assert.equal(failed.payload?.blockedReason, "subscription");
      assert.equal(generation, stage === "transcription" ? 0 : 1); assert.equal(speech, stage === "transcription" ? 1 : 2);
      assert.equal(sends, 0); assert.equal(saves, 0);
      assert.ok(stored.messages.every(message => !message.voiceFallback && !message.dispatchedAt));
      await f.restore(); assert.equal(await integrations.processJob(f.workspace.id, job.id), false);
      assert.equal(sends, 0); assert.equal((await loadPostgresWorkspace(f.workspace.id)).leads[0].humanOwned, false, "Denied reply plan must not be applied");
    });

    await t.test("intake API authorizes summaries and bounded explicit recovery without raw payloads", async () => {
      const f = await fixture(); await f.restrict(); await f.accept("api-deferred", "Private original payload");
      let actor = f.actor;
      const route = await isolatedModule<typeof import("../src/app/api/intake/route")>("src/app/api/intake/route.ts", { "@/lib/auth": { resolveWorkspace: async () => ({ workspaceId: f.workspace.id, actor }) } });
      const request = (action?: Record<string, unknown>, origin = "http://127.0.0.1:3000") => new NextRequest("http://127.0.0.1:3000/api/intake", { method: action ? "POST" : "GET", headers: { Host: "127.0.0.1:3000", Origin: origin, "Content-Type": "application/json" }, ...(action ? { body: JSON.stringify(action) } : {}) });
      const summary = await route.GET(request()); assert.equal(summary.status, 200); assert.equal(summary.headers.get("cache-control"), "no-store");
      const text = await summary.text(); assert.equal(JSON.parse(text).count, 1); assert.ok(!text.includes("Private original payload"));
      const denied = await route.POST(request({ type: "import" })); assert.equal(denied.status, 402); assert.equal((await denied.json()).code, "SUBSCRIPTION_RESTRICTED");
      assert.equal((await route.POST(request({ type: "import" }, "https://foreign.example"))).status, 403);
      assert.equal((await route.POST(request({ type: "import", after: "bad" }))).status, 400);
      actor = { ...f.actor, role: "analyst" };
      assert.equal((await route.GET(request())).status, 403); assert.equal((await route.POST(request({ type: "import" }))).status, 403);
      actor = f.actor; await f.restore();
      const recovered = await route.POST(request({ type: "import" })); assert.equal(recovered.status, 200);
      const result = await recovered.json(); assert.equal(result.result.imported, 1); assert.equal(result.summary.count, 0);
      assert.equal(result.workspace.leads[0].intakePending, false); assert.equal(result.workspace.jobs.length, 0);
      assert.equal((await route.POST(request({ type: "import" }))).status, 200);
    });

    await t.test("pending Meta forms hold cross-channel intake and replay preserves earliest enquiry time", async () => {
      const f = await fixture(); await f.restrict();
      const connectionId = uid();
      await mutatePostgresWorkspace(f.workspace.id, current => { current.connections!.push({ id: connectionId, service: "meta_leads", status: "connected", externalId: "7777", label: "Page", updatedAt: isoNow(), metadata: {} }); });
      const original = 1700000000;
      const payload: IntakePayload = { service: "meta_leads", event: { pageId: "7777", leadgenId: "7778", createdTime: original }, form: { id: "7778", field_data: [{ name: "phone_number", values: ["+919876543219"] }] } };
      await acceptIntake(f.workspace.id, connectionId, "7777", payload); await f.restore();
      assert.equal((await f.accept("cross-channel-new", "Hello", "919876543219")).result.deferred, true);
      assert.equal((await loadPostgresWorkspace(f.workspace.id)).leads.length, 0);
      await importIntake(f.workspace.id, f.actor);
      let current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads.length, 1); assert.equal(current.jobs.length, 0); assert.equal(current.leads[0].humanOwned, true);
      assert.equal(current.leads[0].createdAt, new Date(original * 1000).toISOString());
      await f.accept("older-whatsapp", "Historical", "919876543219", String(original - 100));
      current = await loadPostgresWorkspace(f.workspace.id);
      assert.equal(current.leads[0].createdAt, new Date((original - 100) * 1000).toISOString());
      assert.equal(current.messages.find(message => message.id === current.leads[0].lastInboundMessageId)?.providerId, "cross-channel-new");
    });

    await t.test("each embedding batch rechecks access and retrieval cannot swallow a subscription denial", async () => {
      const f = await fixture(), articleId = uid();
      await mutatePostgresWorkspace(f.workspace.id, current => { current.articles.push({ id: articleId, title: "Fees", category: "FAQs", body: "Course fee information", updatedAt: isoNow() }); });
      const snapshot = await loadPostgresWorkspace(f.workspace.id);
      const oldVector = process.env.KNOWLEDGE_VECTOR_ENABLED; process.env.KNOWLEDGE_VECTOR_ENABLED = "true";
      try {
        let transactions = 0, calls = 0;
        const chunks = Array.from({ length: 33 }, (_, index) => ({ id: String(index), title: "Fees", body: "Information", contentHash: "hash" }));
        const knowledge = await isolatedModule<typeof import("../src/lib/db/knowledge")>("src/lib/db/knowledge.ts", {
          "./repository": { tenantTransaction: async () => [undefined, true, chunks][transactions++] },
          "../connections": { credentials: async () => ({ apiKey: "test-only" }) },
          openai: class { embeddings = { create: async ({ input }: { input: string[] }) => {
            calls++; assert.equal(input.length, 32); await f.restrict();
            return { data: input.map((_, index) => ({ index, embedding: Array(1536).fill(0) })) };
          } }; },
        });
        await assert.rejects(() => knowledge.indexKnowledgeEmbeddings(f.workspace.id, articleId), SubscriptionRestricted);
        assert.equal(calls, 1, "The second batch must not dispatch after cancellation");
        transactions = 0; calls = 0;
        const retrieval = await isolatedModule<typeof import("../src/lib/db/knowledge")>("src/lib/db/knowledge.ts", {
          "./repository": { tenantTransaction: async () => [[{ id: articleId }], { sources: [], retrievalMode: "full-text" }, true, [{ id: "chunk" }]][transactions++] },
          "../connections": { credentials: async () => ({ apiKey: "test-only" }) },
          openai: class { embeddings = { create: async () => { calls++; throw new Error("Forbidden embedding"); } }; },
        });
        await assert.rejects(() => retrieval.retrieveKnowledge(snapshot, "fees"), SubscriptionRestricted);
        assert.equal(calls, 0);
      } finally { if (oldVector === undefined) delete process.env.KNOWLEDGE_VECTOR_ENABLED; else process.env.KNOWLEDGE_VECTOR_ENABLED = oldVector; }
    });
    assert.equal(networkCalls, 0);
  } finally {
    await closeDatabase(); await pg.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
