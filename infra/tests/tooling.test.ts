import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppError } from "../../src/lib/errors";
import { safeErrorClass, safeJobName, safePaymentError } from "../../scripts/operational-diagnostics";
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
  assert.equal(safeJobName("execute"), "execute");
  for (const name of [undefined, "fixture-secret", "execute\nfixture-secret", {}]) assert.equal(safeJobName(name), "unknown");
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

test("failed atomic manifest writes, syncs, closes and renames leave the original readable", async () => {
  const directory = await temporaryDirectory(), filename = join(directory, "manifest.json");
  const original = '{"old":true}\n';
  try {
    await fs.writeFile(filename, original);
    for (const failure of ["write", "sync", "close", "rename"]) {
      let closed = false;
      const io: Parameters<typeof writeJsonAtomic>[2] = {
        ...fs,
        open: async (temporary, flags) => {
          const handle = await fs.open(temporary, flags);
          return {
            writeFile: async content => { await handle.writeFile(failure === "write" ? String(content).slice(0, 3) : content); if (failure === "write") throw new Error("write failed"); },
            sync: async () => { if (failure === "sync") throw new Error("sync failed"); await handle.sync(); },
            close: async () => { await handle.close(); closed = true; if (failure === "close") throw new Error("close failed"); },
          };
        },
        rename: async (temporary, target) => {
          assert.equal(resolve(String(target)), filename); assert.equal(resolve(String(temporary), ".."), directory);
          if (failure === "rename") throw new Error("rename failed");
          assert.fail("failures before rename must not publish the temporary file");
        },
      };
      await assert.rejects(() => writeJsonAtomic(filename, { next: true }, io), new RegExp(`${failure} failed`));
      assert.equal(closed, true);
      assert.equal(await fs.readFile(filename, "utf8"), original);
      assert.deepEqual(await fs.readdir(directory), ["manifest.json"]);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("atomic publication flushes and closes the file before rename and the POSIX directory afterwards", async () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const calls: string[] = [], filename = resolve("manifest.json");
    const io: Parameters<typeof writeJsonAtomic>[2] = {
      open: async (target, flags) => {
        const kind = flags === "wx" ? "file" : "directory";
        if (kind === "directory") { assert.equal(target, resolve(".")); assert.equal(flags, "r"); }
        calls.push(`open:${kind}`);
        return {
          writeFile: async content => { assert.equal(content, '{\n  "next": true\n}\n'); calls.push("write"); },
          sync: async () => { calls.push(`sync:${kind}`); },
          close: async () => { calls.push(`close:${kind}`); },
        };
      },
      rename: async (_temporary, target) => { assert.equal(target, filename); calls.push("rename"); },
      rm: async () => { calls.push("cleanup"); },
    };
    await writeJsonAtomic(filename, { next: true }, io, platform);
    assert.deepEqual(calls, ["open:file", "write", "sync:file", "close:file", "rename", ...(platform === "win32" ? [] : ["open:directory", "sync:directory", "close:directory"]), "cleanup"]);
  }
});

test("directory flush failures report uncertain durability after publication and still close handles", async () => {
  for (const failure of ["open", "sync", "close"]) {
    const directory = await temporaryDirectory(), filename = join(directory, "manifest.json");
    let directoryClosed = false;
    try {
      const io: Parameters<typeof writeJsonAtomic>[2] = {
        ...fs,
        open: async (target, flags) => {
          if (flags === "wx") return fs.open(target, flags);
          if (failure === "open") throw new Error("directory open failed");
          return {
            writeFile: async () => assert.fail("directory must not be written"),
            sync: async () => { if (failure === "sync") throw new Error("directory sync failed"); },
            close: async () => { directoryClosed = true; if (failure === "close") throw new Error("directory close failed"); },
          };
        },
      };
      await assert.rejects(() => writeJsonAtomic(filename, { next: true }, io, "linux"), new RegExp(`directory ${failure} failed`));
      assert.equal(directoryClosed, failure !== "open");
      assert.deepEqual(JSON.parse(await fs.readFile(filename, "utf8")), { next: true }, "rename already published; do not claim rollback");
      assert.deepEqual(await fs.readdir(directory), ["manifest.json"]);
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
});

test("failed exclusive creation does not remove a file this writer does not own", async () => {
  let removed = false;
  await assert.rejects(() => writeJsonAtomic("manifest.json", {}, {
    open: async () => { throw new Error("exclusive creation failed"); },
    rename: async () => assert.fail("must not rename"),
    rm: async () => { removed = true; },
  }), /exclusive creation failed/);
  assert.equal(removed, false);
});
