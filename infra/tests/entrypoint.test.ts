import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { prepareEnvironment } from "../entrypoint.mjs";
import { verificationEnvironment } from "../../scripts/verify.mjs";

const web = {
  ADMITFLOW_PROCESS_ROLE: "web", DATABASE_URL: "postgresql://fixture:fixture@database.invalid/admitflow",
  WORKOS_API_KEY: "fixture-only", WORKOS_CLIENT_ID: "client_fixture", WORKOS_COOKIE_PASSWORD: "x".repeat(32),
  NEXT_PUBLIC_WORKOS_REDIRECT_URI: "https://admitflow.incfrog.ai/callback",
  INTAKE_CONTACT_KEYS: JSON.stringify([Buffer.alloc(32, 17).toString("base64")]),
};
const invalidOrigins = [
  undefined, "", " ", "not-a-url", "http://127.0.0.1:3000", "http://admitflow.incfrog.ai",
  "//admitflow.incfrog.ai", "javascript:alert(1)", "https://user:private-fixture@admitflow.incfrog.ai",
  "https://admitflow.incfrog.ai/path", "https://admitflow.incfrog.ai/?private-fixture=1",
  "https://admitflow.incfrog.ai/#private-fixture", "https://admitflow.incfrog.ai/?", "https://admitflow.incfrog.ai/#",
  " https://admitflow.incfrog.ai", "https://admitflow.incfrog.ai\n", "https://admitflow.incfrog.ai/path/..",
  "https://admitflow.incfrog.ai\\", "https:admitflow.incfrog.ai", "https://ADMITFLOW.INCFROG.AI",
];

test("web entrypoint rejects missing, non-HTTPS and noncanonical application origins without disclosing input", () => {
  for (const APP_BASE_URL of invalidOrigins) {
    assert.throws(() => prepareEnvironment({ ...web, APP_BASE_URL }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(["Missing required runtime variable: APP_BASE_URL", "APP_BASE_URL must be a canonical HTTPS origin."].includes(error.message));
      assert.ok(!error.message.includes("private-fixture"));
      return true;
    });
  }
});

test("web entrypoint accepts canonical HTTPS origins with optional trailing slash or nondefault port", () => {
  for (const APP_BASE_URL of ["https://admitflow.incfrog.ai", "https://admitflow.incfrog.ai/", "https://app.example.com:8443"]) {
    const input = { ...web, APP_BASE_URL };
    assert.deepEqual(prepareEnvironment(input), input);
  }
});

test("origin validation does not change migration and worker configuration contracts", () => {
  const migration = { ADMITFLOW_PROCESS_ROLE: "migration", DATABASE_URL_UNPOOLED: web.DATABASE_URL };
  assert.deepEqual(prepareEnvironment(migration), migration);
  const worker = { ADMITFLOW_PROCESS_ROLE: "worker", DATABASE_URL: web.DATABASE_URL, INTAKE_CONTACT_KEYS: web.INTAKE_CONTACT_KEYS, REDIS_HOST: "queue.invalid", REDIS_PASSWORD: "fixture", REDIS_TLS: "true" };
  assert.equal(new URL(prepareEnvironment(worker).REDIS_URL).protocol, "rediss:");
});

test("actual web entrypoint refuses to spawn the server for invalid origins and starts it for valid configuration", () => {
  const isolated = verificationEnvironment(process.env, "", "unused-entrypoint-fixture");
  const run = (APP_BASE_URL: string | undefined) => spawnSync(process.execPath, [resolve("infra/entrypoint.mjs"), process.execPath, "-e", "process.stdout.write('server-started')"], {
    env: { ...isolated, ...web, APP_BASE_URL, NODE_ENV: "production" }, encoding: "utf8", timeout: 10_000,
  });
  for (const origin of invalidOrigins) {
    const result = run(origin);
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /APP_BASE_URL/);
    assert.ok(!result.stderr.includes("private-fixture"));
  }
  const valid = run("https://admitflow.incfrog.ai");
  assert.ifError(valid.error);
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, "server-started");
  assert.equal(valid.stderr, "");
});
