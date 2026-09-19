export function productionDatabase() { return Boolean(process.env.DATABASE_URL); }
export function workosConfigured() { return Boolean(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID && process.env.WORKOS_COOKIE_PASSWORD); }
export function appUrl() { return (process.env.APP_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, ""); }
export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}
export function metaVersion() { return process.env.META_API_VERSION || "v23.0"; }
