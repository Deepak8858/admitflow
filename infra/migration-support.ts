import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

export class MigrationError extends Error {}
export interface MigrationEntry { tag: string; when: number; sha256: string; statements: number }

/** Fail closed on unjournaled SQL, changed history or an invalid journal; never sort SQL by filename. */
export async function migrationPlan(folder = resolve(process.cwd(), "drizzle")): Promise<MigrationEntry[]> {
  const journal = JSON.parse(await readFile(resolve(folder, "meta", "_journal.json"), "utf8")) as {
    dialect?: string; entries?: { idx: number; tag: string; when: number; breakpoints: boolean }[];
  };
  if (journal.dialect !== "postgresql" || !Array.isArray(journal.entries) || !journal.entries.length) throw new MigrationError("A non-empty PostgreSQL Drizzle journal is required.");
  let previousTime = 0;
  const tags = new Set<string>();
  for (const [index, entry] of journal.entries.entries()) {
    if (entry.idx !== index || !/^\d{4}_[A-Za-z0-9_-]+$/.test(entry.tag) || tags.has(entry.tag) || !Number.isSafeInteger(entry.when) || entry.when <= previousTime || typeof entry.breakpoints !== "boolean") {
      throw new MigrationError("Drizzle journal entries must have unique safe tags and increasing indexes/timestamps.");
    }
    tags.add(entry.tag); previousTime = entry.when;
  }
  const sqlFiles = (await readdir(folder)).filter(name => name.endsWith(".sql"));
  if (sqlFiles.length !== tags.size || sqlFiles.some(name => !tags.has(name.slice(0, -4)))) throw new MigrationError("Every drizzle/*.sql file must have exactly one Drizzle journal entry.");
  const files = readMigrationFiles({ migrationsFolder: folder });
  return journal.entries.map((entry, index) => ({ tag: entry.tag, when: entry.when, sha256: files[index].hash, statements: files[index].sql.filter(sql => sql.trim()).length }));
}

export function unpooledDatabaseUrl(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (!env.DATABASE_URL_UNPOOLED) throw new MigrationError("DATABASE_URL_UNPOOLED is required; the pooled runtime URL is never used for migrations.");
  let url: URL;
  try { url = new URL(env.DATABASE_URL_UNPOOLED); } catch { throw new MigrationError("DATABASE_URL_UNPOOLED must be a PostgreSQL connection URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new MigrationError("DATABASE_URL_UNPOOLED must use postgres:// or postgresql://.");
  if (/-pooler(?:\.|$)/i.test(url.hostname)) throw new MigrationError("DATABASE_URL_UNPOOLED points to a Neon pooler; use the direct endpoint.");
  return env.DATABASE_URL_UNPOOLED;
}

export function verifyMigrationHistory(plan: MigrationEntry[], rows: { hash: string; created_at: string | number }[]) {
  if (rows.length > plan.length) throw new MigrationError("The database has migrations newer than this release. Do not downgrade its migration history.");
  for (const [index, row] of rows.entries()) {
    if (Number(row.created_at) !== plan[index].when || row.hash !== plan[index].sha256) throw new MigrationError("Applied migration history differs from this release. Restore the reviewed journal/SQL before continuing.");
  }
}

async function history(client: PoolClient) {
  const table = await client.query<{ name: string | null }>("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name");
  if (!table.rows[0]?.name) return [];
  return (await client.query<{ hash: string; created_at: string }>('SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows;
}

export async function runMigrations(folder = resolve(process.cwd(), "drizzle")) {
  const plan = await migrationPlan(folder);
  const pool = new Pool({ connectionString: unpooledDatabaseUrl(), max: 1, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 5_000, application_name: "admitflow-migrations" });
  let client: PoolClient | undefined, locked = false;
  try {
    client = await pool.connect();
    await client.query("SET statement_timeout = '5min'; SET lock_timeout = '10s'");
    locked = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(194821, 1) AS acquired")).rows[0]?.acquired === true;
    if (!locked) throw new MigrationError("Another AdmitFlow migration is running.");
    const applied = await history(client);
    verifyMigrationHistory(plan, applied);
    // Pin migration execution and the advisory lock to the same database session.
    await migrate(drizzle(client), { migrationsFolder: folder, migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" });
    const after = await history(client);
    verifyMigrationHistory(plan, after);
    if (after.length !== plan.length) throw new MigrationError("Migration verification did not reach the end of the journal.");
    return { applied: after.length - applied.length, total: plan.length };
  } finally {
    if (client) {
      if (locked) await client.query("SELECT pg_advisory_unlock(194821, 1)").catch(() => undefined);
      client.release();
    }
    await pool.end();
  }
}

// Keep this exact pair allowlist tied to the historical 0010 preflight, not the current schema.
const legacyInstantColumns = new Set([
  "activities.created_at", "appointments.starts_at", "articles.updated_at", "campaigns.created_at", "connections.updated_at",
  "event_receipts.received_at", "event_receipts.processed_at", "files.created_at", "files.finalized_at",
  "institute_trials.started_at", "institute_trials.ends_at", "intake_inbox.received_at", "intake_inbox.processed_at",
  "jobs.due_at", "jobs.locked_at", "jobs.dispatched_at", "leads.next_action_at", "leads.created_at", "leads.last_contact_at",
  "leads.last_inbound_at", "leads.consent_at", "messages.created_at", "messages.received_at", "messages.status_at",
  "messages.dispatched_at", "organization_provisioning.created_at", "organization_provisioning.updated_at",
  "organization_provisioning.acknowledged_at", "payments.recorded_at", "refunds.recorded_at", "tasks.due_at",
]);
const legacyInstantPrefix = "Invalid legacy instant counts: ";

function legacyInstantDiagnostic(message: string) {
  if (message.length > 2048 || !message.startsWith(legacyInstantPrefix)) return;
  const entries = message.slice(legacyInstantPrefix.length).split(", ");
  if (entries.length > legacyInstantColumns.size) return;
  const seen = new Set<string>(), counts: string[] = [];
  for (const entry of entries) {
    const match = /^([a-z_]+\.[a-z_]+)=([1-9][0-9]{0,15})$/.exec(entry);
    // Equality also rejects a final newline, which JavaScript's $ anchor permits.
    if (!match || match[0] !== entry || !legacyInstantColumns.has(match[1]) || seen.has(match[1])) return;
    const count = Number(match[2]);
    if (!Number.isSafeInteger(count) || count <= 0) return;
    seen.add(match[1]); counts.push(`${match[1]}=${count}`);
  }
  return legacyInstantPrefix + counts.join(", ");
}

// Do not invoke getters or coerce arbitrary provider objects while formatting failures.
function ownErrorValue(error: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(error, key);
  if ((property && !("value" in property)) || (!property && key in error)) throw new Error("Invalid error property");
  return property?.value;
}

function wrappedLegacyInstantDiagnostic(error: unknown) {
  const seen = new Set<object>();
  let current = error;
  // Eight total objects covers Drizzle/transaction wrappers without unbounded cause walks.
  for (let depth = 0; depth < 8; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current) || seen.has(current)) return;
    seen.add(current);
    const message = ownErrorValue(current, "message"), code = ownErrorValue(current, "code"), cause = ownErrorValue(current, "cause");
    if (typeof message !== "string") return;
    if (cause === undefined || cause === null) return code === "22007" ? legacyInstantDiagnostic(message) : undefined;
    // Only a terminal database error qualifies; cycles/malformed tails never expose a partial match.
    current = cause;
  }
}

/** Database/provider errors can include queries or credentials, so only emit reviewed messages/codes. */
export function safeMigrationError(error: unknown) {
  let code = "";
  try {
    if (error instanceof MigrationError) return error.message;
    const value = error && typeof error === "object" ? ownErrorValue(error, "code") : undefined;
    if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) {
      const candidate = String(value);
      if (/^[A-Z0-9_]{2,32}$/.exec(candidate)?.[0] === candidate) code = candidate;
    }
    const diagnostic = wrappedLegacyInstantDiagnostic(error);
    if (diagnostic) return diagnostic;
  } catch { /* Malformed wrappers and accessors fail closed without their messages. */ }
  return `Migration failed${code ? ` (${code})` : ""}. Check the database connection, permissions and reviewed migration files.`;
}
