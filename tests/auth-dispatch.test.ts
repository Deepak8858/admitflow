import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
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
test("hosted logout rejects missing, malformed and foreign origins before any session mutation", async () => {
  let calls = 0;
  const origins = [null, "", "null", "https://foreign.invalid", "http://admitflow.example", "https://admitflow.example:8443", "https://admitflow.example.foreign.invalid", "https://admitflow.example@foreign.invalid", "https://foreign.invalid@admitflow.example", "https://admitflow.example/", "https://admitflow.example/path", "https://admitflow.example?next=1", "https://admitflow.example#fragment", "https://admitflow.example, https://foreign.invalid"];
  for (const origin of origins) {
    const action = await isolatedModule<typeof import("../src/app/auth/actions")>("src/app/auth/actions.ts", {
      "@workos-inc/authkit-nextjs": { signOut: async () => { calls++; } },
      "@/lib/config": { productionDatabase: () => true, workosConfigured: () => true, appUrl: () => "https://admitflow.example" },
      "next/headers": { headers: async () => new Headers({ ...(origin === null ? {} : { origin }), host: "foreign.invalid", "x-forwarded-host": "foreign.invalid", "sec-fetch-site": "same-origin" }) },
    });
    await assert.rejects(action.signOutAction(), /same-origin request/);
  }
  assert.equal(calls, 0);
});

test("hosted logout fails closed in local or partially configured mode without falling back to SQLite", async () => {
  let calls = 0;
  for (const [database, workos] of [[false, false], [false, true], [true, false]]) {
    const action = await isolatedModule<typeof import("../src/app/auth/actions")>("src/app/auth/actions.ts", {
      "@workos-inc/authkit-nextjs": { signOut: async () => { calls++; } },
      "@/lib/config": { productionDatabase: () => database, workosConfigured: () => workos, appUrl: () => "https://admitflow.example" },
      "next/headers": { headers: async () => new Headers({ origin: "https://admitflow.example" }) },
      "@/lib/store": { endSession: () => assert.fail("Hosted action must not mutate local sessions") },
    });
    await assert.rejects(action.signOutAction(), /not configured/);
  }
  assert.equal(calls, 0);
});

test("hosted logout uses the runtime public URL and propagates the SDK redirect unchanged", async () => {
  let base = "https://build.example", origin = "https://runtime.example";
  const calls: unknown[] = [], redirect = new Error("NEXT_REDIRECT");
  const action = await isolatedModule<typeof import("../src/app/auth/actions")>("src/app/auth/actions.ts", {
    "@workos-inc/authkit-nextjs": { signOut: async (options: unknown) => { calls.push(options); throw redirect; } },
    "@/lib/config": { productionDatabase: () => true, workosConfigured: () => true, appUrl: () => base },
    "next/headers": { headers: async () => new Headers({ origin, host: "container.internal:3000", "x-forwarded-host": "foreign.invalid" }) },
  });
  base = origin;
  await assert.rejects(action.signOutAction(), error => error === redirect);
  base = origin = "https://second-runtime.example";
  await assert.rejects(action.signOutAction(), error => error === redirect);
  assert.deepEqual(calls, [{ returnTo: "https://runtime.example/onboarding" }, { returnTo: "https://second-runtime.example/onboarding" }]);
});

test("callback passes runtime baseURL and the unchanged request to AuthKit rather than trusting container hosts", async () => {
  let base = "https://build.example";
  const calls: unknown[] = [];
  const response = new Response(null, { status: 307 });
  const route = await isolatedModule<typeof import("../src/app/callback/route")>("src/app/callback/route.ts", {
    "@/lib/config": { appUrl: () => base },
    "@workos-inc/authkit-nextjs": { handleAuth: (options: unknown) => {
      calls.push(options); return async (request: NextRequest) => { calls.push(request); return response; };
    } },
  });
  assert.deepEqual(calls, [], "callback configuration must not freeze at module initialization");
  const request = new NextRequest("http://container.internal:3000/callback?code=synthetic&state=fixture", { headers: { "x-forwarded-host": "foreign.invalid" } });
  for (base of ["https://runtime.example", "https://second-runtime.example"]) assert.equal(await route.GET(request), response);
  const first = calls[0] as { returnPathname: string; baseURL: string; onError: () => Promise<Response> };
  const second = calls[2] as typeof first;
  assert.deepEqual({ ...first, onError: undefined }, { returnPathname: "/onboarding", baseURL: "https://runtime.example", onError: undefined });
  assert.deepEqual({ ...second, onError: undefined }, { returnPathname: "/onboarding", baseURL: "https://second-runtime.example", onError: undefined });
  assert.equal(calls[1], request);
  assert.equal(calls[3], request);
  const failure = await second.onError();
  assert.equal(failure.status, 307);
  assert.equal(failure.headers.get("location"), "https://second-runtime.example/auth/error");
});

test("public entry pages bypass AuthKit while workspace routes retain session handling", async () => {
  const values = { WORKOS_API_KEY: process.env.WORKOS_API_KEY, WORKOS_CLIENT_ID: process.env.WORKOS_CLIENT_ID, DATABASE_URL: process.env.DATABASE_URL };
  let handled = 0;
  const route = await isolatedModule<typeof import("../src/proxy")>("src/proxy.ts", {
    "@workos-inc/authkit-nextjs": { authkitMiddleware: () => () => { handled++; return new Response(null, { status: 200 }); } },
  });
  try {
    Object.assign(process.env, { WORKOS_API_KEY: "fixture", WORKOS_CLIENT_ID: "fixture", DATABASE_URL: "fixture" });
    for (const pathname of ["/", "/welcome", "/product", "/pricing", "/help", "/signup", "/login", "/auth/error"]) {
      await route.default(new NextRequest(`https://admitflow.example${pathname}`, { headers: { cookie: "wos-session=expired-fixture" } }), {} as Parameters<typeof route.default>[1]);
    }
    assert.equal(handled, 0, "a broken/expired session must not block public pages");
    await route.default(new NextRequest("https://admitflow.example/overview"), {} as Parameters<typeof route.default>[1]);
    await route.default(new NextRequest("https://admitflow.example/api/workspace"), {} as Parameters<typeof route.default>[1]);
    assert.equal(handled, 2);
  } finally {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("both hosted logout controls use a POST server action and the GET logout surface is absent", async () => {
  await assert.rejects(readFile("src/app/logout/route.ts"), { code: "ENOENT" });
  const action = await readFile("src/app/auth/actions.ts", "utf8");
  assert.match(action, /^"use server";/);
  assert.doesNotMatch(action, /(?:local-store|lib\/store)/);
  for (const file of ["src/components/onboarding.tsx", "src/components/configuration.tsx"]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /import \{ signOutAction \} from "@\/app\/auth\/actions"/);
    assert.match(source, /<form action=\{signOutAction\}><Button type="submit"/);
    assert.doesNotMatch(source, /["']\/logout["']/);
  }
});

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
  assert.equal(duplicate.status, 400); assert.equal((await duplicate.json()).error, "Authentication could not be completed. Please try again.");
  assert.equal(duplicate.headers.get("set-cookie"), null);
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

test("malformed stored salts and hashes produce only the ordinary sign-in failure", async t => {
  assert.equal(process.env.ADMITFLOW_DB, ":memory:");
  const local = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", {}, [], {} as typeof globalThis);
  const db = local.database(); t.after(() => db.close());
  const account = local.register("valid@example.com", "password-long", "Owner", "Institute");
  const valid = db.prepare("SELECT password_hash FROM users WHERE email = ?").get("valid@example.com")!.password_hash as string;
  const [salt, hash] = valid.split(":");
  const malformed = ["", salt, `:${hash}`, `${salt}:`, `${salt}:${hash}:extra`, `${salt.slice(1)}:${hash}`, `${salt}0:${hash}`, `${"g".repeat(32)}:${hash}`, `${salt}:${hash.slice(1)}`, `${salt}:${hash}0`, `${salt}:${"g".repeat(128)}`, ` ${valid}`, `${valid}\n`, `${"A".repeat(32)}:${hash}`, `${salt}:${"B".repeat(128)}`, new Uint8Array([1, 2, 3])];
  const logs: unknown[][] = [], route = await authRoute(local, false, logs);
  const sessionCount = () => db.prepare("SELECT count(*) AS count FROM sessions").get()!.count;
  const before = sessionCount();
  for (const [index, stored] of malformed.entries()) {
    const email = `malformed-${index}@example.com`;
    db.prepare("INSERT INTO users (email, password_hash, workspace_id) VALUES (?, ?, ?)").run(email, stored, account.workspace.id);
    const response = await route.POST(request({ type: "login", email, password: "password-long" }));
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "Email or password did not match. Please try again." });
    assert.equal(response.headers.get("set-cookie"), null); assert.equal(sessionCount(), before);
  }
  assert.deepEqual(logs, [], "malformed credential records must not surface crypto/storage exceptions");
  assert.equal((await route.POST(request({ type: "login", email: "valid@example.com", password: "password-long" }))).status, 200);
});

test("SQLite configures timeout before WAL, ignores only WAL SQLITE_BUSY, and closes failed handles", async t => {
  assert.equal(process.env.ADMITFLOW_DB, ":memory:");
  for (const scenario of ["memory", "wal-busy", "wal-corrupt", "wal-not-database", "wal-locked", "wal-unknown", "timeout-busy", "ddl-busy"] as const) await t.test(scenario, async c => {
    const statements: string[] = [], handles: DatabaseSync[] = [];
    let closes = 0, fail = true;
    const failure = Object.assign(new Error(sensitive), { errcode: scenario === "wal-corrupt" ? 11 : scenario === "wal-not-database" ? 26 : scenario === "wal-locked" ? 6 : scenario === "wal-unknown" ? undefined : 5 });
    class TestDatabase extends DatabaseSync {
      constructor(filename: string) { super(filename); handles.push(this); }
      override exec(statement: string) {
        statements.push(statement);
        if (statement.includes("journal_mode")) assert.equal(this.prepare("PRAGMA busy_timeout").get()!.timeout, 5000);
        if (fail && ((scenario.startsWith("wal-") && statement.includes("journal_mode")) || (scenario === "timeout-busy" && statement.includes("busy_timeout")) || (scenario === "ddl-busy" && statement.includes("CREATE TABLE")))) throw failure;
        super.exec(statement);
      }
      override close() { closes++; super.close(); }
    }
    const local = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", { "node:sqlite": { DatabaseSync: TestDatabase } }, [], {} as typeof globalThis);
    if (scenario === "memory" || scenario === "wal-busy") {
      const db = local.database(); c.after(() => db.close());
      assert.equal(local.database(), db); assert.equal(handles.length, 1); assert.equal(closes, 0);
      assert.equal(statements[0], "PRAGMA busy_timeout=5000"); assert.equal(statements[1], "PRAGMA journal_mode=WAL");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(row => row.name);
      assert.deepEqual(tables, ["auth_attempts", "sessions", "users", "workspaces"]);
      assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "memory", "unsupported WAL mode is not an initialization failure");
    } else {
      assert.throws(() => local.database(), error => error === failure); assert.equal(closes, 1);
      assert.throws(() => handles[0].prepare("SELECT 1"), /not open/);
      if (scenario.startsWith("wal-")) assert.equal(statements.some(statement => statement.includes("CREATE TABLE")), false);
      fail = false;
      const recovered = local.database(); c.after(() => recovered.close());
      assert.equal(handles.length, 2); assert.notEqual(recovered, handles[0], "failed initialization must not cache its closed handle");
      assert.equal(recovered.prepare("SELECT count(*) AS count FROM users").get()!.count, 0);
    }
  });
});

test("raced local registrations return the same generic error and roll back workspace/session writes", async t => {
  assert.equal(process.env.ADMITFLOW_DB, ":memory:");
  const original = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", {}, [], {} as typeof globalThis);
  const db = original.database(); t.after(() => db.close());
  original.register("race@example.com", "password-long", "Owner", "Institute");
  const counts = () => ["users", "workspaces", "sessions"].map(table => db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count);
  const before = counts();
  let unexpected = false;
  const racedDb = {
    exec: (sql: string) => db.exec(sql),
    prepare: (sql: string) => {
      // Simulate another SQLite connection winning between SELECT and BEGIN.
      if (sql === "SELECT email FROM users WHERE email = ?") return { get: () => undefined };
      if (unexpected && sql.startsWith("INSERT INTO users")) return { run: () => { throw new Error(sensitive); } };
      return db.prepare(sql);
    },
  };
  const local = await isolatedModule<typeof import("../src/lib/local-store")>("src/lib/local-store.ts", {}, [], { admitflowDb: racedDb } as unknown as typeof globalThis);
  const logs: unknown[][] = [], route = await authRoute(local, false, logs);
  const response = await route.POST(request({ type: "register", email: "race@example.com", password: "password-long" }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "Authentication could not be completed. Please try again.");
  assert.equal(body.code, "AUTHENTICATION_FAILED"); assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(counts(), before);
  assert.throws(() => original.register("race@example.com", "password-long", "Owner", "Institute"), (error: unknown) => error instanceof AppError && error.code === body.code && error.message === body.error);
  unexpected = true;
  const failed = await route.POST(request({ type: "register", email: "new@example.com", password: "password-long" }));
  assert.equal(failed.status, 500); assert.equal(failed.headers.get("set-cookie"), null);
  assert.ok(!(await failed.text()).includes(sensitive)); assert.ok(!JSON.stringify(logs).includes(sensitive));
  assert.deepEqual(counts(), before, "unexpected insert failures also roll back the newly created workspace");
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
