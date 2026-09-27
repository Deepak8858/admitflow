import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function prepareEnvironment(environment) {
  const env = { ...environment };
  const required = env.ADMITFLOW_PROCESS_ROLE === "migration" ? ["DATABASE_URL_UNPOOLED"] : ["DATABASE_URL"];
  if (env.ADMITFLOW_PROCESS_ROLE === "web") required.push("WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD", "APP_BASE_URL", "NEXT_PUBLIC_WORKOS_REDIRECT_URI");
  if (["web", "worker"].includes(env.ADMITFLOW_PROCESS_ROLE)) required.push("INTAKE_CONTACT_KEYS");
  for (const name of required) if (!env[name]) throw new Error(`Missing required runtime variable: ${name}`);
  if (env.ADMITFLOW_PROCESS_ROLE === "web") {
    if (env.WORKOS_COOKIE_PASSWORD.length < 32) throw new Error("WORKOS_COOKIE_PASSWORD must have at least 32 characters.");
    let url;
    try { url = new URL(env.APP_BASE_URL); } catch { /* Report the variable name, never its value. */ }
    // Reject normalization of paths/credentials/whitespace before AuthKit receives the raw value.
    if (!url || url.protocol !== "https:" || ![url.origin, `${url.origin}/`].includes(env.APP_BASE_URL)) throw new Error("APP_BASE_URL must be a canonical HTTPS origin.");
  }
  if (["web", "worker"].includes(env.ADMITFLOW_PROCESS_ROLE)) {
    let keys;
    try { keys = JSON.parse(env.INTAKE_CONTACT_KEYS); } catch { keys = null; }
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 4 || keys.some(key => typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").toString("base64") !== key) || new Set(keys).size !== keys.length) throw new Error("INTAKE_CONTACT_KEYS requires one to four distinct base64 32-byte keys.");
  }
  if (["web", "worker"].includes(env.ADMITFLOW_PROCESS_ROLE)) {
    // Keep this standalone: the runtime image copies the entrypoint without src/.
    // Focused tests enforce parity with rateLimitRedisConfiguration.
    if (env.REDIS_HOST && !env.REDIS_URL) {
      if (!env.REDIS_PASSWORD?.trim()) throw new Error("Missing required runtime variable: REDIS_PASSWORD");
      if (env.REDIS_TLS !== "true") throw new Error("REDIS_TLS must be true.");
      const port = env.REDIS_PORT || "6379";
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("REDIS_PORT is invalid.");
      const url = new URL("rediss://redis.invalid");
      url.hostname = env.REDIS_HOST;
      if (url.hostname !== env.REDIS_HOST.toLowerCase() || !env.REDIS_HOST.trim()) throw new Error("REDIS_HOST is invalid.");
      url.port = port; url.password = env.REDIS_PASSWORD;
      env.REDIS_URL = url.toString();
      delete env.REDIS_PASSWORD;
    } else {
      if (!env.REDIS_URL?.trim()) throw new Error("Missing required runtime variable: REDIS_URL");
      try {
        const url = new URL(env.REDIS_URL);
        if (env.REDIS_URL.trim() !== env.REDIS_URL || url.protocol !== "rediss:" || !url.hostname || !url.password || url.port === "0" || url.search || url.hash
          || (url.pathname && url.pathname !== "/" && (!/^\/\d+$/.test(url.pathname) || !Number.isSafeInteger(Number(url.pathname.slice(1)))))) throw new Error();
        decodeURIComponent(url.username); decodeURIComponent(url.password);
      } catch { throw new Error("REDIS_URL must be a valid authenticated TLS Redis URL."); }
    }
  }
  return env;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error("A container command is required.");
  const child = spawn(command, args, { env: prepareEnvironment(process.env), stdio: "inherit" });
  // Preserve the worker's SIGTERM drain instead of leaving it behind a shell process.
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
  child.once("error", () => { console.error("Container command could not start."); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1); });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Container configuration failed."); process.exitCode = 1; }
}
