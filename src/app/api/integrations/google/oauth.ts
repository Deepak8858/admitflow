import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { SessionContext } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { AppError, assert } from "@/lib/errors";

export const GOOGLE_STATE_COOKIE = "admitflow_google_oauth";
export const GOOGLE_STATE_PATH = "/api/integrations/google";
export const GOOGLE_STATE_SECONDS = 600;
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"];

const stateSchema = z.object({
  version: z.literal(1), workspaceId: z.string().min(1), actorId: z.string().min(1),
  organizationId: z.string(), nonce: z.string().min(32), challenge: z.string().length(43),
  issuedAt: z.number().int(), expiresAt: z.number().int(),
});
const cookieSchema = z.object({ state: z.string().max(3000), verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) });

function stateKey() {
  const key = process.env.GOOGLE_OAUTH_STATE_SECRET || process.env.WORKOS_COOKIE_PASSWORD || process.env.INTEGRATION_ENCRYPTION_KEY || "";
  assert(Buffer.byteLength(key) >= 32, "Configure GOOGLE_OAUTH_STATE_SECRET with at least 32 random characters.", 503);
  return key;
}
function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const signature = (body: string, key: string) => createHmac("sha256", key).update(`admitflow.google.v1.${body}`).digest("base64url");

export function googleConfiguration() {
  assert(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET, "Google Calendar setup is incomplete. Configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.", 503);
  const origin = new URL(appUrl());
  assert(origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)), "APP_BASE_URL must use HTTPS outside local development.", 503);
  return { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, redirectUri: `${appUrl()}${GOOGLE_STATE_PATH}/callback` };
}

/** The signed state binds the initiating identity and tenant; the HttpOnly cookie also holds the PKCE verifier. */
export function createGoogleState(context: SessionContext, now = Date.now(), key = stateKey()) {
  const verifier = randomBytes(32).toString("base64url");
  const payload = { version: 1, workspaceId: context.workspaceId, actorId: context.actor.id, organizationId: context.workosOrganizationId || "", nonce: randomBytes(24).toString("base64url"), challenge: challengeFor(verifier), issuedAt: now, expiresAt: now + GOOGLE_STATE_SECONDS * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const state = `${body}.${signature(body, key)}`;
  return { state, challenge: payload.challenge, cookie: Buffer.from(JSON.stringify({ state, verifier })).toString("base64url") };
}

export function verifyGoogleState(state: string, cookie: string | undefined, context: SessionContext, now = Date.now(), key = stateKey()) {
  assert(state.length > 0 && state.length <= 3000 && cookie && cookie.length <= 5000, "Google authorization expired. Start the connection again.", 400);
  let stored: z.infer<typeof cookieSchema>;
  let payload: z.infer<typeof stateSchema>;
  try {
    stored = cookieSchema.parse(JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")));
    const parts = state.split(".");
    assert(parts.length === 2 && equal(signature(parts[0], key), parts[1]) && equal(stored.state, state), "Invalid Google authorization state.", 400);
    payload = stateSchema.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
  } catch { throw new AppError("Google authorization could not be verified. Start the connection again.", 400); }
  assert(payload.expiresAt > now && payload.issuedAt <= now + 30_000 && payload.expiresAt - payload.issuedAt === GOOGLE_STATE_SECONDS * 1000, "Google authorization expired. Start the connection again.", 400);
  assert(payload.workspaceId === context.workspaceId && payload.actorId === context.actor.id && payload.organizationId === (context.workosOrganizationId || ""), "Your institute or account changed during authorization. Start again from the intended institute.", 403);
  assert(equal(payload.challenge, challengeFor(stored.verifier)), "Invalid Google authorization verifier.", 400);
  return stored.verifier;
}
