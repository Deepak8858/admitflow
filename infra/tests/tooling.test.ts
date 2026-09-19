import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "../../src/lib/errors";
import { safeErrorClass, safePaymentError } from "../../scripts/operational-diagnostics";
import { writeJsonAtomic } from "../../scripts/atomic-json.mjs";

async function temporaryDirectory() {
  const root = resolve("infra", ".test-output");
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(join(root, "tooling-"));
}

test("payment diagnostics preserve only reviewed fixed AppError guidance", () => {
  for (const message of [
    "Specify a workspace; replay requires both --receipt and --apply.",
    "PostgreSQL is required.",
    "Choose a payment receipt belonging to this institute.",
    "Payment receipt not found.",
    "This receipt is still being processed.",
  ]) assert.equal(safePaymentError(new AppError(message)), message);
  for (const error of [new Error("postgres://user:fixture-secret@host/db"), new AppError("Provider response: fixture-secret"), { name: "AppError", message: "fixture-secret" }, "fixture-secret", null]) {
    const result = safePaymentError(error);
    assert.match(result, /Payment inspection\/replay failed/);
    assert(!result.includes("fixture-secret"));
  }
});

test("worker diagnostics retain known classes without exposing messages or arbitrary names", () => {
  assert.equal(safeErrorClass(new TypeError("fixture-secret")), "TypeError");
  assert.equal(safeErrorClass(new AppError("fixture-secret")), "AppError");
  assert.equal(safeErrorClass(Object.assign(new Error("fixture-secret"), { name: "fixture-secret" })), "Error");
  assert.equal(safeErrorClass({ name: "fixture-secret", message: "fixture-secret" }), "unknown");
  assert.equal(safeErrorClass(undefined), "unknown");
});

test("atomic manifest publication replaces complete JSON and cleans its temporary file", async () => {
  const directory = await temporaryDirectory(), filename = join(directory, "manifest.json");
  try {
    await fs.writeFile(filename, '{"old":true}\n');
    const value = { assets: [{ slug: "fixture", variants: [{ bytes: 100 }] }] };
    await writeJsonAtomic(filename, value);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), value);
    assert.deepEqual(await fs.readdir(directory), ["manifest.json"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("failed atomic manifest writes and renames leave the original readable", async () => {
  const directory = await temporaryDirectory(), filename = join(directory, "manifest.json");
  const original = '{"old":true}\n';
  try {
    await fs.writeFile(filename, original);
    const failingWriters: Pick<typeof fs, "writeFile" | "rename" | "rm">[] = [
      { ...fs, writeFile: async (temporary, content, options) => { await fs.writeFile(temporary, String(content).slice(0, 3), options); throw new Error("write failed"); } },
      { ...fs, rename: async (temporary, target) => { assert.equal(resolve(String(target)), filename); assert.equal(resolve(String(temporary), ".."), directory); throw new Error("rename failed"); } },
    ];
    for (const io of failingWriters) {
      await assert.rejects(() => writeJsonAtomic(filename, { next: true }, io), /failed/);
      assert.equal(await fs.readFile(filename, "utf8"), original);
      assert.deepEqual(await fs.readdir(directory), ["manifest.json"]);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
