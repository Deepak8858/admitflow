type Environment = Record<string, string | undefined>;
type Issue = { variable: string; reason: "missing" | "invalid" };

/** Shared by preflight and the limiter. Never include configuration values in errors. */
export function rateLimitRedisConfiguration(env: Environment): { url?: string; issues: Issue[] } {
  const issues: Issue[] = [];
  if (env.REDIS_HOST && !env.REDIS_URL) {
    if (!env.REDIS_PASSWORD?.trim()) issues.push({ variable: "REDIS_PASSWORD", reason: "missing" });
    if (env.REDIS_TLS !== "true") issues.push({ variable: "REDIS_TLS", reason: "invalid" });
    const port = env.REDIS_PORT || "6379";
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) issues.push({ variable: "REDIS_PORT", reason: "invalid" });
    const url = new URL("rediss://redis.invalid");
    url.hostname = env.REDIS_HOST;
    if (url.hostname !== env.REDIS_HOST.toLowerCase() || !env.REDIS_HOST.trim()) issues.push({ variable: "REDIS_HOST", reason: "invalid" });
    if (issues.length) return { issues };
    url.port = port; url.password = env.REDIS_PASSWORD!;
    return { url: url.toString(), issues };
  }
  if (!env.REDIS_URL?.trim()) return { issues: [{ variable: "REDIS_URL", reason: "missing" }] };
  try {
    const url = new URL(env.REDIS_URL);
    if (!url.password) throw new Error();
    if (env.REDIS_URL.trim() !== env.REDIS_URL || url.protocol !== "rediss:" || !url.hostname || url.port === "0" || url.search || url.hash
      || (url.pathname && url.pathname !== "/" && (!/^\/\d+$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))))) throw new Error();
    decodeURIComponent(url.username); decodeURIComponent(url.password);
    return { url: url.toString(), issues };
  } catch { return { issues: [{ variable: "REDIS_URL", reason: "invalid" }] }; }
}
