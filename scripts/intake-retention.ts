import { config } from "dotenv";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cleanIntakeRetention, inspectIntakeRetention } from "../src/lib/db/intake-retention";
import { closeDatabase } from "../src/lib/db/client";

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: "string" }, limit: { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    console.log("Usage: tsx scripts/intake-retention.ts --workspace <UUID> [--limit 1..500 --apply]\nDefault: read-only counts of expired payloads, legacy contact keys and safety holds. --apply irreversibly redacts one bounded page and upgrades legacy keys. Repeat until expiredPayloads, legacyContactKeys and expiredMetadata are zero before restored services restart. Expired safety holds intentionally remain.");
    return;
  }
  if (!values.workspace || (values.limit && !values.apply)) throw new Error("Invalid arguments");
  config({ path: ".env.local", quiet: true });
  if (!process.env.DATABASE_URL) throw new Error("PostgreSQL required");
  try {
    const changes = values.apply ? await cleanIntakeRetention(values.workspace, values.limit ? Number(values.limit) : 100) : undefined;
    console.log(JSON.stringify({ mode: values.apply ? "apply" : "inspect", changes, ...await inspectIntakeRetention(values.workspace) }));
  } finally { await closeDatabase(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Intake retention failed. Check arguments, runtime database access and retained INTAKE_CONTACT_KEYS. No payload or key values are logged."); process.exitCode = 1; });
}
