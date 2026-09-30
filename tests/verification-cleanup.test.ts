import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

type DirectoryKind = "safe" | "root" | "outside" | "relative" | "sibling" | "traversal";

function probe(directory: DirectoryKind, exitCode: number, failRemoval = false) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { tmpdir } from "node:os";
    import { dirname, join, resolve } from "node:path";
    import { cleanupVerificationDirectory } from "./scripts/verify.mjs";
    const root = resolve(tmpdir());
    const directories = {
      safe: join(root, "admitflow-cleanup-fixture"),
      root,
      outside: join(dirname(root), "outside-verification-fixture"),
      relative: "relative-verification-fixture",
      sibling: join(root + "-sibling", "admitflow-cleanup-fixture"),
      traversal: root + "/../outside-verification-fixture",
    };
    const removals = [];
    process.exitCode = ${exitCode};
    cleanupVerificationDirectory(directories[${JSON.stringify(directory)}], (target, options) => {
      removals.push({ target, options });
      if (${failRemoval}) throw new Error("synthetic private cleanup detail");
    });
    console.log(JSON.stringify({ removals, safe: directories.safe }));
  `], { encoding: "utf8", timeout: 10_000, windowsHide: true });
}

test("verification cleanup removes an absolute child of the temporary workspace", () => {
  const result = probe("safe", 0);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const { removals, safe } = JSON.parse(result.stdout);
  assert.deepEqual(removals, [{ target: safe, options: { recursive: true, force: true } }]);
});

for (const directory of ["root", "outside", "relative", "sibling", "traversal"] as const) {
  test(`verification cleanup refuses ${directory} paths without removing anything`, () => {
    const result = probe(directory, 0);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).removals, []);
    assert.match(result.stderr, /cleanup skipped/);
  });
}

for (const directory of ["safe", "outside"] as const) {
  test(`verification cleanup preserves the primary exit when ${directory} cleanup fails or is refused`, () => {
    const result = probe(directory, 23, true);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23, result.stderr);
    assert.equal(JSON.parse(result.stdout).removals.length, directory === "safe" ? 1 : 0);
    assert.match(result.stderr, /cleanup (?:failed|skipped)/);
    assert.doesNotMatch(result.stderr, /synthetic private cleanup detail/);
  });
}

test("verification cleanup failure makes an otherwise successful run fail", () => {
  const result = probe("safe", 0, true);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).removals.length, 1);
  assert.match(result.stderr, /cleanup failed/);
  assert.doesNotMatch(result.stderr, /synthetic private cleanup detail/);
});
