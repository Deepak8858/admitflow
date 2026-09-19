import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../src/lib/db/schema";
import { useTestDatabase, closeDatabase, type Database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace, mutatePostgresWorkspace } from "../src/lib/db/repository";
import { acceptIntake, importIntake } from "../src/lib/db/intake";
import { credentials, saveConnection } from "../src/lib/connections";
import { integrationStatus } from "../src/lib/integrations";
import { createWorkspace } from "../src/lib/seed";
import { uid, isoNow, type Workspace } from "../src/lib/domain";
import * as auth from "../src/lib/auth";
import type { IntakePayload } from "../src/lib/intake-types";

async function isolatedModule<T>(file: string, overrides: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()((name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports);
  return module.exports as T;
}

test("real connection routes retain receipt bindings and require verified same-account recovery", { timeout: 120_000 }, async t => {
  const env = { DATABASE_URL: "postgresql://injected-pglite-only", APP_BASE_URL: "", INTEGRATION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"), KMS_KEY_ID: "", META_APP_ID: "321", NEXT_PUBLIC_META_APP_ID: "321", META_APP_SECRET: "test-only", OPENAI_API_KEY: "sk-test-only-platform-key", ELEVENLABS_API_KEY: "sk_test_only_platform_key", BILLING_PLANS_JSON: "" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const pg = new PGlite();
  let calls = 0, subscriptionPosts = 0, malformed = false, foreign = false;
  let onFetch: (() => Promise<void>) | undefined;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    await onFetch?.();
    const url = new URL(String(input));
    assert.ok(["graph.facebook.com", "api.openai.com", "api.elevenlabs.io", "api.razorpay.com"].includes(url.hostname), "unexpected test network target");
    if (malformed) return new Response("<html>private provider diagnostic</html>", { status: 200 });
    if (url.pathname.endsWith("/phone_numbers")) return Response.json({ data: [{ id: foreign ? "999" : "111", display_phone_number: "+919876543210", verified_name: "Institute" }] });
    if (url.pathname.endsWith("/oauth/access_token")) return Response.json({ access_token: "test-only-token" });
    if (url.pathname.endsWith("/debug_token")) return Response.json({ data: { is_valid: true, app_id: "321", scopes: ["leads_retrieval", "pages_manage_metadata"] } });
    if (url.pathname.endsWith("/me")) return Response.json({ id: foreign ? "999" : "333", name: "Institute" });
    if (url.pathname.endsWith("/leadgen_forms")) return Response.json({ data: [] });
    if (url.pathname.endsWith("/subscribed_apps")) {
      if (init?.method === "POST") subscriptionPosts++;
      return Response.json(init?.method === "POST" ? { success: true } : { data: [] });
    }
    if (url.hostname === "api.openai.com") return Response.json({ id: url.pathname.split("/").at(-1) });
    if (url.hostname === "api.elevenlabs.io") return Response.json({ user_id: "test-user" });
    if (url.hostname === "api.razorpay.com") return Response.json({ entity: "collection", items: [] });
    throw new Error("Unexpected offline provider operation");
  });
  try {
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema }); useTestDatabase(db as unknown as Database);
    const workspace = createWorkspace(false);
    workspace.members = [{ id: "om_connections", workosId: "user_connections", name: "Owner", email: "owner@example.com", role: "owner", status: "active" }];
    await createPostgresWorkspace(workspace, "org_connections");
    let actor: NonNullable<Workspace["actor"]> = { id: "user_connections", memberId: "om_connections", name: "Owner", email: "owner@example.com", role: "owner", backend: "workos" };
    const route = await isolatedModule<typeof import("../src/app/api/connections/route")>("src/app/api/connections/route.ts", { "@/lib/auth": { ...auth, resolveWorkspace: async () => ({ workspaceId: workspace.id, actor }) } });
    const post = (action: Record<string, unknown>) => route.POST(new NextRequest("http://127.0.0.1:3000/api/connections", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json" }, body: JSON.stringify(action) }));
    const current = () => loadPostgresWorkspace(workspace.id);
    const rows = () => db.select().from(schema.intakeInbox).where(eq(schema.intakeInbox.organizationId, workspace.id));
    const routes = () => db.select().from(schema.connectionRoutes).where(eq(schema.connectionRoutes.organizationId, workspace.id));

    for (const service of ["whatsapp", "meta_leads"] as const) await t.test(`${service}: disconnect and verified reconnect retain deferred and imported receipts`, async () => {
      const externalId = service === "whatsapp" ? "111" : "333";
      const action = { service, externalId, secret: { accessToken: "test-only-token" }, metadata: service === "whatsapp" ? { wabaId: "222" } : {} };
      assert.equal((await post(action)).status, 200);
      const connection = (await current()).connections!.find(item => item.service === service)!;
      assert.ok(connection.secret);
      const payload = (id: string): IntakePayload => service === "whatsapp" ? { service, event: { id, from: id === "444" ? "919876543210" : "919876543212", body: "Hello", verified: true } } : { service, event: { pageId: externalId, leadgenId: id }, form: { id, field_data: [{ name: "phone_number", values: [id === "444" ? "+919876543211" : "+919876543213"] }] } };
      await acceptIntake(workspace.id, connection.id, externalId, payload("444"));
      await mutatePostgresWorkspace(workspace.id, value => { value.subscription = { status: "cancelled", plan: "Ended" }; });
      await acceptIntake(workspace.id, connection.id, externalId, payload("555"));
      const before = (await rows()).filter(row => row.service === service);
      assert.deepEqual(before.map(row => row.state).sort(), ["deferred", "imported"]);
      assert.equal((await post({ type: "disconnect", service })).status, 200);
      assert.equal((await post({ type: "disconnect", service })).status, 200);
      const disconnected = (await current()).connections!.find(item => item.service === service)!;
      assert.equal(disconnected.id, connection.id); assert.equal(disconnected.externalId, externalId);
      assert.equal(disconnected.status, "disconnected"); assert.equal(disconnected.secret, undefined);
      assert.deepEqual(disconnected.metadata, service === "whatsapp" ? { wabaId: "222" } : {});
      assert.ok(!(await routes()).some(row => row.service === service));
      assert.deepEqual((await rows()).filter(row => row.service === service), before);
      await assert.rejects(() => credentials({ ...workspace, connections: [disconnected] }, service), /Connect/);
      await mutatePostgresWorkspace(workspace.id, value => { value.subscription = { status: "active", plan: "Paid", providerId: "sub_test", providerPlanId: "plan_test", providerStatus: "active", verifiedAt: isoNow(), currentPeriodEnd: new Date(Date.now() + 3600_000).toISOString() }; });
      assert.equal((await importIntake(workspace.id, actor)).result.blocked, 1);
      const networkBefore = calls;
      assert.equal((await post({ ...action, externalId: "999" })).status, 409);
      if (service === "whatsapp") {
        assert.equal((await post({ ...action, metadata: { wabaId: "999" } })).status, 409);
        assert.equal((await post({ type: "whatsapp.exchange", code: "test-code", wabaId: "999", phoneNumberId: externalId, coexistence: false })).status, 409);
      }
      assert.equal(calls, networkBefore, "foreign-account requests must be blocked before provider side effects");
      foreign = true;
      try { assert.equal((await post(action)).status, service === "whatsapp" ? 400 : 422); } finally { foreign = false; }
      assert.equal((await current()).connections!.find(item => item.service === service)!.status, "disconnected");
      assert.equal((await post(action)).status, 200);
      const restored = (await current()).connections!.find(item => item.service === service)!;
      assert.equal(restored.id, connection.id); assert.equal(restored.status, "connected"); assert.ok(restored.secret);
      assert.ok((await routes()).some(row => row.service === service && row.externalId === externalId));
      assert.equal((await importIntake(workspace.id, actor)).result.imported, 1);
      assert.ok((await rows()).filter(row => row.service === service).every(row => row.state === "imported" && row.connectionId === connection.id));
      assert.equal((await acceptIntake(workspace.id, connection.id, externalId, payload("555"))).result.duplicate, true);
    });

    await t.test("database rejects deletion, identity mutation, foreign bindings and secret-bearing tombstones", async () => {
      const receipt = (await rows()).find(row => row.service === "whatsapp")!, connection = (await current()).connections!.find(item => item.id === receipt.connectionId)!;
      await assert.rejects(() => db.delete(schema.connections).where(eq(schema.connections.id, connection.id)));
      await assert.rejects(() => db.update(schema.connections).set({ externalId: "999" }).where(eq(schema.connections.id, connection.id)));
      await assert.rejects(() => db.update(schema.connections).set({ status: "disconnected" }).where(eq(schema.connections.id, connection.id)));
      const other = createWorkspace(false); await createPostgresWorkspace(other, "org_connections_other");
      for (const change of [{ organizationId: other.id }, { connectionId: uid() }, { externalId: "999" }, { service: "meta_leads" as const }]) {
        await assert.rejects(() => db.insert(schema.intakeInbox).values({ ...receipt, id: uid(), ...change }));
      }
      assert.equal((await rows()).length, 4);
      await db.delete(schema.organizations).where(eq(schema.organizations.id, other.id));
    });

    await t.test("malformed successful provider verification is safe 502 without persistence", async () => {
      malformed = true;
      try {
        for (const action of [{ service: "openai", secret: { apiKey: "sk-test-only-provider-key" } }, { service: "elevenlabs", secret: { apiKey: "sk_test_only_provider_key" } }, { service: "razorpay", secret: { keyId: "rzp_test_12345678", keySecret: "test-only-secret-key" } }]) {
          const response = await post(action); assert.equal(response.status, 502);
          assert.ok(!(await response.text()).includes("private provider diagnostic"));
          assert.ok(!(await current()).connections!.some(item => item.service === action.service));
        }
      } finally { malformed = false; }
    });

    await t.test("explicit AI/speech disconnect disables platform fallback and advertised readiness", async () => {
      for (const service of ["openai", "elevenlabs"] as const) {
        assert.ok(await credentials(await current(), service));
        assert.equal((await post({ type: "disconnect", service })).status, 200);
        await assert.rejects(() => current().then(snapshot => credentials(snapshot, service)), /Connect/);
        await saveConnection(workspace.id, service, { apiKey: process.env[service === "openai" ? "OPENAI_API_KEY" : "ELEVENLABS_API_KEY"]! }, workspace.id, service);
        assert.equal((await post({ type: "disconnect", service })).status, 200);
        const snapshot = await current();
        await assert.rejects(() => credentials(snapshot, service), /Connect/);
        assert.equal(integrationStatus(snapshot)[service === "openai" ? "ai" : "speech"], false);
      }
    });

    await t.test("a disconnect during verification fences all stale reconnect branches", async () => {
      const scenarios = [
        { service: "whatsapp", action: { service: "whatsapp", externalId: "111", secret: { accessToken: "test-only-token" }, metadata: { wabaId: "222" } } },
        { service: "whatsapp", action: { type: "whatsapp.exchange", code: "test-only-code", phoneNumberId: "111", wabaId: "222", coexistence: false } },
        { service: "meta_leads", action: { service: "meta_leads", externalId: "333", secret: { accessToken: "test-only-token" } } },
        { service: "openai", action: { service: "openai", secret: { apiKey: "sk-test-only-provider-key" } } },
        { service: "elevenlabs", action: { service: "elevenlabs", secret: { apiKey: "sk_test_only_provider_key" } } },
        { service: "razorpay", action: { service: "razorpay", secret: { keyId: "rzp_test_12345678", keySecret: "test-only-secret-key" } } },
      ];
      for (const { service, action } of scenarios) {
        assert.equal((await post(action)).status, 200);
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
        onFetch = async () => { onFetch = undefined; entered(); await resume; };
        const writesBefore = subscriptionPosts;
        const stale = post(action);
        await waiting;
        let disconnected;
        try {
          assert.equal((await post({ type: "disconnect", service })).status, 200);
          disconnected = (await current()).connections!.find(item => item.service === service)!;
          assert.equal(disconnected.status, "disconnected");
        } finally { release(); }
        assert.equal((await stale).status, 409, service);
        assert.equal(subscriptionPosts, writesBefore, "stale verification must not dispatch a subscription write");
        assert.deepEqual((await current()).connections!.find(item => item.service === service), disconnected);
        assert.ok(!(await routes()).some(row => row.service === service));
        assert.equal((await post(action)).status, 200, "a new intentional reconnect may proceed");
      }
    });

    await t.test("disconnect during encryption is checked again inside the serialized save", async () => {
      const secrets = await import("../src/lib/secrets");
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
      const connections = await isolatedModule<typeof import("../src/lib/connections")>("src/lib/connections.ts", { "./secrets": { ...secrets, sealSecret: async (...args: Parameters<typeof secrets.sealSecret>) => { entered(); await resume; return secrets.sealSecret(...args); } } });
      const saving = connections.saveConnection(workspace.id, "whatsapp", { accessToken: "test-only-token" }, "111", "WhatsApp", { wabaId: "222" });
      await waiting;
      try { assert.equal((await post({ type: "disconnect", service: "whatsapp" })).status, 200); } finally { release(); }
      await assert.rejects(() => saving, /changed during verification/);
      assert.equal((await current()).connections!.find(item => item.service === "whatsapp")!.status, "disconnected");
    });

    await t.test("non-admin cannot disconnect and organization deletion retains existing cascade semantics", async () => {
      actor = { ...actor, role: "analyst" };
      assert.equal((await post({ type: "disconnect", service: "whatsapp" })).status, 403);
      await db.delete(schema.organizations).where(eq(schema.organizations.id, workspace.id));
      assert.equal((await rows()).length, 0); assert.equal((await routes()).length, 0);
    });
  } finally {
    await closeDatabase(); await pg.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
