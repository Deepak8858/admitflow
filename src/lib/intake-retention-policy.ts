import { createHash, createHmac } from "node:crypto";
import { assert } from "./errors";

export const INTAKE_MAX_AGE_MS = 30 * 86400_000;
export const INTAKE_IMPORTED_AGE_MS = 7 * 86400_000;
export function intakeExpiry(receivedAt: string, processedAt?: string | null) {
  return new Date(Math.min(Date.parse(receivedAt) + INTAKE_MAX_AGE_MS, processedAt ? Date.parse(processedAt) + INTAKE_IMPORTED_AGE_MS : Infinity)).toISOString();
}

/** First key is active. Keep historical keys while any pseudonymous receipt references them. */
export function intakeContactKeys(env: Record<string, string | undefined> = process.env) {
  let values: unknown;
  try { values = JSON.parse(env.INTAKE_CONTACT_KEYS || "[]"); } catch { values = null; }
  assert(Array.isArray(values) && values.length >= 1 && values.length <= 4 && values.every(value => typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").toString("base64") === value), "Configure INTAKE_CONTACT_KEYS with one to four base64 32-byte keys before intake or cleanup.", 503);
  const keys = (values as string[]).map(value => {
    const key = Buffer.from(value, "base64");
    return { key, version: createHash("sha256").update(key).digest("hex") };
  });
  assert(new Set(keys.map(item => item.version)).size === keys.length, "INTAKE_CONTACT_KEYS must contain distinct keys.", 503);
  return keys;
}
export function intakeContactIdentity(workspaceId: string, phone: string, version?: string) {
  const keys = intakeContactKeys(), selected = version ? keys.find(item => item.version === version) : keys[0];
  assert(selected, "A retained intake contact key is unavailable. Restore historical keys before continuing.", 503);
  return { contactKey: phone ? createHmac("sha256", selected.key).update(JSON.stringify(["intake-contact-v1", workspaceId, phone])).digest("hex") : "", contactKeyVersion: selected.version };
}
/** Unknown key versions fail closed, rather than silently losing opt-out/history holds. */
export function intakeHeldPhones(workspaceId: string, phones: string[], rows: { contactKey: string; contactKeyVersion: string }[]) {
  const held = new Set<string>(), versions = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.contactKey) continue;
    const contacts = versions.get(row.contactKeyVersion) || new Set<string>();
    contacts.add(row.contactKey); versions.set(row.contactKeyVersion, contacts);
  }
  for (const [version, contacts] of versions) {
    // Legacy clear-text keys are only a transitional read path; cleanup upgrades them before cutover.
    if (!version) { for (const phone of phones) if (contacts.has(phone)) held.add(phone); continue; }
    intakeContactIdentity(workspaceId, "", version);
    for (const phone of phones) if (contacts.has(intakeContactIdentity(workspaceId, phone, version).contactKey)) held.add(phone);
  }
  return held;
}
