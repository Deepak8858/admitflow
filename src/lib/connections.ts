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
  const connection = connectionFor(workspace, service);
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
  const result = JSON.parse(await readLimitedText(response, 1_000_000));
  assert(result && typeof result === "object" && !result.error, "The provider did not confirm credential readiness.", 422);
  if (service === "openai") assert(result.id === (workspace.ai?.model || "gpt-4.1-mini"), "The OpenAI key cannot access the selected model.", 422);
  if (service === "elevenlabs") assert(secret.voiceId ? result.voice_id === secret.voiceId : typeof result.user_id === "string" && result.user_id.length > 0, "ElevenLabs did not verify the selected account or voice.", 422);
  if (service === "razorpay") assert(result.entity === "collection" && Array.isArray(result.items), "Razorpay did not verify payment-read permissions.", 422);
  return { verifiedAt: isoNow(), readiness: "credentials_verified", ...(service === "elevenlabs" && secret.voiceId ? { voiceId: secret.voiceId } : {}) };
}
/** Called only after provider-specific ownership/OAuth validation at the boundary. */
export async function saveConnection(workspaceId: string, service: Connection["service"], secret: Record<string, string>, externalId: string, label: string, metadata: Record<string, string> = {}) {
  const workspace = await loadWorkspace(workspaceId);
  assert(!workspace.demo, "Create a production institute to connect live services.", 409);
  validateConnectionCredentials(service, secret, externalId, metadata);
  const encrypted = await sealSecret(secret, workspaceId);
  return mutateWorkspace(workspaceId, workspace => {
    assert(!workspace.demo, "Create a production institute to connect live services.", 409);
    const current = workspace.connections!.find(item => item.service === service);
    const safeMetadata = { ...metadata };
    if (service === "whatsapp") {
      safeMetadata.coexistence = current?.externalId === externalId && current.metadata.coexistence === "verified" ? "verified" : metadata.coexistence === "requested" ? "requested" : "standard";
      if (safeMetadata.coexistence === "verified" && current?.metadata.coexistenceVerifiedAt) safeMetadata.coexistenceVerifiedAt = current.metadata.coexistenceVerifiedAt;
      else delete safeMetadata.coexistenceVerifiedAt;
    }
    const data = { id: current?.id || uid(), service, status: metadata.readiness === "unverified" ? "unverified" as const : "connected" as const, externalId, label, updatedAt: isoNow(), secret: encrypted, metadata: safeMetadata };
    if (current) Object.assign(current, data); else workspace.connections!.push(data);
    return { connected: data.status === "connected" };
  });
}
