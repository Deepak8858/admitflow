import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { transform } from "esbuild";
import { NextRequest } from "next/server";
import { createMutationRateLimiter } from "../src/lib/mutation-rate-limit";
import { AppError } from "../src/lib/errors";
import * as errors from "../src/lib/errors";
import { readAction, apiError } from "../src/lib/api";

async function isolated<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const filename = path.resolve(file);
  const { code } = await transform(await readFile(filename, "utf8"), { loader: "ts", format: "cjs", target: "node24", supported: { "dynamic-import": false } });
  const module = { exports: {} }, original = createRequire(filename);
  new vm.Script(`(function(require,module,exports){${code}\n})`, { filename }).runInThisContext()(
    (name: string) => mocks[name] ?? original(name), module, module.exports,
  );
  return module.exports as T;
}
function hosted(t: TestContext) {
  const values = { NODE_ENV: "production", DATABASE_URL: "postgres://fixture@database.invalid/test", WORKOS_CLIENT_ID: "client_fixture", APP_BASE_URL: "https://app.example.com" };
  const original = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}
const req = (body: Record<string, unknown> = {}, route = "workspace", method = "POST") => new NextRequest(`https://app.example.com/api/${route}`, {
  method, headers: { origin: "https://app.example.com", "content-type": "application/json", "x-forwarded-for": String(body.fakeIp || "attacker-controlled") },
  ...(method !== "GET" ? { body: JSON.stringify(body) } : {}),
});
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("workspace limiter uses verified membership before database projection; rechecks retain fresh authorization", async t => {
  hosted(t);
  const events: string[] = [], keys: string[][] = [];
  const user = { id: "user_signed", email: "fixture@example.com", firstName: "Fixture", lastName: "User" };
  let active = true, mapped = true, role = "owner", projectionBlocked = false, outcome: "allowed" | "limited" | "unavailable" = "allowed";
  const limit = createMutationRateLimiter(async (_script, currentKeys) => {
    events.push("limit"); keys.push(currentKeys);
    if (outcome === "unavailable") throw new Error("private backend detail");
    return outcome === "limited" ? [0, 60_000] : [1, 0];
  });
  const auth = await isolated<typeof import("../src/lib/auth")>("src/lib/auth.ts", {
    "@workos-inc/node": { WorkOS: class {
      userManagement = { listOrganizationMemberships: async (input: { userId: string; organizationId: string }) => {
        events.push("membership");
        assert.equal(input.userId, user.id); assert.equal(input.organizationId, "org_signed");
        return { data: active ? [{ id: "om_signed", userId: user.id, organizationId: "org_signed", status: "active", role: { slug: role } }] : [] };
      } };
      organizations = { getOrganization: async () => { events.push("organization"); return { name: "Fixture" }; } };
    } },
    "@workos-inc/authkit-nextjs": { withAuth: async () => { events.push("session"); return { user, organizationId: "org_signed" }; } },
    "drizzle-orm": { eq: () => true },
    "./config": { productionDatabase: () => true, workosConfigured: () => true },
    "./errors": errors,
    "./store": {}, "./seed": { createWorkspace: () => ({}) },
    "./db/schema": { organizationRoutes: { workosId: "workosId" } },
    "./db/client": { database: () => ({ select: () => ({ from: () => ({ where: async () => mapped ? [{ organizationId: "internal-workspace" }] : [] }) }) }) },
    "./db/repository": { createPostgresWorkspace: async () => { events.push("provision"); mapped = true; } },
    "./db/team-access": {
      readAccessFence: async () => { events.push("fence"); return {}; },
      projectAccessIdentity: async () => { events.push("project"); if (projectionBlocked) throw new AppError("Access changed", 409); },
    },
    "./mutation-rate-limit": { enforceMutationRateLimit: limit },
  });
  const request = req({ actorId: "forged-user", organizationId: "forged-tenant", fakeIp: "1.2.3.4" });
  const first = await auth.resolveWorkspace(request);
  assert.equal(first.actor.id, user.id);
  assert.ok(events.indexOf("limit") > events.indexOf("membership"));
  assert.ok(events.indexOf("limit") < events.indexOf("project"));
  assert.deepEqual(keys[0], [`admitflow:mutation-rate:v1:tenant:${hash("org_signed")}:actor:${hash(user.id)}`, `admitflow:mutation-rate:v1:tenant:${hash("org_signed")}`]);
  role = "analyst";
  assert.equal((await auth.resolveWorkspace(request)).actor.role, "analyst", "cached rate allowance must not cache the role");
  assert.equal(events.filter(event => event === "membership").length, 2);
  assert.equal(keys.length, 1);
  projectionBlocked = true;
  await assert.rejects(auth.resolveWorkspace(request), status(409));
  projectionBlocked = false; active = false;
  await assert.rejects(auth.resolveWorkspace(request), status(403));
  assert.equal(keys.length, 1, "a revoked user must never reach the limiter, even with a prior allowance");
  await assert.rejects(auth.resolveWorkspace(req()), status(403));
  assert.equal(keys.length, 1);

  active = true;
  await auth.resolveWorkspace(req({ fakeIp: "9.8.7.6" }));
  assert.deepEqual(keys[1], keys[0], "changing request headers/payload cannot rotate rate keys");
  for (const failure of ["limited", "unavailable"] as const) {
    outcome = failure; events.length = 0;
    await assert.rejects(auth.resolveWorkspace(req()), status(failure === "limited" ? 429 : 503));
    assert.ok(events.includes("membership")); assert.ok(!events.includes("project"));
    mapped = false; events.length = 0;
    await assert.rejects(auth.resolveWorkspace(req()), status(failure === "limited" ? 429 : 503));
    assert.ok(!events.includes("organization")); assert.ok(!events.includes("provision"));
    mapped = true;
  }
  const charged = keys.length;
  await auth.resolveWorkspace(req({}, "workspace", "GET"));
  assert.equal(keys.length, charged, "GET must not consume Redis budget or fail because Redis is down");
});

test("organization creation is limited by signed-in account before provider writes; 429/503 responses are useful and redacted", async t => {
  hosted(t);
  const calls: string[] = [], keys: string[][] = [];
  let userId = "user_creator", sessionAllowed = true, unavailable = false;
  const counts = new Map<string, number>();
  const limit = createMutationRateLimiter(async (_script, currentKeys, args) => {
    calls.push("limit"); keys.push(currentKeys);
    if (unavailable) throw new Error("secret internal Redis address");
    if (currentKeys.some((key, index) => (counts.get(key) || 0) >= args[index * 2])) return [0, 3_600_000];
    currentKeys.forEach(key => counts.set(key, (counts.get(key) || 0) + 1));
    return [1, 0];
  });
  const route = await isolated<typeof import("../src/app/api/organizations/route")>("src/app/api/organizations/route.ts", {
    "@/lib/auth": {
      hostedSession: async () => { calls.push("session"); if (!sessionAllowed) throw new AppError("Sign in", 401); return { user: { id: userId }, organizationId: "unverified-session-tenant" }; },
      workos: () => ({}),
    },
    "@/lib/api": { readAction, apiError }, "@/lib/errors": errors,
    "@workos-inc/authkit-nextjs": { refreshSession: async () => { calls.push("refresh"); } },
    "@/lib/mutation-rate-limit": { enforceMutationRateLimit: limit },
    "@/lib/provisioning": {
      startProvisioning: async (actor: { actorId: string }) => { assert.equal(actor.actorId, userId); calls.push("create"); return { state: "ready" }; },
      continueProvisioning: async () => { calls.push("continue"); return { state: "ready" }; },
    },
  });
  const create = (index: number) => req({ type: "create", requestId: "11111111-1111-4111-8111-111111111111", name: "Fixture", actorId: `forged${index}`, organizationId: `org_forged${index}`, fakeIp: `1.1.1.${index}` }, "organizations");
  for (let i = 0; i < 5; i++) assert.equal((await route.POST(create(i))).status, 200);
  const limited = await route.POST(create(6));
  assert.equal(limited.status, 429); assert.equal((await limited.json()).code, "RATE_LIMITED");
  assert.equal(calls.filter(value => value === "create").length, 5);
  assert.deepEqual(calls.slice(0, 3), ["session", "limit", "create"]);
  assert.equal(new Set(keys.map(value => JSON.stringify(value))).size, 1, "payload identity and XFF must not create a new budget");
  assert.deepEqual(keys[0], [`admitflow:mutation-rate:v1:account:${hash("user_creator")}`, `admitflow:mutation-rate:v1:create:${hash("user_creator")}`]);
  assert.equal((await route.POST(req({ type: "continue", id: "11111111-1111-4111-8111-111111111111" }, "organizations"))).status, 200, "creation exhaustion must not block existing operation recovery");
  userId = "user_second";
  assert.equal((await route.POST(create(7))).status, 200);
  unavailable = true;
  const creates = calls.filter(value => value === "create").length;
  const failed = await route.POST(create(8));
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.equal(body.code, "RATE_LIMIT_UNAVAILABLE"); assert.match(body.error, /retry/i);
  assert.doesNotMatch(JSON.stringify(body), /secret|internal Redis/);
  assert.equal(calls.filter(value => value === "create").length, creates);
  sessionAllowed = false;
  const charges = keys.length;
  assert.equal((await route.POST(create(9))).status, 401);
  assert.equal(keys.length, charges, "unsigned requests must not allocate Redis keys");
});
