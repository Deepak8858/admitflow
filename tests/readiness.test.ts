import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readiness } from "../src/lib/readiness";
import { runtimeConfiguration } from "../src/lib/runtime-config";
import { GET as liveness } from "../src/app/api/health/route";
import { verificationEnvironment } from "../scripts/verify.mjs";

const env = {
  DATABASE_URL: "postgresql://fixture:fixture@database.invalid/admitflow", WORKOS_API_KEY: "fixture-only", WORKOS_CLIENT_ID: "client_fixture",
  WORKOS_COOKIE_PASSWORD: "a".repeat(32), APP_BASE_URL: "https://app.example.com", NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://app.example.com/callback", KMS_KEY_ID: "fixture-key", ADMITFLOW_PROCESS_ROLE: "web",
  REDIS_URL: "rediss://:fixture@queue.invalid:6379",
};

test("readiness is bounded and does not disclose errors, credentials or tenant data", async () => {
  assert.deepEqual(runtimeConfiguration(env, "web"), []);
  assert.deepEqual(await readiness({}, async () => { throw new Error("Local mode must not probe"); }), { status: "ready", mode: "local" });
  assert.deepEqual(await readiness({ ADMITFLOW_PROCESS_ROLE: "web" }, async () => { throw new Error("Invalid configuration must not probe"); }), { status: "not-ready", mode: "hosted" });
  assert.equal((await readiness(env, async () => true)).status, "ready");
  assert.equal((await readiness(env, async () => false)).status, "not-ready");
  const unavailable = await readiness(env, async () => { throw new Error("private database connection string"); });
  assert.deepEqual(unavailable, { status: "not-ready", mode: "hosted" });
  assert.equal((await readiness(env, () => new Promise(() => undefined), 5)).status, "not-ready");
  const live = await liveness(); assert.equal(live.status, 200);
  assert.equal(live.headers.get("cache-control"), "no-store"); assert.deepEqual(await live.json(), { status: "ok" });
});

test("preflight validates roles, origin/callback, encryption and TLS queue configuration using names only", () => {
  const invalid = runtimeConfiguration({ ...env, DATABASE_URL: "https://secret.invalid", WORKOS_COOKIE_PASSWORD: "short-secret", NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://foreign.invalid/callback" }, "web");
  assert.ok(invalid.some(issue => issue.variable === "DATABASE_URL"));
  assert.ok(invalid.some(issue => issue.variable === "WORKOS_COOKIE_PASSWORD"));
  assert.ok(invalid.some(issue => issue.variable === "NEXT_PUBLIC_WORKOS_REDIRECT_URI"));
  assert.ok(!JSON.stringify(invalid).includes("short-secret"));
  assert.deepEqual(runtimeConfiguration({ DATABASE_URL_UNPOOLED: env.DATABASE_URL }, "migration"), []);
  assert.deepEqual(runtimeConfiguration({ ...env, REDIS_URL: "rediss://:fixture@queue.invalid:6379" }, "worker"), []);
  assert.ok(runtimeConfiguration({ ...env, REDIS_URL: "redis://queue.invalid" }, "worker").some(issue => issue.variable === "REDIS_URL"));
});

test("verification excludes inherited provider credentials and uses only disposable browser data", async () => {
  const actualTemplate = await readFile(".env.example", "utf8");
  const config = verificationEnvironment({ PATH: "system-path", DATABASE_URL: "must-not-inherit", WORKOS_API_KEY: "must-not-inherit", AWS_ACCESS_KEY_ID: "must-not-inherit", NODE_OPTIONS: "--require=unsafe" }, actualTemplate, "disposable-verification-dir");
  assert.equal(config.DATABASE_URL, ""); assert.equal(config.WORKOS_API_KEY, "");
  assert.equal(config.AWS_ACCESS_KEY_ID, undefined); assert.equal(config.NODE_OPTIONS, undefined);
  assert.equal(config.ADMITFLOW_DB, ":memory:"); assert.match(config.ADMITFLOW_BROWSER_DB, /disposable-verification-dir/);
  assert.equal(config.APP_BASE_URL, "");
  // Do not put actual values into assertion failure messages.
  for (const name of ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "WORKOS_API_KEY", "WORKOS_COOKIE_PASSWORD", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "R2_SECRET_ACCESS_KEY", "INTEGRATION_ENCRYPTION_KEY"]) {
    const match = actualTemplate.match(new RegExp(`^${name}=(.*)$`, "m"));
    assert.ok(match && !match[1].trim(), `${name} must be empty in the example environment`);
  }
});
