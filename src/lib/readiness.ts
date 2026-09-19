import { Pool } from "pg";
import { runtimeConfiguration } from "./runtime-config";

export type Readiness = { status: "ready" | "not-ready"; mode: "local" | "hosted" };
let pool: Pool | undefined;
let cached: { until: number; ok: boolean } | undefined;
let pending: Promise<boolean> | undefined;

/** One short-lived connection per process, independent of a saturated application pool. */
async function probeDatabase() {
  if (cached && cached.until > Date.now()) return cached.ok;
  if (pending) return pending;
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 1500, idleTimeoutMillis: 5000, statement_timeout: 1500, query_timeout: 1800, allowExitOnIdle: true });
    pool.on("error", () => { cached = undefined; });
  }
  pending = pool.query("select 1").then(() => true, () => false).then(ok => { cached = { until: Date.now() + 5000, ok }; return ok; }).finally(() => { pending = undefined; });
  return pending;
}

/** No database/provider details or configuration values are returned to public callers. */
export async function readiness(env: Record<string, string | undefined> = process.env, probe: () => Promise<boolean> = probeDatabase, timeoutMs = 2500): Promise<Readiness> {
  const hosted = Boolean(env.DATABASE_URL || env.ADMITFLOW_PROCESS_ROLE);
  if (!hosted) return { status: "ready", mode: "local" };
  if (runtimeConfiguration(env, "web").length) return { status: "not-ready", mode: "hosted" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ok = await Promise.race([Promise.resolve().then(probe), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]);
    return { status: ok ? "ready" : "not-ready", mode: "hosted" };
  } catch { return { status: "not-ready", mode: "hosted" }; }
  finally { if (timer) clearTimeout(timer); }
}
