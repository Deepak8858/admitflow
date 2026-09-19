import { config } from "dotenv";
import { parseArgs } from "node:util";
import { runtimeConfiguration, type RuntimeRole } from "../src/lib/runtime-config";

try {
  const { values } = parseArgs({ options: { role: { type: "string", default: "web" }, help: { type: "boolean" } }, strict: true });
  if (values.help) console.log("Usage: tsx scripts/preflight.ts [--role web|worker|migration]\nChecks configuration only; never connects to a database or provider and never prints values.");
  else {
    if (!["web", "worker", "migration"].includes(values.role!)) throw new Error("Invalid role");
    config({ path: ".env.local", quiet: true });
    const issues = runtimeConfiguration(process.env, values.role as RuntimeRole);
    console.log(JSON.stringify({ ready: issues.length === 0, role: values.role, configurationOnly: true, databaseContacted: false, issues }, null, 2));
    if (issues.length) process.exitCode = 1;
  }
} catch { console.error("Preflight could not run. Use --help to check arguments."); process.exitCode = 1; }
