import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import * as schema from "../src/lib/db/schema";
import { whatsappSubscriptionOperations as operations } from "../src/lib/db/whatsapp-schema";
import { useTestDatabase, closeDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, tenantTransaction } from "../src/lib/db/repository";
import { createWorkspace } from "../src/lib/seed";
import { uid, type Workspace } from "../src/lib/domain";
import { setupWhatsApp, reconcileWhatsApp } from "../src/lib/whatsapp-setup";
import { credentials, disconnectConnection } from "../src/lib/connections";
import { processMetaPayload } from "../src/lib/providers/meta";
import * as auth from "../src/lib/auth";
import { claimAccess, releaseAccess } from "../src/lib/db/team-access";

async function isolated<T>(file: string, overrides: Record<string, unknown> = {}): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports);
  return module.exports as T;
}
function barrier() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  return { entered, release, pause: async () => { enter(); await waiting; } };
}

test("durable WhatsApp setup never replays uncertain writes and fences readiness", { timeout: 120_000 }, async t => {
  const env = { DATABASE_URL: "postgresql://injected-pglite-only", APP_BASE_URL: "", INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), KMS_KEY_ID: "", META_APP_ID: "321", NEXT_PUBLIC_META_APP_ID: "321", META_APP_SECRET: "test-only", BILLING_PLANS_JSON: "" };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const pg = new PGlite();
  let postCount = 0, graphCount = 0, serial = 500;
  const numbers = new Map<string, string>(), subscribed = new Set<string>();
  let onPost: (() => Promise<Response>) | undefined, onGet: (() => Promise<Response | undefined>) | undefined, onVerify: (() => Promise<void>) | undefined;
  let wrongApp = false, missingScopes = false;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.hostname, "graph.facebook.com", "unexpected offline network call"); graphCount++;
    const waba = url.pathname.split("/").at(-2)!;
    if (url.pathname.endsWith("/oauth/access_token")) return Response.json({ access_token: "test-only-token" });
    if (url.pathname.endsWith("/debug_token")) {
      const hook = onVerify; onVerify = undefined; await hook?.();
      return Response.json({ data: { is_valid: true, app_id: wrongApp ? "999" : "321", scopes: missingScopes ? [] : ["whatsapp_business_management", "whatsapp_business_messaging"] } });
    }
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: numbers.get(waba), display_phone_number: "+919876543210", verified_name: "Test institute" }] });
    if (url.pathname.endsWith("/subscribed_apps")) {
      if (init?.method === "POST") {
        postCount++;
        const hook = onPost; onPost = undefined;
        if (hook) return hook();
        subscribed.add(waba); return Response.json({ success: true });
      }
      const hook = onGet; onGet = undefined;
      const result = await hook?.();
      return result || Response.json({ data: subscribed.has(waba) ? [{ whatsapp_business_api_data: { id: "321", name: "Test app" } }] : [] });
    }
    throw new Error("Unexpected mocked Meta request");
  });
  try {
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema: { ...schema, operations } }); useTestDatabase(db as unknown as Database);
    async function fixture() {
      const workspace = createWorkspace(false), identity = uid();
      const actor: NonNullable<Workspace["actor"]> = { id: `user_${identity}`, memberId: `om_${identity}`, name: "Owner", email: "owner@example.com", role: "owner", backend: "workos" };
      workspace.members = [{ id: actor.memberId!, workosId: actor.id, name: actor.name, email: actor.email, role: "owner", status: "active" }];
      await createPostgresWorkspace(workspace, `org_${identity}`);
      const input = { phoneNumberId: String(++serial), wabaId: String(++serial), accessToken: "test-only-token" };
      numbers.set(input.wabaId, input.phoneNumberId);
      const context = { workspaceId: workspace.id, workosOrganizationId: `org_${identity}`, actor };
      const refresh = async () => context;
      const current = () => loadPostgresWorkspace(workspace.id);
      const operation = async () => (await db.select().from(operations).where(eq(operations.organizationId, workspace.id)))[0]!;
      const connection = async () => (await current()).connections!.find(item => item.service === "whatsapp")!;
      const run = async () => setupWhatsApp(await current(), context, input, refresh);
      const reconcile = async () => reconcileWhatsApp(await current(), context, input, refresh);
      const disconnect = () => disconnectConnection(workspace.id, "whatsapp");
      const route = await isolated<typeof import("../src/app/api/connections/route")>("src/app/api/connections/route.ts", { "@/lib/auth": { ...auth, resolveWorkspace: refresh } });
      const post = (action: Record<string, unknown>) => route.POST(new NextRequest("http://127.0.0.1:3000/api/connections", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify(action) }));
      const payload = { entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: input.phoneNumberId }, messages: [{ id: `msg_${uid()}`, from: "919876543210", type: "text", text: { body: "Hello" } }] } }] }] };
      return { workspace, context, input, refresh, current, operation, connection, run, reconcile, disconnect, route, post, payload };
    }
    await t.test("manual and Embedded Signup routes share one permanent dispatch record", async () => {
      const f = await fixture(), before = postCount;
      assert.equal((await f.post({ service: "whatsapp", externalId: f.input.phoneNumberId, metadata: { wabaId: f.input.wabaId }, secret: { accessToken: f.input.accessToken } })).status, 200);
      assert.equal(postCount, before + 1); const original = await f.operation(); assert.ok(original.confirmedAt);
      await f.disconnect();
      assert.equal((await f.post({ type: "whatsapp.exchange", code: "test-code", phoneNumberId: f.input.phoneNumberId, wabaId: f.input.wabaId, coexistence: false })).status, 200);
      assert.equal(postCount, before + 1); assert.equal((await f.operation()).id, original.id); assert.equal((await f.connection()).status, "connected");
      await f.disconnect(); assert.equal((await f.connection()).secret, undefined);
      assert.deepEqual((await f.connection()).metadata, { wabaId: f.input.wabaId });
    });
    await t.test("absent-row disconnect during verification prevents any reservation or POST", async () => {
      const f = await fixture(), before = postCount, gate = barrier(); onVerify = gate.pause;
      const pending = f.run(); await gate.entered; await f.disconnect(); gate.release();
      await assert.rejects(() => pending, /workspace changed/); assert.equal(postCount, before); assert.equal(await f.operation(), undefined);
    });
    await t.test("concurrent first setup has one winner and one POST", async () => {
      const f = await fixture(), before = postCount, gate = barrier(); onVerify = gate.pause;
      const first = f.run(); await gate.entered; assert.equal((await f.run()).connected, true); gate.release();
      await assert.rejects(() => first, /workspace changed|binding/); assert.equal(postCount, before + 1);
    });
    await t.test("disconnect before the dispatch claim prevents POST", async () => {
      const f = await fixture(), before = postCount, gate = barrier(); onGet = async () => { await gate.pause(); return undefined; };
      const pending = f.run(); await gate.entered; await f.disconnect(); gate.release();
      await assert.rejects(() => pending, /disconnected/); assert.equal(postCount, before); assert.equal((await f.operation()).dispatchedAt, null);
    });
    await t.test("pending callback is retryable before and during POST and cannot automate", async () => {
      const f = await fixture(), gate = barrier(); onGet = async () => { await gate.pause(); return undefined; };
      const pending = f.run(); await gate.entered;
      await assert.rejects(() => processMetaPayload(f.payload, true), { status: 503 });
      await assert.rejects(async () => credentials(await f.current(), "whatsapp"), { status: 409 });
      onPost = async () => {
        await assert.rejects(() => processMetaPayload(f.payload, true), { status: 503 });
        const snapshot = await f.current(); assert.equal(snapshot.messages.length, 0); assert.equal(snapshot.jobs.length, 0);
        return Response.json({ success: true });
      };
      gate.release(); assert.equal((await pending).connected, true);
      await processMetaPayload(f.payload, true); assert.equal((await f.current()).messages.length, 1);
    });
    await t.test("disconnect after POST preserves positive evidence but cannot activate", async () => {
      const f = await fixture(), before = postCount, gate = barrier(); onPost = async () => { subscribed.add(f.input.wabaId); await gate.pause(); return Response.json({ success: true }); };
      const pending = f.run(); await gate.entered; await f.disconnect(); gate.release();
      await assert.rejects(() => pending, /disconnected/);
      const operation = await f.operation(); assert.ok(operation.dispatchedAt); assert.ok(operation.confirmedAt);
      assert.equal((await f.connection()).status, "disconnected"); assert.equal((await f.connection()).secret, undefined);
      await processMetaPayload(f.payload, true); assert.equal((await f.current()).messages.length, 0);
      const checked = await f.reconcile(); assert.equal(checked.present, true); assert.equal((await f.connection()).status, "disconnected");
      assert.equal((await f.run()).connected, true); assert.equal(postCount, before + 1);
    });
    await t.test("stale acknowledgement cannot clear a newer disconnected generation's pending route", async () => {
      const f = await fixture(), before = postCount, gate = barrier();
      onPost = async () => { await gate.pause(); subscribed.add(f.input.wabaId); return Response.json({ success: true }); };
      const first = f.run(); await gate.entered;
      assert.equal((await f.run()).connected, false); await f.disconnect(); const newer = await f.connection(); gate.release();
      await assert.rejects(() => first, /disconnected/);
      assert.ok((await f.operation()).confirmedAt); assert.equal((await f.connection()).metadata.setupGeneration, newer.metadata.setupGeneration);
      await assert.rejects(() => processMetaPayload(f.payload, true), { status: 503 });
      assert.equal((await f.reconcile()).present, true); assert.equal((await f.connection()).status, "disconnected");
      await processMetaPayload(f.payload, true); assert.equal((await f.current()).messages.length, 0); assert.equal(postCount, before + 1);
    });
    await t.test("lost response, fresh module and repeated absence never permit replay", async () => {
      const f = await fixture(), before = postCount; onPost = async () => { throw new TypeError("private diagnostic"); };
      assert.equal((await f.run()).connected, false); const original = await f.operation();
      assert.ok(original.dispatchedAt); assert.equal(original.confirmedAt, null);
      const restarted = await isolated<typeof import("../src/lib/whatsapp-setup")>("src/lib/whatsapp-setup.ts");
      assert.equal((await restarted.setupWhatsApp(await f.current(), f.context, f.input, f.refresh)).connected, false);
      for (let i = 0; i < 2; i++) assert.equal((await f.reconcile()).present, false);
      assert.equal(postCount, before + 1); assert.equal((await f.operation()).dispatchedAt, original.dispatchedAt);
      subscribed.add(f.input.wabaId); await f.disconnect(); assert.equal((await f.reconcile()).present, true);
      assert.equal((await f.operation()).confirmedAt, null); assert.ok((await f.operation()).observedAt);
      assert.equal((await f.connection()).secret, undefined); assert.equal((await f.run()).connected, true); assert.equal(postCount, before + 1);
    });
    await t.test("failed activation retains acknowledgement and recovers without another POST", async () => {
      const f = await fixture(), before = postCount;
      await pg.exec(`CREATE FUNCTION test_fail_whatsapp_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.service = 'whatsapp' AND NEW.status = 'connected' THEN RAISE EXCEPTION 'synthetic activation persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_fail_whatsapp_activation BEFORE INSERT OR UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION test_fail_whatsapp_activation();`);
      try { await assert.rejects(f.run); }
      finally { await pg.exec("DROP TRIGGER test_fail_whatsapp_activation ON connections; DROP FUNCTION test_fail_whatsapp_activation();"); }
      const operation = await f.operation(); assert.ok(operation.confirmedAt); assert.ok(operation.dispatchGeneration);
      assert.equal((await f.connection()).status, "unverified"); assert.equal((await f.run()).connected, true); assert.equal(postCount, before + 1);
    });
    await t.test("explicit negative POST response stays permanently non-replayable", async () => {
      const f = await fixture(), before = postCount; onPost = async () => Response.json({ success: false });
      assert.equal((await f.run()).connected, false); await f.disconnect();
      await assert.rejects(() => processMetaPayload(f.payload, true), { status: 503 });
      assert.equal((await f.run()).connected, false); assert.equal(postCount, before + 1);
    });
    await t.test("malformed/incomplete subscription reads never infer safe dispatch", async () => {
      for (const response of [{ data: [{ id: "321" }] }, { data: [], paging: { next: "https://graph.facebook.com/next" } }, { error: "private diagnostic" }]) {
        const f = await fixture(), before = postCount; onGet = async () => Response.json(response);
        assert.equal((await f.run()).connected, false); assert.equal(postCount, before); assert.equal((await f.operation()).dispatchedAt, null);
      }
    });
    await t.test("revoked admin and changed team fence fail before subscription POST", async () => {
      const f = await fixture(), before = postCount;
      const snapshot = await f.current();
      await assert.rejects(() => setupWhatsApp(snapshot, f.context, f.input, async () => ({ ...f.context, actor: { ...f.context.actor, role: "analyst" } })), { status: 403 });
      let fence: Awaited<ReturnType<typeof claimAccess>> | undefined;
      await assert.rejects(() => setupWhatsApp(snapshot, f.context, f.input, async () => { fence = await claimAccess(f.workspace.id, f.context.workosOrganizationId); return f.context; }), { status: 409 });
      if (fence) await releaseAccess(fence);
      assert.equal(postCount, before); assert.equal(await f.operation(), undefined);
    });
    await t.test("wrong app, missing scopes, local setup and competing tenant accounts cannot dispatch", async () => {
      const f = await fixture(), before = postCount;
      wrongApp = true; await assert.rejects(f.run, { status: 422 }); wrongApp = false;
      missingScopes = true; await assert.rejects(f.run, { status: 422 }); missingScopes = false;
      const networkBefore = graphCount;
      await assert.rejects(async () => setupWhatsApp(await f.current(), { ...f.context, actor: { ...f.context.actor, backend: "local" } }, f.input, f.refresh), { status: 503 });
      assert.equal(graphCount, networkBefore);
      await f.run(); const other = await fixture();
      await assert.rejects(async () => setupWhatsApp(await other.current(), other.context, f.input, other.refresh));
      assert.equal(postCount, before + 1); assert.equal(await other.operation(), undefined);
    });
    await t.test("database protects immutable identity, dispatch and positive evidence; tenant deletion cascades", async () => {
      const f = await fixture(); await f.run(); const operation = await f.operation();
      for (const change of [{ dispatchedAt: null }, { dispatchGeneration: uid() }, { confirmedAt: null }, { wabaId: "999" }, { appId: "999" }, { generation: uid() }]) await assert.rejects(() => db.update(operations).set(change).where(eq(operations.id, operation.id)));
      const other = await fixture();
      await assert.rejects(() => db.insert(operations).values({ ...operation, id: uid(), organizationId: other.workspace.id, wabaId: other.input.wabaId }));
      await assert.rejects(() => db.delete(operations).where(eq(operations.id, operation.id)));
      await assert.rejects(() => db.update(schema.connections).set({ metadata: { wabaId: "999" } }).where(eq(schema.connections.id, operation.connectionId)));
      const rls = await db.execute(sql`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'whatsapp_subscription_operations'`);
      assert.equal(rls.rows[0].relrowsecurity, true); assert.equal(rls.rows[0].relforcerowsecurity, true);
      await pg.exec("CREATE ROLE whatsapp_evidence_reader; GRANT SELECT ON whatsapp_subscription_operations TO whatsapp_evidence_reader;");
      await tenantTransaction(f.workspace.id, async tx => {
        await tx.execute(sql`set local role whatsapp_evidence_reader`);
        assert.equal((await tx.select().from(operations)).length, 1);
      });
      await tenantTransaction(other.workspace.id, async tx => {
        await tx.execute(sql`set local role whatsapp_evidence_reader`);
        assert.equal((await tx.select().from(operations)).length, 0);
      });
      await db.delete(schema.organizations).where(eq(schema.organizations.id, f.workspace.id)); assert.equal(await f.operation(), undefined);
    });
  } finally {
    await closeDatabase(); await pg.close();
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
