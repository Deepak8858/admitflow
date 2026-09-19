import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { z } from "zod";
import { createWorkspace } from "../src/lib/seed";
import { AppError, safeErrorDiagnostic } from "../src/lib/errors";
import { SubscriptionRestricted } from "../src/lib/subscription-policy";
import { apiError } from "../src/lib/api";
import type { Workspace } from "../src/lib/domain";

type AuthRoute = typeof import("../src/app/api/auth/route");
type Store = typeof import("../src/lib/store");
type Outbox = typeof import("../src/lib/db/outbox");
type Queue = Parameters<Outbox["dispatchOutbox"]>[0];
const sensitive = "fixture-private-message-token-path";

/** As in team-access tests, substitute imports per module rather than patching global loaders. */
async function isolatedModule<T>(file: string, overrides: Record<string, unknown>, logs: unknown[][] = [], globals = globalThis): Promise<T> {
  const filename = path.resolve(file), original = createRequire(filename);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports,console,globalThis){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => Object.hasOwn(overrides, name) ? overrides[name] : original(name), module, module.exports,
    { error: (...args: unknown[]) => logs.push(args) }, globals,
  );
  return module.exports as T;
}
function request(body: unknown, cookie?: string, raw = false) {
  return new NextRequest("http://127.0.0.1/api/auth", { method: "POST", headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json", ...(cookie ? { cookie: `admitflow_session=${cookie}` } : {}) }, body: raw ? String(body) : JSON.stringify(body) });
}
async function authRoute(store: unknown, hosted: boolean, logs: unknown[][] = []) {
  const api = await isolatedModule<typeof import("../src/lib/api")>("src/lib/api.ts", {}, logs);
  return isolatedModule<AuthRoute>("src/app/api/auth/route.ts", { "@/lib/store": store, "@/lib/config": { productionDatabase: () => hosted }, "@/lib/api": api }, logs);
}

test("hosted auth rejects register, login and logout before SQLite, including existing cookies", async () => {
  let opened = 0;
  const local = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", {
    "node:sqlite": { DatabaseSync: class { constructor() { opened++; throw new Error(sensitive); } } },
  }, [], {} as typeof globalThis);
  const store = await isolatedModule<Store>("src/lib/store.ts", { "./local-store": local, "./config": { productionDatabase: () => true } });
  const route = await authRoute(store, true);
  for (const type of ["register", "login", "logout"]) for (const cookie of [undefined, "a".repeat(64)]) {
    const response = await route.POST(request({ type, email: "hosted@example.com", password: "password-long" }, cookie));
    assert.equal(response.status, 403); assert.equal(response.headers.get("set-cookie"), null);
    assert.match((await response.json()).error, /WorkOS/);
  }
  for (const operation of [() => store.createDemo(), () => store.register("test@example.com", "password-long", "Owner", "Test"), () => store.login("test@example.com", "password-long")]) {
    assert.throws(operation, (error: unknown) => error instanceof AppError && error.status === 403);
  }
  assert.equal(opened, 0);
});

test("local auth preserves expected errors, valid sessions and logout demo while corrupted storage stays generic", async t => {
  assert.equal(process.env.ADMITFLOW_DB, ":memory:", "Run through verificationEnvironment with isolated SQLite");
  assert.ok(!process.env.DATABASE_URL);
  const local = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", {}, [], {} as typeof globalThis);
  t.after(() => local.database().close());
  const store = await isolatedModule<Store>("src/lib/store.ts", { "./local-store": local, "./config": { productionDatabase: () => false } });
  const logs: unknown[][] = [], route = await authRoute(store, false, logs);
  const credentials = { email: "local@example.com", password: "password-long" };
  const registered = await route.POST(request({ type: "register", ...credentials }));
  assert.equal(registered.status, 200);
  const cookie = registered.cookies.get("admitflow_session")!;
  assert.ok(cookie.httpOnly); assert.equal(cookie.sameSite, "lax");
  const workspaceId = local.sessionWorkspace(cookie.value)!;
  assert.ok(workspaceId);
  const duplicate = await route.POST(request({ type: "register", ...credentials }));
  assert.equal(duplicate.status, 400); assert.match((await duplicate.json()).error, /already registered/);
  for (const email of [credentials.email, "missing@example.com"]) {
    const response = await route.POST(request({ type: "login", email, password: "wrong-password" }));
    assert.equal(response.status, 400); assert.equal((await response.json()).error, "Email or password did not match. Please try again.");
  }
  const signedIn = await route.POST(request({ type: "login", ...credentials }, cookie.value));
  assert.equal(signedIn.status, 200); assert.equal(local.sessionWorkspace(cookie.value), null);
  const activeCookie = signedIn.cookies.get("admitflow_session")!.value;
  local.database().prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(sensitive, workspaceId);
  const corrupted = await route.POST(request({ type: "login", ...credentials }));
  assert.equal(corrupted.status, 500);
  assert.ok(!(await corrupted.text()).includes(sensitive)); assert.ok(!JSON.stringify(logs).includes(sensitive));
  const logout = await route.POST(request({ type: "logout" }, activeCookie));
  assert.equal(logout.status, 200); assert.equal(local.sessionWorkspace(activeCookie), null);
  assert.ok(local.sessionWorkspace(logout.cookies.get("admitflow_session")!.value));
  const rateEmail = "rate@example.com";
  for (let n = 0; n < 10; n++) local.checkAuthRate(rateEmail);
  const limited = await route.POST(request({ type: "login", email: rateEmail, password: "password-long" }));
  assert.equal(limited.status, 400); assert.match((await limited.json()).error, /Too many sign-in attempts/);
  assert.throws(() => local.loadWorkspace("missing"), AppError);
});

test("request parse/validation errors remain 400 but unexpected auth execution failures are generic 500", async () => {
  let calls = 0;
  let failure: unknown = new Error(sensitive);
  const logs: unknown[][] = [];
  const fail = () => { calls++; throw failure; };
  const route = await authRoute({ checkAuthRate: fail, register: fail, login: fail, endSession: fail, createDemo: fail }, false, logs);
  for (const body of ["{", "null", "[]", '{}', '{"type":"login","email":"invalid","password":"short"}']) {
    assert.equal((await route.POST(request(body, undefined, true))).status, 400);
  }
  assert.equal(calls, 0);
  const badValidation = z.string().safeParse(123);
  for (failure of [Object.assign(new Error(sensitive), { name: sensitive }), new SyntaxError(sensitive), new TypeError(sensitive), badValidation.error, sensitive]) {
    const response = await route.POST(request({ type: "login", email: "test@example.com", password: "password-long" }));
    assert.equal(response.status, 500); assert.ok(!(await response.text()).includes(sensitive));
  }
  assert.ok(!JSON.stringify(logs).includes(sensitive));
});

function dispatchWorkspace(index: number): Workspace {
  const workspace = createWorkspace(false);
  workspace.id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  workspace.workosOrganizationId = `org_${index}`;
  workspace.messages = [];
  workspace.jobs = [{ id: `job-${index}`, leadId: "", campaignId: "", step: 0, status: "pending", dueAt: new Date(0).toISOString(), attempts: 2, retryGeneration: 3 }];
  return workspace;
}
async function dispatcher(workspaces: Workspace[], failureIndex: number, failureStage: "load" | "recover" | "enqueue") {
  const logs: unknown[][] = [], loaded: string[] = [], cursors: (string | undefined)[] = [], added: string[] = [];
  const bad = workspaces[failureIndex].id;
  if (failureStage === "recover") for (const workspace of workspaces) workspace.jobs[0].status = "processing";
  const routes = workspaces.map(workspace => ({ organizationId: workspace.id, workosId: workspace.workosOrganizationId }));
  const database = () => ({ select: () => ({ from: () => ({ where: (after?: string) => ({ orderBy: () => ({ limit: async (limit: number) => {
    cursors.push(after); assert.ok(cursors.length < 5, "cursor must progress even after failure");
    return routes.filter(route => !after || route.organizationId > after).slice(0, limit);
  } }) }) }) }) });
  const outbox = await isolatedModule<Outbox>("src/lib/db/outbox.ts", {
    "./client": { database }, "./schema": { organizationRoutes: { organizationId: "organizationId" } },
    "drizzle-orm": { asc: (value: unknown) => value, gt: (_column: unknown, after: string) => after },
    "../store": {
      loadWorkspace: async (id: string) => { loaded.push(id); if (id === bad && failureStage === "load") throw new SyntaxError(sensitive); return workspaces.find(workspace => workspace.id === id)!; },
      mutateWorkspace: async (id: string, action: (workspace: Workspace) => unknown) => {
        if (id === bad && failureStage === "recover") throw Object.assign(new Error(sensitive), { code: "ECONNRESET", name: sensitive });
        const workspace = workspaces.find(workspace => workspace.id === id)!; action(workspace); return { workspace };
      },
    },
    "../integrations": { JOB_LOCK_MS: 60_000, recoverWorkspaceJobs: (workspace: Workspace) => { workspace.jobs[0].status = "pending"; } },
  }, logs);
  const queue = { getJob: async () => undefined, add: async (_name: string, data: { workspaceId: string }) => {
    if (data.workspaceId === bad && failureStage === "enqueue") throw new AppError(sensitive, 503);
    added.push(data.workspaceId);
  } } as unknown as Queue;
  return { outbox, queue, logs, loaded, cursors, added };
}

test("tenant load, recovery and enqueue failures do not starve later tenants or pagination", async t => {
  for (const stage of ["load", "recover", "enqueue"] as const) for (const index of [0, 50, 99, 101]) await t.test(`${stage} failure at tenant ${index}`, async () => {
    const workspaces = Array.from({ length: 102 }, (_, i) => dispatchWorkspace(i));
    const f = await dispatcher(workspaces, index, stage);
    assert.deepEqual(await f.outbox.dispatchOutbox(f.queue), { organizations: 101, enqueued: 101, failed: 1 });
    assert.deepEqual(f.loaded, workspaces.map(workspace => workspace.id));
    assert.deepEqual(f.cursors, [undefined, workspaces[99].id]);
    assert.deepEqual(f.added, workspaces.filter((_workspace, i) => i !== index).map(workspace => workspace.id));
    assert.equal(f.logs.length, 1); assert.ok(!JSON.stringify(f.logs).includes(sensitive));
    assert.equal((f.logs[0][1] as { stage: string }).stage, stage);
  });
});

test("exact 100-route page advances after its last tenant fails and completes with empty next page", async () => {
  const workspaces = Array.from({ length: 100 }, (_, i) => dispatchWorkspace(i));
  const f = await dispatcher(workspaces, 99, "load");
  assert.deepEqual(await f.outbox.dispatchOutbox(f.queue), { organizations: 99, enqueued: 99, failed: 1 });
  assert.deepEqual(f.cursors, [undefined, workspaces[99].id]);
});

test("enqueue uncertainty preserves stable queue identity and does not repeat accepted work", async () => {
  const workspace = dispatchWorkspace(0), f = await dispatcher([workspace], 0, "load");
  const accepted = new Set<string>(), ids: string[] = [];
  const queue = {
    getJob: async (id: string) => accepted.has(id) ? { getState: async () => "waiting", remove: async () => assert.fail("Do not remove waiting work") } : undefined,
    add: async (_name: string, _data: unknown, options: { jobId: string }) => { ids.push(options.jobId); accepted.add(options.jobId); throw new Error(sensitive); },
  } as unknown as Queue;
  const before = structuredClone(workspace.jobs);
  await assert.rejects(() => f.outbox.enqueueWorkspaceJobs(queue, workspace));
  assert.equal(await f.outbox.enqueueWorkspaceJobs(queue, workspace), 0);
  assert.deepEqual(ids, [`${workspace.id}-${workspace.jobs[0].id}-3-2`]);
  assert.deepEqual(workspace.jobs, before, "Uncertain queue acknowledgement must not change durable state or retry generation");
  for (const status of ["processing", "reconcile", "accepted", "sent"] as const) {
    workspace.jobs[0].status = status;
    assert.equal(await f.outbox.enqueueWorkspaceJobs(queue, workspace), 0);
  }
});

test("enqueue keeps active locks and only removes terminal queue records before re-add", async () => {
  const workspace = dispatchWorkspace(0), f = await dispatcher([workspace], 0, "load");
  for (const state of ["active", "waiting", "delayed", "failed", "completed"]) {
    const calls: string[] = [];
    const queue = { getJob: async () => ({ getState: async () => state, remove: async () => { calls.push("remove"); } }), add: async () => { calls.push("add"); } } as unknown as Queue;
    const terminal = ["failed", "completed"].includes(state);
    assert.equal(await f.outbox.enqueueWorkspaceJobs(queue, workspace), terminal ? 1 : 0);
    assert.deepEqual(calls, terminal ? ["remove", "add"] : []);
  }
});

test("subscription verification preserves a private cause and logs only safe classifications", async () => {
  for (const cause of [new AppError(sensitive, 502, "SUBSCRIPTION_RESTRICTED"), Object.assign(new Error(sensitive), { name: sensitive, code: sensitive }), Object.assign(new TypeError(sensitive), { code: "ECONNRESET" }), new SyntaxError(sensitive)]) {
    const logs: unknown[][] = [];
    const access = await isolatedModule<typeof import("../src/lib/subscription-access")>("src/lib/subscription-access.ts", {
      "./config": { productionDatabase: () => true },
      "./providers/billing": { refreshBillingAccess: async () => { throw cause; } },
    }, logs);
    let failure: SubscriptionRestricted | undefined;
    try { await access.prepareSubscription("workspace-test"); } catch (error) { assert.ok(error instanceof SubscriptionRestricted); failure = error; }
    assert.ok(failure); assert.equal(failure.cause, cause); assert.equal(failure.status, 503);
    assert.equal(Object.getOwnPropertyDescriptor(failure, "cause")?.enumerable, false);
    const response = apiError(failure), body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.code, "SUBSCRIPTION_RESTRICTED");
    assert.ok(!JSON.stringify(body).includes(sensitive)); assert.ok(!JSON.stringify(failure).includes(sensitive));
    assert.equal(logs.length, 1); assert.deepEqual(logs[0][1], { workspaceId: "workspace-test", ...safeErrorDiagnostic(cause) });
    assert.ok(!JSON.stringify(logs).includes(sensitive));
  }
  const cause = new Error(sensitive), app = new AppError("Safe error", 400, undefined, { cause });
  assert.equal(app.cause, cause); assert.ok(!JSON.stringify(app).includes(sensitive));
});

test("safe diagnostics ignore arbitrary names, codes, messages, stack and causes", () => {
  const error = Object.assign(new Error(sensitive, { cause: { token: sensitive } }), { name: sensitive, code: sensitive, status: sensitive });
  assert.deepEqual(safeErrorDiagnostic(error), { errorClass: "Error" });
  assert.deepEqual(safeErrorDiagnostic({ message: sensitive, code: sensitive }), { errorClass: "Unknown" });
  assert.deepEqual(safeErrorDiagnostic(new AppError(sensitive, 503, "SUBSCRIPTION_RESTRICTED")), { errorClass: "AppError", status: 503, code: "SUBSCRIPTION_RESTRICTED" });
});
