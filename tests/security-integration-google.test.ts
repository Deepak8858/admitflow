import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { NextRequest } from "next/server";
import * as schema from "../src/lib/db/schema";
import * as errors from "../src/lib/errors";
import { createWorkspace } from "../src/lib/seed";
import { isoNow, uid, type Workspace } from "../src/lib/domain";

async function isolatedConnections(store: {
  loadWorkspace: (id: string) => Promise<Workspace>;
  mutateWorkspace: (id: string, action: (workspace: Workspace) => unknown) => Promise<unknown>;
}) {
  const filename = path.resolve("src/lib/connections.ts");
  const original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node22" });
  const module = { exports: {} };
  const overrides: Record<string, unknown> = {
    "./store": store,
    "./secrets": { openSecret: async () => ({ refreshToken: "synthetic-refresh-token" }), sealSecret: async () => "sealed" },
  };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
  );
  return module.exports as typeof import("../src/lib/connections");
}

async function isolatedGoogleCallback(overrides: Record<string, unknown>) {
  const filename = path.resolve("src/app/api/integrations/google/callback/route.ts");
  const original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node22" });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
  );
  return module.exports as typeof import("../src/app/api/integrations/google/callback/route");
}

async function isolatedGoogleStart(overrides: Record<string, unknown>) {
  const filename = path.resolve("src/app/api/integrations/google/start/route.ts");
  const original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node22" });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
  );
  return module.exports as typeof import("../src/app/api/integrations/google/start/route");
}

test("Google OAuth start rejects pending and uncertain revocation before creating an authorization request", async () => {
  const workspace = createWorkspace(false);
  workspace.connections = [{ id: uid(), service: "google", status: "error", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: { googleRevocation: "pending" } }];
  let authorizations = 0;
  const start = await isolatedGoogleStart({
    "@/lib/auth": { resolveWorkspace: async () => ({ workspaceId: workspace.id }), requireAdmin: () => undefined },
    "@/lib/api": { apiError: (error: { message: string; status: number }) => Response.json({ error: error.message }, { status: error.status }) },
    "@/lib/store": { loadWorkspace: async () => structuredClone(workspace) },
    "@/lib/http": { sameOrigin: () => true },
    "@/lib/errors": errors,
    "../oauth": { googleConfiguration: () => { authorizations++; throw new Error("OAuth must not start"); }, createGoogleState: () => { authorizations++; throw new Error("OAuth must not start"); } },
  });
  for (const state of ["pending", "uncertain"]) {
    workspace.connections[0].metadata.googleRevocation = state;
    const response = await start.GET(new NextRequest("http://localhost:3000/api/integrations/google/start"));
    assert.equal(response.status, 409);
    assert.equal(authorizations, 0);
  }
});

test("Google disconnect disables the connection before revoke and retains uncertain grants", async t => {
  const workspace = createWorkspace(false);
  workspace.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: { calendarId: "primary" } }];
  let stored = structuredClone(workspace);
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => {
      const next = structuredClone(stored);
      const result = action(next);
      stored = next;
      return { workspace: next, result };
    },
  });
  let status = 200;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(init?.body as string).get("token"), "synthetic-refresh-token");
    assert.equal(init?.redirect, "error");
    return new Response(null, { status });
  });

  status = 503;
  await assert.rejects(connections.disconnectConnection(workspace.id, "google"), { status: 503 });
  assert.equal(stored.connections?.[0].status, "error");
  assert.equal(stored.connections?.[0].secret, "sealed");
  assert.equal(stored.connections?.[0].metadata.googleRevocation, "uncertain");
  await assert.rejects(connections.saveConnection(workspace.id, "google", { refreshToken: "new-refresh-token" }, "google-account", "Calendar"), { status: 409 });

  status = 200;
  await connections.disconnectConnection(workspace.id, "google");
  assert.equal(stored.connections?.[0].status, "disconnected");
  assert.equal(stored.connections?.[0].secret, undefined);
  assert.deepEqual(stored.connections?.[0].metadata, {});
  const revoked = calls;
  await connections.disconnectConnection(workspace.id, "google");
  assert.equal(calls, revoked, "repeated disconnect must not call Google again");
});

test("Google's already-invalid token response still permits local disconnect", async t => {
  const workspace = createWorkspace(false);
  workspace.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: {} }];
  let stored = structuredClone(workspace);
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => {
      const next = structuredClone(stored);
      const result = action(next);
      stored = next;
      return { workspace: next, result };
    },
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "invalid_token" }, { status: 400 }));
  await connections.disconnectConnection(workspace.id, "google");
  assert.equal(stored.connections?.[0].status, "disconnected");
  assert.equal(stored.connections?.[0].secret, undefined);
});

test("Google disconnect disables an errored grant unless revocation is established", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "error", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: {} }];
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => ({ workspace: stored, result: action(stored) }),
  });
  let response: () => Response = () => Response.json({ error: "invalid_request" }, { status: 400 });
  t.mock.method(globalThis, "fetch", async () => response());
  for (const reply of [
    () => Response.json({ error: "invalid_request" }, { status: 400 }),
    () => new Response("unreadable", { status: 400 }),
    () => { throw new Error("network unavailable"); },
  ]) {
    response = reply;
    await assert.rejects(connections.disconnectConnection(stored.id, "google"), { status: 503 });
    assert.equal(stored.connections[0].status, "error");
    assert.equal(stored.connections[0].secret, "sealed");
    assert.equal(stored.connections[0].metadata.googleRevocation, "uncertain");
  }
  response = () => new Response(null, { status: 200 });
  await connections.disconnectConnection(stored.id, "google");
  assert.equal(stored.connections[0].secret, undefined);
  assert.equal(stored.connections[0].status, "disconnected");
});

test("a reconnect and a second disconnect cannot cross an in-flight Google revoke", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: { calendarId: "primary" } }];
  const old = structuredClone(stored.connections[0]);
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => {
      const next = structuredClone(stored);
      const result = action(next);
      Object.assign(stored, next);
      return { workspace: next, result };
    },
  });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; entered(); await proceed; return new Response(null, { status: 200 }); });
  const disconnect = connections.disconnectConnection(stored.id, "google");
  await started;
  assert.equal(stored.connections[0].status, "error", "the revoke fence commits before the external call");
  assert.equal(stored.connections[0].metadata.googleRevocation, "pending");
  assert.equal(connections.connectionFor(stored, "google"), undefined, "new calendar work cannot select the fenced grant");
  await assert.rejects(connections.credentials(stored, "google"), { status: 409 });
  await assert.rejects(connections.saveConnection(stored.id, "google", { refreshToken: "new-refresh-token" }, "google-account", "Calendar", {}, old), { status: 409 });
  await assert.rejects(connections.saveConnection(stored.id, "google", { refreshToken: "new-refresh-token" }, "google-account", "Calendar"), { status: 409 });
  await assert.rejects(connections.disconnectConnection(stored.id, "google"), { status: 409 });
  assert.equal(calls, 1);
  release();
  await disconnect;
  assert.equal(stored.connections[0].status, "disconnected");
  assert.equal(stored.connections[0].secret, undefined);
  assert.deepEqual(stored.connections[0].metadata, {});
  await connections.saveConnection(stored.id, "google", { refreshToken: "new-refresh-token" }, "google-account", "Calendar");
  assert.equal(stored.connections[0].status, "connected", "a deliberate reconnect after confirmed revocation is allowed");
});

test("an abandoned Google fence requires an explicit retry after the provider timeout", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "error", externalId: "google-account", label: "Calendar", updatedAt: new Date(Date.now() - 31_000).toISOString(), secret: "sealed", metadata: { googleRevocation: "pending" } }];
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => ({ workspace: stored, result: action(stored) }),
  });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 200 }); });
  assert.equal(calls, 0, "loading a stranded fence never replays the external call");
  await connections.disconnectConnection(stored.id, "google");
  assert.equal(calls, 1);
  assert.equal(stored.connections[0].status, "disconnected");
});

test("a Google reconnect committed before the fence prevents the external revoke", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "connected", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: {} }];
  let replaceBeforeFence = true;
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => {
      if (replaceBeforeFence) {
        replaceBeforeFence = false;
        stored.connections![0].secret = "new-sealed";
        stored.connections![0].updatedAt = new Date(Date.parse(stored.connections![0].updatedAt) + 1).toISOString();
      }
      const next = structuredClone(stored);
      const result = action(next);
      Object.assign(stored, next);
      return { workspace: next, result };
    },
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No revoke should be sent"); });
  await assert.rejects(connections.disconnectConnection(stored.id, "google"), { status: 409 });
  assert.equal(stored.connections[0].status, "connected");
  assert.equal(stored.connections[0].secret, "new-sealed");
});

test("OAuth callback uses its pre-exchange version when revoke completes during code exchange", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "connected", externalId: "stable-google-subject", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: { calendarId: "primary" } }];
  let loads = 0;
  const store = {
    loadWorkspace: async () => { loads++; return structuredClone(stored); },
    mutateWorkspace: async (_id: string, action: (workspace: Workspace) => unknown) => ({ workspace: stored, result: action(stored) }),
  };
  const connections = await isolatedConnections(store);
  const context = { workspaceId: stored.id, actor: { id: "owner", role: "owner" } };
  const callback = await isolatedGoogleCallback({
    "@/lib/auth": { resolveWorkspace: async () => context, requireAdmin: () => undefined },
    "@/lib/config": { appUrl: () => "http://localhost:3000" },
    "@/lib/connections": connections,
    "@/lib/store": store,
    "@/lib/errors": errors,
    "../oauth": {
      googleConfiguration: () => ({ clientId: "test-client", clientSecret: "test-secret", redirectUri: "http://localhost:3000/api/integrations/google/callback" }),
      verifyGoogleState: () => "test-verifier",
      GOOGLE_SCOPES: ["https://www.googleapis.com/auth/calendar.events"],
      GOOGLE_STATE_COOKIE: "oauth-test",
      GOOGLE_STATE_PATH: "/api/integrations/google",
    },
  });
  let revokes = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      assert.equal(loads, 1, "the callback snapshots its connection before code exchange");
      await connections.disconnectConnection(stored.id, "google");
      return Response.json({ access_token: "new-access-token", refresh_token: "new-refresh-token" });
    }
    if (url === "https://oauth2.googleapis.com/revoke") { revokes++; return new Response(null, { status: 200 }); }
    if (url === "https://openidconnect.googleapis.com/v1/userinfo") return Response.json({ sub: "stable-google-subject", email: "owner@example.com" });
    throw new Error("Unexpected provider call");
  });
  const response = await callback.GET(new NextRequest("http://localhost:3000/api/integrations/google/callback?state=test&code=test"));
  assert.equal(new URL(response.headers.get("location")!).searchParams.get("google"), "error");
  assert.equal(revokes, 1);
  assert.equal(stored.connections[0].status, "disconnected");
  assert.equal(stored.connections[0].secret, undefined, "the token minted during exchange is never saved");
});

test("Google disconnect cannot delete a connection created after an empty snapshot", async t => {
  const stored = createWorkspace(false);
  stored.connections = [];
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => {
      stored.connections!.push({ id: uid(), service: "google", status: "connected", externalId: "new-account", label: "Calendar", updatedAt: isoNow(), secret: "new-sealed", metadata: {} });
      return action(stored);
    },
  });
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No provider call expected"); });
  await assert.rejects(connections.disconnectConnection(stored.id, "google"), { status: 409 });
  assert.equal(stored.connections[0].secret, "new-sealed");
});

test("the deployed schema cannot bind one Google account to two institutes", async () => {
  const pg = new PGlite();
  try {
    for (const file of (await readdir("drizzle")).filter(file => file.endsWith(".sql")).sort()) await pg.exec(await readFile(`drizzle/${file}`, "utf8"));
    const db = drizzle(pg, { schema });
    const first = createWorkspace(false), second = createWorkspace(false);
    for (const workspace of [first, second]) {
      await db.insert(schema.organizations).values({ id: workspace.id, name: "Institute", ownerName: "Owner", demo: false, sequence: workspace.sequence, ai: workspace.ai!, subscription: workspace.subscription! });
    }
    const connected = { service: "google" as const, status: "connected", externalId: "same-google-subject", label: "Calendar", updatedAt: isoNow(), metadata: { calendarId: "primary" }, secret: "encrypted-test-value" };
    await db.insert(schema.connections).values({ ...connected, id: uid(), organizationId: first.id });
    await assert.rejects(() => db.insert(schema.connections).values({ ...connected, id: uid(), organizationId: second.id }), error => {
      assert.match(String((error as { cause?: Error }).cause), /connections_external/);
      return true;
    });
    assert.equal((await db.select().from(schema.connections)).length, 1);
  } finally { await pg.close(); }
});
