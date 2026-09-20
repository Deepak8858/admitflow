import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {Record<string, string | undefined>} parent @param {string} template @param {string} directory */
export function verificationEnvironment(parent, template, directory) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(parent)) if (value !== undefined && /^(path|systemroot|windir|comspec|pathext|temp|tmp|home|userprofile|appdata|localappdata|programfiles|programfiles\(x86\)|programdata|systemdrive)$/i.test(key)) env[key] = value;
  // Extract variable NAMES only. Empty values prevent Next/dotenv loading .env.local credentials.
  for (const match of template.matchAll(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)) env[match[1]] = "";
  Object.assign(env, { DATABASE_URL: "", DATABASE_URL_UNPOOLED: "", ADMITFLOW_DB: ":memory:", ADMITFLOW_BROWSER_DB: join(directory, "browser.sqlite"), APP_BASE_URL: "", NEXT_TELEMETRY_DISABLED: "1", KNOWLEDGE_VECTOR_ENABLED: "false", AWS_EC2_METADATA_DISABLED: "true" });
  env.INTAKE_CONTACT_KEYS = JSON.stringify([Buffer.alloc(32, 17).toString("base64")]);
  return env;
}

function main() {
  const mode = process.argv[2] || "--all";
  if (process.argv.length > 3 || !["--all", "--payments", "--access", "--subscriptions", "--browser", "--typecheck", "--build"].includes(mode)) throw new Error("Usage: node scripts/verify.mjs [--all|--payments|--access|--subscriptions|--browser|--typecheck|--build]");
  const root = resolve(import.meta.dirname, "..");
  const directory = mkdtempSync(join(tmpdir(), "admitflow-verification-"));
  const env = verificationEnvironment(process.env, readFileSync(join(root, ".env.example"), "utf8"), directory);
  if (mode === "--browser") env.APP_BASE_URL = "http://127.0.0.1:3100";
  const tsc = ["node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"];
  const builds = [["node_modules/typescript/bin/tsc", "-p", "infra/tsconfig.json", "--pretty", "false"],
    ["node_modules/next/dist/bin/next", "build"], ["infra/build.mjs"], ["--check", "dist/worker.mjs"],
    ["--check", "dist/payments.mjs"], ["--check", "dist/preflight.mjs"], ["--check", "dist/intake-retention.mjs"], ["dist/intake-retention.mjs", "--help"], ["dist/payments.mjs", "--help"], ["dist/preflight.mjs", "--help"],
    ["node_modules/tsx/dist/cli.mjs", "scripts/migrate.ts", "--dry-run"]];
  const commands = mode === "--payments" ? [["node_modules/tsx/dist/cli.mjs", "--test", "tests/payments.test.ts"], tsc]
    : mode === "--access" ? [["node_modules/tsx/dist/cli.mjs", "--test", "tests/team-access.test.ts", "tests/connected-services.test.ts"], tsc]
    : mode === "--subscriptions" ? [["node_modules/tsx/dist/cli.mjs", "--test", "tests/subscriptions.test.ts", "tests/subscription-intake.test.ts"], tsc]
    : mode === "--typecheck" ? [tsc]
    : mode === "--browser" ? [["node_modules/@playwright/test/cli.js", "test"]]
    : mode === "--build" ? builds
    : [["node_modules/tsx/dist/cli.mjs", "--test", "tests/*.test.ts"], ["node_modules/tsx/dist/cli.mjs", "--test", "infra/tests/*.test.ts"], tsc, ...builds];
  try {
    if (mode === "--all") {
      const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-m", "unittest", "discover", "-s", "tests", "-p", "tooling_audio_test.py"], { cwd: root, env, stdio: "inherit", timeout: 60000 });
      if (python.error || python.status !== 0) { process.exitCode = python.status || 1; return; }
    }
    for (const args of commands) {
      console.log("Verification:", args.join(" "));
      const childEnv = { ...env };
      // Next assigns production/development as appropriate when NODE_ENV is absent.
      delete childEnv.NODE_ENV; delete childEnv.HOSTNAME; delete childEnv.PORT;
      const result = spawnSync(process.execPath, args, { cwd: root, env: childEnv, stdio: "inherit", timeout: mode === "--browser" ? 30 * 60_000 : 10 * 60_000 });
      if (result.error || result.status !== 0) { process.exitCode = result.status || 1; return; }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch { console.error("Local verification could not start. Check the command and installed dependencies."); process.exitCode = 1; }
}
