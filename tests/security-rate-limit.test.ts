import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import Redis from "ioredis";
import { createMutationRateLimiter, enforceMutationRateLimit, mutationRateBudgets } from "../src/lib/mutation-rate-limit";
import { rateLimitRedisConfiguration } from "../src/lib/rate-limit-config";
import { runtimeConfiguration } from "../src/lib/runtime-config";
import { AppError } from "../src/lib/errors";
import { prepareEnvironment } from "../infra/entrypoint.mjs";

const request = (method = "POST") => new Request("https://app.example.com/api/workspace", { method });
const identity = (actorId = "user_fixture", tenantId = "org_fixture") => ({ kind: "workspace" as const, actorId, tenantId });
const status = (expected: number) => (error: unknown) => error instanceof AppError && error.status === expected;
function hosted(t: TestContext) {
  const original = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };
  Object.assign(process.env, { NODE_ENV: "production", DATABASE_URL: "postgres://fixture@database.invalid/test" });
  t.after(() => { for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

test("production mutation limits charge concurrent and repeated authorization once per Request", async t => {
  hosted(t);
  let calls = 0;
  const limit = createMutationRateLimiter(async () => { calls++; await delay(5); return [1, 0]; });
  const req = request();
  await Promise.all([limit(req, identity()), limit(req, identity()), limit(req, identity())]);
  await limit(req, identity());
  assert.equal(calls, 1);
  await assert.rejects(limit(req, identity("different-user")), status(503));
  assert.equal(calls, 1, "a changed identity must not reuse another identity's allowance");
  await limit(request(), identity());
  assert.equal(calls, 2);
});

test("limiter skips read-only methods and local/demo/nonproduction traffic without touching Redis", async t => {
  hosted(t);
  let calls = 0;
  const limit = createMutationRateLimiter(async () => { calls++; throw new Error("should not connect"); });
  for (const method of ["GET", "HEAD", "OPTIONS"]) await limit(request(method), identity());
  process.env.DATABASE_URL = "";
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) await limit(request(method), identity());
  process.env.DATABASE_URL = "postgres://fixture@database.invalid/test";
  Object.assign(process.env, { NODE_ENV: "test" });
  await limit(request(), identity());
  assert.equal(calls, 0);
});

test("backend errors, corrupt replies and timeout fail closed with redacted 503, including repeated checks", async t => {
  hosted(t);
  let calls = 0;
  const limit = createMutationRateLimiter(async () => { calls++; throw new Error("rediss://private:secret@private.internal"); });
  const req = request();
  for (let i = 0; i < 2; i++) await assert.rejects(limit(req, identity()), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 503); assert.equal(error.code, "RATE_LIMIT_UNAVAILABLE");
    assert.match(error.message, /retry/i); assert.doesNotMatch(error.message, /secret|private\.internal/);
    return true;
  });
  assert.equal(calls, 1, "a failed check cannot be bypassed on a recheck");
  for (const reply of [null, [], [1], [2, 0], [0, 0], [0, -1], [0, 3_600_001], [1, 1], ["1", 0]]) {
    await assert.rejects(createMutationRateLimiter(async () => reply)(request(), identity()), status(503));
  }
  const start = Date.now();
  await assert.rejects(createMutationRateLimiter(() => new Promise(() => {}))(request(), identity()), status(503));
  assert.ok(Date.now() - start < 5000, "backend timeout must bound mutation latency");
});

test("simultaneous checks share pending rejection and cannot bypass exhaustion or backend failure", async t => {
  hosted(t);
  for (const expected of [429, 503]) {
    let calls = 0;
    let settle!: () => void;
    const pending = new Promise<void>(resolve => { settle = resolve; });
    const limit = createMutationRateLimiter(async () => {
      calls++; await pending;
      if (expected === 503) throw new Error("backend unavailable");
      return [0, 60_000];
    });
    const req = request();
    const checks = [limit(req, identity()), limit(req, identity()), limit(req, identity())];
    assert.equal(checks[0], checks[1], "every waiter must hold the same in-flight decision");
    assert.equal(checks[1], checks[2]);
    assert.equal(calls, 1);
    let completed = 0;
    const results = Promise.allSettled(checks.map(check => check.finally(() => { completed++; })));
    await delay(5);
    assert.equal(completed, 0, "no waiter may proceed before Redis decides");
    settle();
    for (const result of await results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.ok(status(expected)(result.reason));
    }
    await assert.rejects(limit(req, identity()), status(expected));
    assert.equal(calls, 1);
  }
});

test("production entrypoint and runtime require authenticated TLS Redis, while migration is independent", () => {
  const base = {
    ADMITFLOW_PROCESS_ROLE: "web", DATABASE_URL: "postgres://fixture@database.invalid/test",
    WORKOS_API_KEY: "fixture", WORKOS_CLIENT_ID: "client_fixture", WORKOS_COOKIE_PASSWORD: "x".repeat(32),
    APP_BASE_URL: "https://app.example.com", NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://app.example.com/callback",
    KMS_KEY_ID: "fixture", INTAKE_CONTACT_KEYS: JSON.stringify([Buffer.alloc(32, 17).toString("base64")]),
  };
  const valid = [
    { REDIS_URL: "rediss://:fixture@queue.invalid:6379" },
    { REDIS_URL: "rediss://default:fixture%3A%2F%40@queue.invalid:6380/0" },
    { REDIS_HOST: "queue.invalid", REDIS_PASSWORD: "fixture:/@", REDIS_TLS: "true", REDIS_PORT: "6379" },
  ];
  for (const redis of valid) {
    const input = { ...base, ...redis };
    const prepared = prepareEnvironment(input);
    assert.deepEqual(runtimeConfiguration(input, "web"), []);
    assert.deepEqual(runtimeConfiguration(prepared, "web"), [], "entrypoint output must remain valid after removing REDIS_PASSWORD");
    assert.equal(prepared.REDIS_PASSWORD, undefined);
    assert.equal(new URL(prepared.REDIS_URL).protocol, "rediss:");
    assert.ok(rateLimitRedisConfiguration(prepared).url);
  }
  const invalid = [
    {}, { REDIS_URL: "redis://:fixture@queue.invalid" }, { REDIS_URL: "rediss://queue.invalid" },
    { REDIS_URL: "rediss://:secret@queue.invalid:0" }, { REDIS_URL: "rediss://:secret@queue.invalid:70000" },
    { REDIS_URL: "rediss://:secret@queue.invalid/-1" }, { REDIS_URL: "rediss://:secret@queue.invalid/0?tls=false" },
    { REDIS_URL: "rediss://:secret@queue.invalid#fragment" }, { REDIS_URL: "rediss://:%zz@queue.invalid" },
    { REDIS_URL: " rediss://:secret@queue.invalid" },
    { REDIS_HOST: "queue.invalid", REDIS_TLS: "true" },
    { REDIS_HOST: "queue.invalid", REDIS_PASSWORD: "secret", REDIS_TLS: "false" },
    { REDIS_HOST: "queue.invalid", REDIS_PASSWORD: "secret", REDIS_TLS: "true", REDIS_PORT: "-1" },
    { REDIS_HOST: "queue.invalid/path", REDIS_PASSWORD: "secret", REDIS_TLS: "true" },
  ];
  for (const redis of invalid) {
    const input = { ...base, ...redis };
    assert.ok(runtimeConfiguration(input, "web").some(issue => issue.variable.startsWith("REDIS")));
    assert.ok(runtimeConfiguration(input, "worker").some(issue => issue.variable.startsWith("REDIS")));
    assert.throws(() => prepareEnvironment(input), (error: unknown) => {
      assert.ok(error instanceof Error); assert.match(error.message, /REDIS/);
      assert.doesNotMatch(error.message, /secret|queue\.invalid/); return true;
    });
  }
  const migration = { ADMITFLOW_PROCESS_ROLE: "migration", DATABASE_URL_UNPOOLED: base.DATABASE_URL, REDIS_HOST: "ignored" };
  assert.deepEqual(prepareEnvironment(migration), migration);
  assert.deepEqual(runtimeConfiguration(migration, "migration"), []);
});

test("production export rejects missing Redis configuration instead of using a process-local fallback", async t => {
  hosted(t);
  const keys = ["REDIS_URL", "REDIS_HOST", "REDIS_PASSWORD", "REDIS_TLS"];
  const original = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => { if (original[index] === undefined) delete process.env[key]; else process.env[key] = original[index]; }));
  keys.forEach(key => delete process.env[key]);
  await assert.rejects(enforceMutationRateLimit(request(), identity()), status(503));
});

test("atomic TTL budgets on disposable Redis across application replicas", async t => {
  // This test never uses REDIS_URL or an existing Redis instance. CI can provide
  // redis-server on PATH; environments without it report an explicit skip.
  const probe = spawnSync("redis-server", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") { t.skip("redis-server is not installed; real atomicity/TTL integration requires it on PATH"); return; }
  assert.ifError(probe.error); assert.equal(probe.status, 0);
  hosted(t);
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const child = spawn("redis-server", ["--bind", "127.0.0.1", "--port", String(port), "--save", "", "--appendonly", "no", "--protected-mode", "yes", "--requirepass", "rate-limit-test-only"], { windowsHide: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.on("error", error => { spawnError = error; });
  const redis = new Redis({ host: "127.0.0.1", port, password: "rate-limit-test-only", enableOfflineQueue: false, connectTimeout: 200, maxRetriesPerRequest: 0, retryStrategy: () => 50 });
  redis.on("error", () => {});
  t.after(async () => {
    if (redis.status === "ready") await redis.call("SHUTDOWN", "NOSAVE").catch(() => {});
    redis.disconnect(); child.kill();
  });
  const deadline = Date.now() + 5000;
  while (redis.status !== "ready" && Date.now() < deadline && !spawnError) await delay(25);
  assert.ifError(spawnError); assert.equal(redis.status, "ready", "disposable Redis must start");
  let lastKeys: string[] = [];
  const run = (script: string, keys: string[], args: number[]) => { lastKeys = keys; return redis.eval(script, keys.length, ...keys, ...args); };
  const first = createMutationRateLimiter(run), second = createMutationRateLimiter(run);
  const successes = async (attempts: Promise<void>[], accepted: number) => {
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter(result => result.status === "fulfilled").length, accepted);
    for (const result of results) if (result.status === "rejected") {
      assert.ok(result.reason instanceof AppError); assert.equal(result.reason.status, 429);
      assert.equal(result.reason.code, "RATE_LIMITED"); assert.match(result.reason.message, /Retry in \d+ seconds/);
    }
  };

  await t.test("actor limit is shared across replicas; rejects do not burn tenant quota or refresh expiry", async () => {
    await successes(Array.from({ length: 180 }, (_, index) => (index % 2 ? first : second)(request(), identity())), mutationRateBudgets.actor);
    const [actorKey, tenantKey] = lastKeys;
    assert.equal(await redis.get(actorKey), "120"); assert.equal(await redis.get(tenantKey), "120");
    const before = await redis.pttl(actorKey);
    assert.ok(before > 0 && before <= 60_000);
    await delay(5);
    await assert.rejects(second(request(), identity()), status(429));
    assert.ok(await redis.pttl(actorKey) < before, "blocked requests must not extend expiry");
    await first(request(), identity("user_second"));
    await second(request(), identity("user_fixture", "org_second"));
    assert.equal(await redis.get(tenantKey), "121");
    const allKeys = await redis.keys("*"); // Only this disposable server.
    assert.equal(allKeys.length, 5);
    for (const key of allKeys) { assert.ok(key.length < 180); assert.doesNotMatch(key, /user_fixture|org_fixture|user_second/); }
    await redis.pexpire(actorKey, 1);
    await delay(10);
    await first(request(), identity());
    assert.equal(await redis.get(actorKey), "1", "expiry must restore actor capacity");
    assert.ok(await redis.pttl(actorKey) > 0);
  });

  await t.test("tenant cap bounds distributed actors; another tenant stays available", async () => {
    await successes(Array.from({ length: 1320 }, (_, index) => (index % 2 ? first : second)(request(), identity(`user_${Math.floor(index / 120)}`, "org_busy"))), mutationRateBudgets.tenant);
    const tenantKey = lastKeys[1];
    assert.equal(await redis.get(tenantKey), "1200");
    await assert.rejects(first(request(), identity("user_new", "org_busy")), status(429));
    assert.equal(await redis.get(lastKeys[0]), null, "tenant exhaustion must not create new actor keys");
    await second(request(), identity("user_new", "org_other"));
    assert.ok(await redis.pttl(tenantKey) > 0 && await redis.pttl(tenantKey) <= 60_000);
  });

  await t.test("organization creation has a shared hourly cap and an independent per-account minute cap", async () => {
    const org = { kind: "organizations" as const, actorId: "user_new_account", create: true };
    await successes(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second)(request(), org)), mutationRateBudgets.creation);
    const [accountKey, creationKey] = lastKeys;
    assert.equal(await redis.get(creationKey), "5"); assert.equal(await redis.get(accountKey), "5");
    assert.ok(await redis.pttl(creationKey) > 0 && await redis.pttl(creationKey) <= 3_600_000);
    await successes(Array.from({ length: 30 }, () => first(request(), { ...org, create: false })), 25);
    assert.equal(await redis.get(accountKey), "30");
    await second(request(), { ...org, actorId: "user_another_account" });
    await redis.pexpire(accountKey, 1); await delay(10);
    await assert.rejects(first(request(), org), status(429));
    assert.equal(await redis.get(accountKey), null, "a rejected creation must not consume the renewed minute budget");
  });

  await t.test("corrupt counters and a disconnected backend fail closed; missing TTL is repaired", async () => {
    await first(request(), identity("user_corrupt", "org_corrupt"));
    const [key] = lastKeys;
    await redis.set(key, "corrupt");
    await assert.rejects(first(request(), identity("user_corrupt", "org_corrupt")), status(503));
    await redis.set(key, "120");
    await assert.rejects(first(request(), identity("user_corrupt", "org_corrupt")), status(429));
    assert.ok(await redis.pttl(key) > 0 && await redis.pttl(key) <= 60_000);
    await redis.call("SHUTDOWN", "NOSAVE").catch(() => {});
    redis.disconnect();
    await assert.rejects(first(request(), identity("user_available", "org_available")), status(503));
  });
});
