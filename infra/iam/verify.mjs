import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verificationEnvironment } from "../../scripts/verify.mjs";

const root = resolve(import.meta.dirname, "../..");
const directory = mkdtempSync(join(tmpdir(), "admitflow-iam-verification-"));
try {
  const env = verificationEnvironment(process.env, readFileSync(join(root, ".env.example"), "utf8"), directory);
  const commands = ["generate.mjs", "validation.mjs", "fixtures.mjs", "policies.test.mjs"].map(file => ["--check", `infra/iam/${file}`]);
  commands.push(["--test", "infra/iam/policies.test.mjs"]);
  for (const args of commands) {
    const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: "inherit", timeout: 60_000 });
    if (result.error || result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} finally { rmSync(directory, { recursive: true, force: true }); }
