import { config } from "dotenv";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { migrationPlan, runMigrations, safeMigrationError } from "../infra/migration-support";

async function main() {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    console.log("Usage: tsx scripts/migrate.ts [--dry-run]\n--dry-run validates the Drizzle journal/SQL locally. Without it, applies pending migrations using DATABASE_URL_UNPOOLED.");
    return;
  }
  config({ path: ".env.local", quiet: true });
  if (values["dry-run"]) {
    console.log(JSON.stringify({ mode: "dry-run", databaseContacted: false, migrations: await migrationPlan() }, null, 2));
  } else {
    console.log(JSON.stringify({ mode: "applied", ...await runMigrations() }));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(safeMigrationError(error)); process.exitCode = 1; });
}
