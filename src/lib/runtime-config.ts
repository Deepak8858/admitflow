import { rateLimitRedisConfiguration } from "./rate-limit-config";

export type RuntimeRole = "web" | "worker" | "migration";
export interface ConfigurationIssue { variable: string; reason: "missing" | "invalid" }
export function runtimeConfiguration(env: Record<string, string | undefined>, role: RuntimeRole): ConfigurationIssue[] {
  const issues: ConfigurationIssue[] = [];
  const require = (key: string) => { if (!env[key]?.trim()) issues.push({ variable: key, reason: "missing" }); };
  const invalid = (key: string) => { if (!issues.some(issue => issue.variable === key)) issues.push({ variable: key, reason: "invalid" }); };
  const db = role === "migration" ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
  require(db);
  if (env[db]) {
    try { const url = new URL(env[db]); if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) invalid(db); }
    catch { invalid(db); }
  }
  if (role === "web") {
    for (const key of ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD", "APP_BASE_URL", "NEXT_PUBLIC_WORKOS_REDIRECT_URI"]) require(key);
    if (env.WORKOS_COOKIE_PASSWORD && env.WORKOS_COOKIE_PASSWORD.length < 32) invalid("WORKOS_COOKIE_PASSWORD");
    let origin: string | undefined;
    try {
      const url = new URL(env.APP_BASE_URL || "");
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid("APP_BASE_URL");
      else origin = url.origin;
    } catch { if (env.APP_BASE_URL) invalid("APP_BASE_URL"); }
    try {
      const url = new URL(env.NEXT_PUBLIC_WORKOS_REDIRECT_URI || "");
      if (url.origin !== origin || url.pathname !== "/callback" || url.search || url.hash || url.username || url.password) invalid("NEXT_PUBLIC_WORKOS_REDIRECT_URI");
    } catch { if (env.NEXT_PUBLIC_WORKOS_REDIRECT_URI) invalid("NEXT_PUBLIC_WORKOS_REDIRECT_URI"); }
  }
  if (role !== "migration") {
    if (!env.KMS_KEY_ID) require("INTEGRATION_ENCRYPTION_KEY");
    if (!env.KMS_KEY_ID && env.INTEGRATION_ENCRYPTION_KEY && !/^[A-Za-z0-9+/]{43}=$/.test(env.INTEGRATION_ENCRYPTION_KEY)) invalid("INTEGRATION_ENCRYPTION_KEY");
    if (env.DATABASE_POOL_SIZE && (!/^\d+$/.test(env.DATABASE_POOL_SIZE) || Number(env.DATABASE_POOL_SIZE) < 1 || Number(env.DATABASE_POOL_SIZE) > 100)) invalid("DATABASE_POOL_SIZE");
  }
  if (role !== "migration") issues.push(...rateLimitRedisConfiguration(env).issues);
  return issues;
}
