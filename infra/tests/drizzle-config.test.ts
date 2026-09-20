import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verificationEnvironment } from "../../scripts/verify.mjs";

function isolatedConfigProcess(args: string[], database: { DATABASE_URL?: string; DATABASE_URL_UNPOOLED?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "admitflow-drizzle-config-"));
  const env = verificationEnvironment(process.env, readFileSync(resolve(".env.example"), "utf8"), directory);
  Object.assign(env, database);
  delete env.NODE_ENV; delete env.HOSTNAME; delete env.PORT;
  try {
    const result = spawnSync(process.execPath, args, { cwd: process.cwd(), env: { ...env, NODE_ENV: "test" }, encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    return result;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const configPath = JSON.stringify(resolve("drizzle.config.ts"));

test("Drizzle generation config has no database target without explicit credentials", () => {
  const result = isolatedConfigProcess(["node_modules/tsx/dist/cli.mjs", "-e", `
    const assert = require('node:assert/strict');
    process.argv = [process.execPath, 'drizzle-kit', 'generate'];
    const config = require(${configPath}).default;
    assert.equal(config.dialect, 'postgresql');
    assert.equal(config.schema, './src/lib/db/schema.ts');
    assert.equal(config.out, './drizzle');
    assert.equal(config.strict, true);
    assert.equal(Object.hasOwn(config, 'dbCredentials'), false);
  `]);
  assert.equal(result.status, 0, result.stderr);
});

test("Drizzle config prefers explicit unpooled URL and supports an explicit runtime URL", () => {
  for (const database of [
    { DATABASE_URL: "postgres://runtime.example.invalid/fixture" },
    { DATABASE_URL_UNPOOLED: "postgres://direct.example.invalid/fixture" },
    { DATABASE_URL: "postgres://runtime.example.invalid/fixture", DATABASE_URL_UNPOOLED: "postgres://direct.example.invalid/fixture" },
  ]) {
    const result = isolatedConfigProcess(["node_modules/tsx/dist/cli.mjs", "-e", `
      const assert = require('node:assert/strict');
      const config = require(${configPath}).default;
      assert.equal(config.dbCredentials.url, process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);
    `], database);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("Drizzle push guard rejects direct and legacy commands before any credential loading", () => {
  for (const command of ["push", "push:pg"]) {
    const result = isolatedConfigProcess(["node_modules/tsx/dist/cli.mjs", "-e", `
      const assert = require('node:assert/strict');
      let credentialLoads = 0;
      require('dotenv').config = () => { credentialLoads++; throw new Error('must not load credentials'); };
      process.argv = [process.execPath, 'drizzle-kit', ${JSON.stringify(command)}];
      assert.throws(() => require(${configPath}), /drizzle-kit push is disabled/);
      assert.equal(credentialLoads, 0);
    `]);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("real drizzle-kit push CLI is blocked by the repository config without a database connection", () => {
  const result = isolatedConfigProcess(["node_modules/drizzle-kit/bin.cjs", "push", "--config=drizzle.config.ts"]);
  const output = result.stdout + result.stderr;
  assert.match(output, /drizzle-kit push is disabled/);
  assert.match(output, /npm run db:generate/);
  assert.doesNotMatch(output, /Pulling schema|ECONNREFUSED|ENOTFOUND/);
  assert.notEqual(result.status, 0, "blocked pushes must fail the calling script");
});
