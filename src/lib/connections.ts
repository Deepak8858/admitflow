import type { Workspace, Connection } from "./domain";
import { isoNow, uid } from "./domain";
import { assert, AppError } from "./errors";
import { openSecret, sealSecret } from "./secrets";
import { loadWorkspace, mutateWorkspace } from "./store";
import { readLimitedText } from "./http";

export function connectionFor(workspace: Workspace, service: Connection["service"]) { return workspace.connections?.find(item => item.service === service && item.status === "connected"); }
export function validProviderKey(service: "openai" | "elevenlabs", key: string | undefined) {
  return service === "openai" ? /^sk-[A-Za-z0-9_-]{16,1000}$/.test(key || "") : /^(?:sk_[A-Za-z0-9_-]{16,200}|[a-fA-F0-9]{32,64})$/.test(key || "");
}
export function validateConnectionCredentials(service: Connection["service"], secret: Record<string, string>, externalId: string, metadata: Record<string, string> = {}) {
  assert(Object.keys(secret).length > 0 && Object.keys(secret).length <= 12 && Object.values(secret).every(value => typeof value === "string" && value.length <= 10000 && !/[\r\n\0]/.test(value)), "Enter valid provider credentials.");
  if (service === "openai" || service === "elevenlabs") assert(validProviderKey(service, secret.apiKey), `Enter a valid ${service === "openai" ? "OpenAI" : "ElevenLabs"} API key.`);
  if (service === "elevenlabs" && secret.voiceId) assert(/^[A-Za-z0-9_-]{8,100}$/.test(secret.voiceId), "Enter a valid ElevenLabs voice ID.");
  if (["whatsapp", "meta_leads"].includes(service)) {
    assert(/^\d{1,80}$/.test(externalId) && /^[A-Za-z0-9_.|~-]{10,10000}$/.test(secret.accessToken || ""), "Enter a numeric Meta account ID and a valid access token.");
    if (service === "whatsapp") assert(/^\d{1,80}$/.test(metadata.wabaId || ""), "Enter a valid WhatsApp Business Account ID.");
  }
  if (service === "razorpay") assert(/^rzp_(test|live)_[A-Za-z0-9]{8,100}$/.test(secret.keyId || "") && (secret.keySecret || "").length >= 16, "Enter a valid Razorpay key ID and secret.");
  if (service === "google") assert((secret.refreshToken || "").length >= 10, "Reconnect Google Calendar with offline access.");
}
export async function credentials(workspace: Workspace, service: Connection["service"]): Promise<Record<string, string>> {
  assert(!workspace.demo, "Demo workspaces do not use live provider credentials.", 409);
  const connection = workspace.connections?.find(item => item.service === service);
  assert(!connection || (connection.status === "connected" && connection.secret), `Connect ${service} in Integrations first.`, 409);
  if (connection?.secret) {
    const value = await openSecret(connection.secret, workspace.id);
    validateConnectionCredentials(service, value, connection.externalId, connection.metadata);
    return value;
  }
  if (service === "openai" && validProviderKey("openai", process.env.OPENAI_API_KEY)) return { apiKey: process.env.OPENAI_API_KEY! };
  if (service === "elevenlabs" && validProviderKey("elevenlabs", process.env.ELEVENLABS_API_KEY)) return { apiKey: process.env.ELEVENLABS_API_KEY!, voiceId: process.env.ELEVENLABS_VOICE_ID || "" };
  throw new AppError(`Connect ${service} in Integrations first.`, 409);
}

/** Read-only credential checks. These do not send WhatsApp messages or charge a student. */
export async function verifyProviderCredentials(workspace: Workspace, service: "openai" | "elevenlabs" | "razorpay", secret: Record<string, string>) {
  assert(!workspace.demo, "Demo workspaces cannot verify live services.", 409);
  validateConnectionCredentials(service, secret, workspace.id);
  const url = service === "openai" ? `https://api.openai.com/v1/models/${encodeURIComponent(workspace.ai?.model || "gpt-4.1-mini")}` : service === "elevenlabs" ? (secret.voiceId ? `https://api.elevenlabs.io/v1/voices/${encodeURIComponent(secret.voiceId)}` : "https://api.elevenlabs.io/v1/user") : "https://api.razorpay.com/v1/payments?count=1";
  const headers: Record<string, string> = service === "elevenlabs" ? { "xi-api-key": secret.apiKey } : { Authorization: service === "openai" ? `Bearer ${secret.apiKey}` : `Basic ${Buffer.from(`${secret.keyId}:${secret.keySecret}`).toString("base64")}` };
  const response = await fetch(url, { headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000) });
  assert(response.ok, `${service} could not verify these credentials or resource permissions (${response.status}).`, response.status >= 500 || response.status === 429 ? 503 : 422);
  const body = await readLimitedText(response, 1_000_000);
  let result;
  try { result = JSON.parse(body); }
  catch { throw new AppError("The provider returned an unreadable verification response. Retry verification.", 502); }
  assert(result && typeof result === "object" && !result.error, "The provider did not confirm credential readiness.", 422);
  if (service === "openai") assert(result.id === (workspace.ai?.model || "gpt-4.1-mini"), "The OpenAI key cannot access the selected model.", 422);
  if (service === "elevenlabs") assert(secret.voiceId ? result.voice_id === secret.voiceId : typeof result.user_id === "string" && result.user_id.length > 0, "ElevenLabs did not verify the selected account or voice.", 422);
  if (service === "razorpay") assert(result.entity === "collection" && Array.isArray(result.items), "Razorpay did not verify payment-read permissions.", 422);
  return { verifiedAt: isoNow(), readiness: "credentials_verified", ...(service === "elevenlabs" && secret.voiceId ? { voiceId: secret.voiceId } : {}) };
}
type ConnectionVersion = Pick<Connection, "id" | "updatedAt" | "status" | "secret"> | null;
export function assertConnectionVersion(workspace: Workspace, service: Connection["service"], expected: ConnectionVersion) {
  const current = workspace.connections?.find(item => item.service === service);
  assert(expected ? current?.id === expected.id && current.updatedAt === expected.updatedAt && current.status === expected.status && current.secret === expected.secret : !current, "This connection changed during verification. Refresh and reconnect deliberately.", 409);
}
function nextConnectionTime(connection?: Connection) {
  const previous = Date.parse(connection?.updatedAt || "");
  return new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
}
/** Retain identity, never usable credentials. Unresolved setup routes only return retryable callbacks. */
async function disconnectGoogle(workspaceId: string) {
  const snapshot = await loadWorkspace(workspaceId);
  const connection = snapshot.connections?.find(item => item.service === "google") || null;
  if (connection?.secret) {
    assert(!snapshot.demo, "Demo workspaces cannot revoke live services.", 409);
    // Decrypt before fencing so a missing local key cannot strand a usable grant.
    const secret = await openSecret(connection.secret, workspaceId);
    validateConnectionCredentials("google", secret, connection.externalId, connection.metadata);
    const fenced = await mutateWorkspace(workspaceId, workspace => {
      assertConnectionVersion(workspace, "google", connection);
      const current = workspace.connections!.find(item => item.service === "google")!;
      // An abandoned fence can be retried only by another explicit disconnect.
      // The previous request's provider timeout is 15 seconds.
      assert(current.metadata.googleRevocation !== "pending" || Date.now() - Date.parse(current.updatedAt) > 30_000, "Google disconnect is already in progress. Retry after it finishes.", 409);
      current.status = "error";
      current.metadata = { ...current.metadata, googleRevocation: "pending" };
      current.updatedAt = nextConnectionTime(current);
      return { ...current };
    });
    let revoked = false;
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: secret.refreshToken }),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
      // A generic 400 does not establish revocation. Only an explicit invalid
      // token response permits deleting a grant Google no longer recognizes.
      revoked = response.ok || response.status === 400
        && JSON.parse(await readLimitedText(response, 10_000))?.error === "invalid_token";
    } catch {
      // A lost response is ambiguous. Keep the token but leave the connection disabled.
    }
    await mutateWorkspace(workspaceId, workspace => {
      assertConnectionVersion(workspace, "google", fenced.result);
      const current = workspace.connections!.find(item => item.service === "google")!;
      if (revoked) {
        current.status = "disconnected";
        delete current.secret;
        current.metadata = {};
      } else {
        current.metadata = { ...current.metadata, googleRevocation: "uncertain" };
      }
      current.updatedAt = nextConnectionTime(current);
    });
    assert(revoked, "Google could not confirm calendar revocation. The connection is disabled; retry disconnecting before reconnecting.", 503);
    return;
  }
  return mutateWorkspace(workspaceId, workspace => {
    assertConnectionVersion(workspace, "google", connection);
    const current = workspace.connections?.find(item => item.service === "google");
    if (!current) return;
    current.status = "disconnected";
    current.metadata = {};
    current.updatedAt = nextConnectionTime(current);
  });
}
export async function disconnectConnection(workspaceId: string, service: Connection["service"]) {
  if (service === "google") return disconnectGoogle(workspaceId);
  return mutateWorkspace(workspaceId, workspace => {
    let connection = workspace.connections?.find(item => item.service === service);
    if (!connection && (service === "openai" || service === "elevenlabs")) {
      connection = { id: uid(), service, status: "disconnected", externalId: workspace.id, label: service, metadata: {}, updatedAt: isoNow() };
      (workspace.connections ||= []).push(connection);
    }
    if (!connection) return;
    connection.status = "disconnected";
    delete connection.secret;
    connection.updatedAt = nextConnectionTime(connection);
    connection.metadata = service === "whatsapp" ? {
      wabaId: connection.metadata.wabaId || "",
      ...(connection.metadata.subscriptionPending === "true" ? { subscriptionPending: "true", subscriptionOperationId: connection.metadata.subscriptionOperationId, setupGeneration: connection.metadata.setupGeneration, subscriptionStatus: "disconnected_pending" } : {}),
    } : {};
  });
}
/** Receipt-bearing accounts cannot be silently rebound, even after disconnect. */
export function assertIntakeConnectionIdentity(workspace: Workspace, service: Connection["service"], externalId: string, metadata: Record<string, string> = {}) {
  if (service !== "whatsapp" && service !== "meta_leads") return;
  const current = workspace.connections?.find(item => item.service === service);
  assert(!current || (current.externalId === externalId && (service !== "whatsapp" || current.metadata.wabaId === metadata.wabaId)), "Reconnect the original provider account. Changing a retained intake binding requires operator review.", 409);
}
/** Called only after provider-specific ownership/OAuth validation at the boundary. */
export async function saveConnection(workspaceId: string, service: Connection["service"], secret: Record<string, string>, externalId: string, label: string, metadata: Record<string, string> = {}, expected?: ConnectionVersion) {
  const workspace = await loadWorkspace(workspaceId);
  const version = expected === undefined ? workspace.connections?.find(item => item.service === service) || null : expected;
  assertConnectionVersion(workspace, service, version);
  assert(!workspace.demo, "Create a production institute to connect live services.", 409);
  validateConnectionCredentials(service, secret, externalId, metadata);
  assertIntakeConnectionIdentity(workspace, service, externalId, metadata);
  const encrypted = await sealSecret(secret, workspaceId);
  return mutateWorkspace(workspaceId, workspace => {
    assert(!workspace.demo, "Create a production institute to connect live services.", 409);
    assertIntakeConnectionIdentity(workspace, service, externalId, metadata);
    assertConnectionVersion(workspace, service, version);
    const current = workspace.connections!.find(item => item.service === service);
    if (service === "google") assert(!current?.metadata.googleRevocation, "Finish disconnecting Google Calendar before reconnecting.", 409);
    const safeMetadata = { ...metadata };
    if (service === "whatsapp") {
      safeMetadata.coexistence = current?.externalId === externalId && current.metadata.coexistence === "verified" ? "verified" : metadata.coexistence === "requested" ? "requested" : "standard";
      if (safeMetadata.coexistence === "verified" && current?.metadata.coexistenceVerifiedAt) safeMetadata.coexistenceVerifiedAt = current.metadata.coexistenceVerifiedAt;
      else delete safeMetadata.coexistenceVerifiedAt;
    }
    const data = { id: current?.id || uid(), service, status: metadata.readiness === "unverified" ? "unverified" as const : "connected" as const, externalId, label, updatedAt: nextConnectionTime(current), secret: encrypted, metadata: safeMetadata };
    if (current) Object.assign(current, data); else workspace.connections!.push(data);
    return { connected: data.status === "connected" };
  });
}
