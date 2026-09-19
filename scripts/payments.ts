import { config } from "dotenv";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPaymentEvents, retryPaymentEvent } from "../src/lib/db/payment-inbox";
import { closeDatabase } from "../src/lib/db/client";

async function main() {
  const { values } = parseArgs({ options: { workspace: { type: "string" }, receipt: { type: "string" }, apply: { type: "boolean" }, help: { type: "boolean" } }, strict: true });
  if (values.help) {
    console.log("Usage: tsx scripts/payments.ts --workspace <UUID> [--receipt <receipt ID> --apply]\nDefault: inspect up to 50 pending/failed events. --apply explicitly retries one receipt; provider reads and local financial writes occur. Never rebinds merchant credentials.");
    return;
  }
  if (!values.workspace || Boolean(values.receipt) !== Boolean(values.apply)) throw new Error("Specify a workspace; replay requires both --receipt and --apply.");
  config({ path: ".env.local", quiet: true });
  if (!process.env.DATABASE_URL) throw new Error("PostgreSQL is required.");
  try {
    const result = values.apply ? { result: await retryPaymentEvent(values.workspace, values.receipt!) } : await inspectPaymentEvents(values.workspace);
    console.log(JSON.stringify(result, null, 2));
    if (values.apply && !["processed", "ignored", "skipped"].includes((result as { result: string }).result)) process.exitCode = 1;
  } finally { await closeDatabase(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Payment inspection/replay failed. Check arguments, database configuration and the receipt's state; no automatic merchant rebind was performed."); process.exitCode = 1; });
}
