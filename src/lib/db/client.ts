import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { admitflowPostgres?: NodePgDatabase<typeof schema>; admitflowPool?: Pool; admitflowTestDatabase?: boolean };
export type Database = NodePgDatabase<typeof schema>;
export function testDatabaseInjected() { return globalDb.admitflowTestDatabase === true; }
export function database(): Database {
  if (!globalDb.admitflowPostgres) {
    if (!process.env.DATABASE_URL) throw new Error("Neon DATABASE_URL is not configured.");
    globalDb.admitflowPool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_SIZE || 8), connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
    globalDb.admitflowPostgres = drizzle(globalDb.admitflowPool, { schema });
    globalDb.admitflowTestDatabase = false;
  }
  return globalDb.admitflowPostgres;
}
export async function closeDatabase() {
  const pool = globalDb.admitflowPool;
  delete globalDb.admitflowPool;
  delete globalDb.admitflowPostgres;
  delete globalDb.admitflowTestDatabase;
  if (pool) await pool.end();
}
export function useTestDatabase(db: Database) {
  if (process.env.NODE_ENV === "production") throw new Error("Test database injection is disabled in production.");
  globalDb.admitflowPostgres = db;
  globalDb.admitflowTestDatabase = true;
}
