import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
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

test("Google disconnect revokes the grant before deleting credentials", async t => {
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
  let onRevoke: (() => void) | undefined;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls++;
    assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers && (init.headers as Record<string, string>)["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(init?.body as string).get("token"), "synthetic-refresh-token");
    assert.equal(init?.redirect, "error");
    onRevoke?.();
    return new Response(null, { status });
  });

  status = 503;
  await assert.rejects(connections.disconnectConnection(workspace.id, "google"), { status: 503 });
  assert.equal(stored.connections?.[0].status, "connected");
  assert.equal(stored.connections?.[0].secret, "sealed");

  status = 200;
  onRevoke = () => { stored.connections![0].updatedAt = new Date(Date.now() + 1000).toISOString(); };
  await assert.rejects(connections.disconnectConnection(workspace.id, "google"), { status: 409 });
  assert.equal(stored.connections?.[0].status, "connected", "a concurrent connection change must remain intact");

  onRevoke = undefined;
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

test("Google disconnect retains an errored grant unless revocation is established", async t => {
  const stored = createWorkspace(false);
  stored.connections = [{ id: uid(), service: "google", status: "error", externalId: "google-account", label: "Calendar", updatedAt: isoNow(), secret: "sealed", metadata: {} }];
  const connections = await isolatedConnections({
    loadWorkspace: async () => structuredClone(stored),
    mutateWorkspace: async (_id, action) => action(stored),
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
    assert.equal(stored.connections[0].secret, "sealed");
  }
  response = () => new Response(null, { status: 200 });
  await connections.disconnectConnection(stored.id, "google");
  assert.equal(stored.connections[0].secret, undefined);
  assert.equal(stored.connections[0].status, "disconnected");
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
