import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { applyAction } from "../src/lib/actions";
import { hydrateWorkspace, uid, isoNow } from "../src/lib/domain";
import { createWorkspace } from "../src/lib/seed";
import { authorizeRecordAction } from "../src/lib/permissions";
import { openSecret, sealSecret } from "../src/lib/secrets";
import { readFileBytes } from "../src/lib/files";
import { saveNewWorkspace } from "../src/lib/store";
import { workspaceEventStream } from "../src/app/api/events/stream";
import { billingOverview, createBillingCheckout } from "../src/lib/providers/billing";
import { retrieveKnowledge } from "../src/lib/db/knowledge";
import { articleChunks } from "../src/lib/db/chunks";
import { useTestDatabase, closeDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import * as schema from "../src/lib/db/schema";

function environment(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

// All providers are replaced before exercising service entry points. Run through verificationEnvironment.
test("bulk action hydrates once, prevalidates every ID, and preserves assignment/cancellation/activity semantics", () => {
  const workspace = hydrateWorkspace(createWorkspace());
  const leads = workspace.leads.slice(0, 3);
  leads.forEach(lead => { lead.stage = "New"; lead.humanOwned = false; });
  workspace.jobs = leads.flatMap(lead => [
    { id: uid(), leadId: lead.id, campaignId: "", step: 0, dueAt: isoNow(), status: "pending" as const },
    { id: uid(), leadId: lead.id, campaignId: "", step: 0, dueAt: isoNow(), status: "processing" as const, dispatchedAt: isoNow() },
  ]);
  const before = structuredClone(workspace);
  assert.throws(() => applyAction(workspace, { type: "lead.bulk", ids: [leads[0].id, uid()], stage: "Lost" }), /not found/);
  assert.deepEqual(workspace, before);
  assert.throws(() => applyAction(workspace, { type: "lead.bulk", ids: leads.map(lead => lead.id), ownerId: "foreign" }), /active member/);
  assert.deepEqual(workspace, before);
  const member = workspace.members![0];
  assert.throws(() => authorizeRecordAction(workspace, { id: member.id, name: member.name, email: member.email, role: "counsellor", backend: "local" }, { type: "lead.bulk", ids: [leads[0].id] }), /permission/);
  let hydrations = 0, ai = workspace.ai;
  Object.defineProperty(workspace, "ai", { configurable: true, enumerable: true, get: () => ai, set: value => { hydrations++; ai = value; } });
  const result = applyAction(workspace, { type: "lead.bulk", ids: [...leads.map(lead => lead.id), leads[0].id], ownerId: member.id, stage: "Lost" });
  assert.deepEqual(result, { updated: 3 });
  assert.equal(hydrations, 1);
  assert.ok(leads.every(lead => lead.stage === "Lost" && lead.ownerId === member.id));
  assert.equal(workspace.jobs.filter(job => job.status === "cancelled").length, 3);
  assert.ok(workspace.jobs.filter(job => job.dispatchedAt).every(job => job.status === "processing"));
  assert.equal(workspace.activities.length - before.activities.length, 3);
});

test("1000 legacy bulk records hydrate once and resolve owners without changing bulk bounds", () => {
  const workspace = createWorkspace();
  const template = workspace.leads[0];
  workspace.leads = Array.from({ length: 1000 }, () => ({ ...template, id: uid(), ownerId: undefined, owner: workspace.team[0], stage: "New" as const }));
  workspace.jobs = []; workspace.activities = [];
  let hydrations = 0, ai = workspace.ai;
  Object.defineProperty(workspace, "ai", { configurable: true, enumerable: true, get: () => ai, set: value => { hydrations++; ai = value; } });
  const ids = workspace.leads.map(lead => lead.id);
  assert.deepEqual(applyAction(workspace, { type: "lead.bulk", ids, stage: "Qualified" }), { updated: 1000 });
  assert.equal(hydrations, 1);
  assert.ok(workspace.leads.every(lead => lead.ownerId && lead.stage === "Qualified"));
  assert.equal(workspace.activities.length, 1000);
  assert.throws(() => applyAction(workspace, { type: "lead.bulk", ids: [...ids, uid()], stage: "Lost" }));
  assert.ok(workspace.leads.every(lead => lead.stage === "Qualified"));
});

test("KMS reuses only the client, sends tenant contexts every time and resets with provider configuration", async t => {
  environment(t, { KMS_KEY_ID: "test-key", AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_SESSION_TOKEN: "", INTEGRATION_ENCRYPTION_KEY: "" });
  const clients: KMSClient[] = [], contexts: unknown[] = [];
  t.mock.method(KMSClient.prototype, "send", async function(this: KMSClient, command: EncryptCommand | DecryptCommand) {
    clients.push(this); contexts.push(command.input.EncryptionContext);
    if (command instanceof EncryptCommand) return { CiphertextBlob: Buffer.from("test-ciphertext") };
    return { Plaintext: Buffer.from(JSON.stringify({ token: `synthetic-${clients.length}` })) };
  });
  const sealed = await sealSecret({ token: "synthetic" }, "tenant-a");
  const first = await openSecret(sealed, "tenant-a"), second = await openSecret(sealed, "tenant-b");
  assert.notDeepEqual(first, second, "decrypt responses must never be cached");
  assert.equal(new Set(clients).size, 1);
  assert.deepEqual(contexts, [{ organizationId: "tenant-a" }, { organizationId: "tenant-a" }, { organizationId: "tenant-b" }]);
  process.env.AWS_REGION = "us-west-2";
  await openSecret(sealed, "tenant-a");
  assert.notEqual(clients[3], clients[0]);
  process.env.AWS_SESSION_TOKEN = "test-session";
  await openSecret(sealed, "tenant-a");
  assert.notEqual(clients[4], clients[3]);
  delete process.env.KMS_KEY_ID;
  delete process.env.INTEGRATION_ENCRYPTION_KEY;
  await assert.rejects(() => sealSecret({ token: "synthetic" }, "tenant-a"), /Configure/);
});

test("S3 reuses configured clients without caching bytes or bypassing missing configuration and file tenancy", async t => {
  environment(t, { DATABASE_URL: "", ADMITFLOW_DB: ":memory:", R2_ACCOUNT_ID: "test-account", R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", R2_BUCKET: "test-bucket" });
  const workspace = hydrateWorkspace(createWorkspace(false));
  const id = uid();
  workspace.files!.push({ id, name: "test.txt", mime: "text/plain", size: 4, purpose: "knowledge", status: "ready", createdAt: isoNow(), objectKey: `${workspace.id}/files/${id}/test.txt`, etag: "test-etag" });
  saveNewWorkspace(workspace);
  const clients: S3Client[] = [], commands: GetObjectCommand[] = [];
  t.mock.method(S3Client.prototype, "send", async function(this: S3Client, command: GetObjectCommand) {
    clients.push(this); commands.push(command);
    return { ContentLength: 4, ContentType: "text/plain", Body: { transformToWebStream: () => new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("text")); controller.close(); } }) } };
  });
  await readFileBytes(workspace.id, id); await readFileBytes(workspace.id, id);
  assert.equal(clients.length, 2); assert.equal(clients[0], clients[1]);
  assert.ok(commands.every(command => command.input.Key?.startsWith(`${workspace.id}/`) && command.input.IfMatch === "test-etag"));
  process.env.R2_SECRET_ACCESS_KEY = "rotated-test-secret";
  await readFileBytes(workspace.id, id); assert.notEqual(clients[2], clients[1]);
  delete process.env.R2_BUCKET;
  await assert.rejects(() => readFileBytes(workspace.id, id), /Configure Cloudflare R2/);
  assert.equal(clients.length, 3);
  process.env.R2_BUCKET = "test-bucket";
  await readFileBytes(workspace.id, id); assert.notEqual(clients[3], clients[2]);
  const other = hydrateWorkspace(createWorkspace(false)); saveNewWorkspace(other);
  await assert.rejects(() => readFileBytes(other.id, id), /File not found/);
  assert.equal(clients.length, 4);
});

test("SSE default heartbeat is 15s, quiet membership is 30s, revisions recheck immediately and errors close", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const abort = new AbortController(); t.after(() => abort.abort());
  let revision = 1, checks = 0, fail = false;
  const reader = workspaceEventStream({ workspaceId: "tenant", initialRevision: 1, signal: abort.signal, readRevision: async () => revision, validateMembership: async () => { checks++; if (fail) throw new Error("test outage"); return true; } }).getReader();
  await reader.read();
  const advance = async (ticks: number) => { for (let i = 0; i < ticks; i++) { t.mock.timers.tick(5000); await nextTurn(); } };
  let pending = reader.read();
  await advance(3);
  assert.match(new TextDecoder().decode((await pending).value), /heartbeat/); assert.equal(checks, 0);
  pending = reader.read(); await advance(3);
  assert.match(new TextDecoder().decode((await pending).value), /heartbeat/); assert.equal(checks, 1);
  revision = 2; pending = reader.read(); await advance(1);
  assert.match(new TextDecoder().decode((await pending).value), /id: 2/); assert.equal(checks, 2);
  revision = 3; fail = true; pending = reader.read(); await advance(1);
  assert.equal((await pending).done, true); assert.equal(checks, 3);
});

test("overview catalog cache and missing chunk backfill remain bounded and tenant-safe", async t => {
  environment(t, { DATABASE_URL: "postgresql://injected-pglite-only", KNOWLEDGE_VECTOR_ENABLED: "false", BILLING_RAZORPAY_KEY_ID: "rzp_test_performance", BILLING_RAZORPAY_KEY_SECRET: "synthetic", BILLING_RAZORPAY_ACCOUNT_ID: "acc_test", BILLING_RAZORPAY_WEBHOOK_SECRET: "synthetic" });
  const pg = new PGlite();
  const queries: { query: string; params: unknown[] }[] = [];
  t.after(async () => { await closeDatabase(); await pg.close(); });
  for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
  const db = drizzle(pg, { schema, logger: { logQuery(query, params) { queries.push({ query, params }); } } });
  useTestDatabase(db as unknown as Database);
  const workspace = hydrateWorkspace(createWorkspace(false)), other = hydrateWorkspace(createWorkspace(false));
  workspace.articles = Array.from({ length: 6 }, (_, index) => ({ id: uid(), title: `Fees ${index}`, category: "Courses", body: "Fees scholarship counselling. ".repeat(1800), updatedAt: isoNow(), version: 1 }));
  await createPostgresWorkspace(workspace, "org_performance");
  await createPostgresWorkspace(other, "org_performance_other");

  await t.test("one backfill transaction uses ordered locks and bounded inserts; stale snapshots cannot undo edits", async () => {
    await tenantTransaction(workspace.id, tx => tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, workspace.id)));
    const edited = { ...workspace.articles[0], title: "Current fees", body: "Current scholarship fees", version: 2 };
    await tenantTransaction(workspace.id, tx => tx.update(schema.articles).set(edited).where(eq(schema.articles.id, edited.id)));
    const start = queries.length;
    await retrieveKnowledge(workspace, "fees");
    const backfill = queries.slice(start);
    const articleLock = backfill.findIndex(row => /from "articles"/.test(row.query) && /for update/.test(row.query));
    assert.ok(articleLock > 0);
    assert.match(backfill[articleLock].query, /order by "articles"\."id"/);
    assert.ok(backfill.slice(articleLock + 1).some(row => /select distinct/.test(row.query) && /knowledge_chunks/.test(row.query)), "check existence after acquiring locks");
    const inserts = backfill.filter(row => /insert into "knowledge_chunks"/.test(row.query));
    assert.ok(inserts.length >= 2);
    assert.ok(inserts.every(row => (row.query.match(/\), \(/g)?.length || 0) + 1 <= 100));
    assert.equal(backfill.filter(row => /set_config/.test(row.query)).length, 2, "one backfill and one full-text transaction, not per article");
    const chunks = await tenantTransaction(workspace.id, tx => tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, workspace.id)));
    assert.equal(chunks.length, [edited, ...workspace.articles.slice(1)].reduce((sum, article) => sum + articleChunks(article).length, 0));
    assert.ok(chunks.filter(chunk => chunk.articleId === edited.id).every(chunk => chunk.title === edited.title && chunk.version === 2));
    const ids = chunks.map(chunk => chunk.id).sort();
    await Promise.all([retrieveKnowledge(workspace, "fees"), retrieveKnowledge(workspace, "scholarship")]);
    const after = await tenantTransaction(workspace.id, tx => tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, workspace.id)));
    assert.deepEqual(after.map(chunk => chunk.id).sort(), ids);
    await tenantTransaction(workspace.id, tx => tx.delete(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, workspace.id)));
    await Promise.all([retrieveKnowledge(workspace, "fees"), retrieveKnowledge(workspace, "scholarship")]);
    const concurrent = await tenantTransaction(workspace.id, tx => tx.select().from(schema.knowledgeChunks).where(eq(schema.knowledgeChunks.organizationId, workspace.id)));
    assert.equal(concurrent.length, chunks.length);
    assert.equal(new Set(concurrent.map(chunk => `${chunk.articleId}:${chunk.ordinal}`)).size, concurrent.length);
    assert.deepEqual((await retrieveKnowledge(other, "fees")).sources, []);
  });

  await t.test("overview shares successful/inflight reads, expires strictly, evicts failures, resets configuration, and checkout stays fresh", async t => {
    const plan = { id: "institute", name: "Institute", razorpayPlanId: "plan_Performance", totalCount: 12 };
    environment(t, { BILLING_PLANS_JSON: JSON.stringify([plan]) });
    let calls = 0, now = Date.now(), fail = false, invalid = false;
    t.mock.method(Date, "now", () => now);
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined = new Promise(resolve => { release = resolve; });
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      assert.match(String(url), /^https:\/\/api\.razorpay\.com\/v1\/plans\/plan_/);
      calls++; if (gate) await gate;
      if (fail) return new Response("", { status: 503 });
      return Response.json({ id: invalid ? "plan_Wrong" : String(url).split("/").at(-1), period: "monthly", interval: 1, item: { amount: 10000, currency: "INR" } });
    });
    const first = billingOverview(workspace), second = billingOverview(other);
    assert.equal(calls, 1); release!(); gate = undefined;
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 1); assert.deepEqual(a.plans, b.plans);
    a.plans[0].amount = 1; a.plans[0].limits.leads = 1;
    assert.equal((await billingOverview(workspace)).plans[0].amount, 10000);
    assert.equal((await billingOverview(workspace)).plans[0].limits.leads, null);
    now += 299999; await billingOverview(workspace); assert.equal(calls, 1);
    now++; fail = true;
    await assert.rejects(() => billingOverview(workspace)); assert.equal(calls, 2);
    fail = false; await billingOverview(workspace); assert.equal(calls, 3);
    await assert.rejects(() => createBillingCheckout(uid(), plan.id, uid()), /Live billing is not available/);
    assert.equal(calls, 4, "checkout always refetches even during overview TTL");
    for (const [key, value] of Object.entries({ BILLING_RAZORPAY_ACCOUNT_ID: "acc_rotated", BILLING_RAZORPAY_KEY_SECRET: "rotated", BILLING_RAZORPAY_KEY_ID: "rzp_test_rotated", BILLING_PLANS_JSON: JSON.stringify([{ ...plan, name: "Renamed" }]) })) {
      const before: number = calls; process.env[key] = value; await billingOverview(workspace); assert.equal(calls, before + 1);
    }
    const beforeMissing = calls;
    delete process.env.BILLING_RAZORPAY_KEY_SECRET;
    assert.equal((await billingOverview(workspace)).mode, "setup"); assert.equal(calls, beforeMissing);
    process.env.BILLING_RAZORPAY_KEY_SECRET = "rotated"; invalid = true;
    await assert.rejects(() => billingOverview(workspace), /could not be verified/);
    invalid = false; await billingOverview(workspace); assert.equal(calls, beforeMissing + 2);
    process.env.BILLING_PLANS_JSON = JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ ...plan, id: `plan-${index}`, razorpayPlanId: `plan_Test${index}` })));
    const beforeCatalog = calls; await billingOverview(workspace); await billingOverview(other); assert.equal(calls, beforeCatalog + 12);
    process.env.BILLING_PLANS_JSON = JSON.stringify([plan]); await billingOverview(workspace); assert.equal(calls, beforeCatalog + 13, "old catalog entries are invalidated, not accumulated");

    // An obsolete in-flight failure must not evict the replacement generation.
    let rejectOld: ((error: Error) => void) | undefined;
    let generationCalls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      generationCalls++;
      if (generationCalls === 1) await new Promise<void>((_resolve, reject) => { rejectOld = reject; });
      return Response.json({ id: plan.razorpayPlanId, period: "monthly", interval: 1, item: { amount: 20000, currency: "INR" } });
    });
    process.env.BILLING_RAZORPAY_ACCOUNT_ID = "acc_pending";
    const old = assert.rejects(() => billingOverview(workspace), /old generation failure/);
    process.env.BILLING_RAZORPAY_ACCOUNT_ID = "acc_replacement";
    assert.equal((await billingOverview(other)).plans[0].amount, 20000);
    rejectOld!(new Error("old generation failure")); await old;
    assert.equal((await billingOverview(workspace)).plans[0].amount, 20000);
    assert.equal(generationCalls, 2);

    // No subscription/entitlement result is included in this cache.
    await tenantTransaction(workspace.id, tx => tx.update(schema.organizations).set({ subscription: { status: "active", plan: plan.name, providerId: "sub_Performance", providerPlanId: plan.razorpayPlanId } }).where(eq(schema.organizations.id, workspace.id)));
    workspace.subscription = { status: "active", plan: plan.name, providerId: "sub_Performance" };
    let subscriptionReads = 0;
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      assert.match(String(url), /subscriptions\/sub_Performance$/);
      subscriptionReads++;
      return Response.json({ id: "sub_Performance", plan_id: plan.razorpayPlanId, status: "active", current_end: Math.floor(Date.now() / 1000) + 3600, notes: { admitflow_product: "admitflow_saas", admitflow_workspace_id: workspace.id } });
    });
    await billingOverview(workspace); await billingOverview(workspace);
    assert.equal(subscriptionReads, 2);
  });
});
