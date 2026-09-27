import { createHash } from "node:crypto";
import Redis from "ioredis";
import { AppError } from "./errors";
import { productionDatabase } from "./config";
import { rateLimitRedisConfiguration } from "./rate-limit-config";

type Identity = { kind: "workspace"; actorId: string; tenantId: string } | { kind: "organizations"; actorId: string; create: boolean };
type Evaluate = (script: string, keys: string[], args: number[]) => Promise<unknown>;
const MINUTE = 60_000, HOUR = 60 * MINUTE;
export const mutationRateBudgets = Object.freeze({ actor: 120, tenant: 1200, organizations: 30, creation: 5 });

// One transaction checks every budget before charging any of them. Rejected
// traffic neither grows counters nor extends their expiry or burns tenant quota.
const COUNTERS = `
local retry = 0
for i, key in ipairs(KEYS) do
  local raw = redis.call('GET', key)
  local count = tonumber(raw or '0')
  if not count or count < 0 or count ~= math.floor(count) then
    return redis.error_reply('Invalid rate counter')
  end
  local window = tonumber(ARGV[i * 2])
  local ttl = redis.call('PTTL', key)
  if raw and (ttl < 0 or ttl > window) then
    redis.call('PEXPIRE', key, window)
    ttl = window
  end
  if count >= tonumber(ARGV[i * 2 - 1]) then retry = math.max(retry, math.max(1, ttl)) end
end
if retry > 0 then return {0, retry} end
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 then redis.call('PEXPIRE', key, ARGV[i * 2]) end
end
return {1, 0}
`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function unavailable() { return new AppError("Changes are temporarily unavailable because request protection could not be checked. Please retry shortly.", 503, "RATE_LIMIT_UNAVAILABLE"); }

type Connection = { client: Redis; ready?: Promise<void> };
let connection: Connection | undefined;
async function evaluate(script: string, keys: string[], args: number[]) {
  if (!connection) {
    const config = rateLimitRedisConfiguration(process.env);
    if (!config.url) throw unavailable();
    const client = new Redis(config.url, {
      lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
      connectTimeout: 1500, commandTimeout: 1500, autoResendUnfulfilledCommands: false,
      retryStrategy: attempt => Math.min(attempt * 250, 5000),
      reconnectOnError: error => error.message.startsWith("READONLY") ? 1 : false,
    });
    client.on("error", () => { /* The caller receives a redacted 503. */ });
    const state: Connection = { client };
    connection = state;
    state.ready = client.connect().finally(() => { state.ready = undefined; });
  }
  if (connection.ready) await connection.ready;
  if (connection.client.status !== "ready") throw unavailable();
  return connection.client.eval(script, keys.length, ...keys, ...args);
}

/** Dependency injection keeps synthetic tests off production Redis; callers supply only verified identity. */
export function createMutationRateLimiter(run: Evaluate) {
  const charged = new WeakMap<Request, { identity: string; result: Promise<void> }>();
  return function limit(request: Request, identity: Identity): Promise<void> {
    if (process.env.NODE_ENV !== "production" || !productionDatabase() || ["GET", "HEAD", "OPTIONS"].includes(request.method)) return Promise.resolve();
    if (!identity.actorId || identity.actorId.length > 200 || (identity.kind === "workspace" && (!identity.tenantId || identity.tenantId.length > 200))) return Promise.reject(unavailable());
    const fingerprint = JSON.stringify(identity);
    const previous = charged.get(request);
    if (previous) return previous.identity === fingerprint ? previous.result : Promise.reject(unavailable());
    const result = (async () => {
      const actor = digest(identity.actorId);
      const prefix = "admitflow:mutation-rate:v1:";
      const keys: string[] = [], args: number[] = [];
      const budget = (key: string, count: number, window: number) => { keys.push(prefix + key); args.push(count, window); };
      if (identity.kind === "workspace") {
        const tenant = digest(identity.tenantId);
        budget(`tenant:${tenant}:actor:${actor}`, mutationRateBudgets.actor, MINUTE);
        budget(`tenant:${tenant}`, mutationRateBudgets.tenant, MINUTE);
      } else {
        // Account actions can precede institute membership. Never use a requested
        // organization ID or a stale session organization to charge another tenant.
        budget(`account:${actor}`, mutationRateBudgets.organizations, MINUTE);
        if (identity.create) budget(`create:${actor}`, mutationRateBudgets.creation, HOUR);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reply: unknown;
      try {
        reply = await Promise.race([
          run(COUNTERS, keys, args),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 2500); }),
        ]);
      } catch { throw unavailable(); }
      finally { clearTimeout(timer); }
      if (!Array.isArray(reply) || reply.length !== 2 || ![0, 1].includes(reply[0]) || !Number.isSafeInteger(reply[1]) || reply[1] < 0 || reply[1] > HOUR
        || (reply[0] === 1 && reply[1] !== 0) || (reply[0] === 0 && reply[1] === 0)) throw unavailable();
      if (reply[0] === 0) throw new AppError(`Too many changes. Retry in ${Math.ceil(reply[1] / 1000)} seconds.`, 429, "RATE_LIMITED");
    })();
    charged.set(request, { identity: fingerprint, result });
    return result;
  };
}

export const enforceMutationRateLimit = createMutationRateLimiter(evaluate);
