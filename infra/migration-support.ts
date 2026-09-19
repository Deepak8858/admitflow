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

/** Database/provider errors can include queries or credentials, so only emit reviewed messages/codes. */
export function safeMigrationError(error: unknown) {
  if (error instanceof MigrationError) return error.message;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  return `Migration failed${/^[A-Z0-9_]{2,32}$/.test(code) ? ` (${code})` : ""}. Check the database connection, permissions and reviewed migration files.`;
}
