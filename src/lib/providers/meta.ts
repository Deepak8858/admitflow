import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { credentials, connectionFor } from "../connections";
import { metaVersion, productionDatabase } from "../config";
import { assert, AppError } from "../errors";
import { type Workspace, type Lead, type Message, uid, isoNow, stopJobs, addActivity, normalizePhone, hydrateWorkspace, resolveOwner, laterTimestamp } from "../domain";
import { loadWorkspace, mutateWorkspace } from "../store";
import { workspaceCapabilities } from "../subscription-access";
import { database } from "../db/client";
import { connectionRoutes } from "../db/schema";
import { constantTimeEqual, readLimitedText } from "../http";
import { assertMessageFile } from "../permissions";

export function validSignature(body: string, supplied: string, secret: string | undefined, prefix = "sha256=") {
  return Boolean(secret && constantTimeEqual(supplied, `${prefix}${createHmac("sha256", secret).update(body).digest("hex")}`));
}
export class MetaRequestError extends AppError {
  constructor(message: string, public readonly rejected: boolean, public readonly retryable: boolean, status = 422) { super(message, status); }
}
export async function graph<T = Record<string, unknown>>(path: string, token: string, body?: unknown, method = body ? "POST" : "GET"): Promise<T> {
  assert(typeof token === "string" && token.length > 0, "Connect WhatsApp with a valid access token.", 409);
  assert(!path.startsWith("/") && !path.includes("..") && !path.includes("://"), "Invalid Meta resource path.");
  const response = await fetch(`https://graph.facebook.com/${metaVersion()}/${path}`, { method, redirect: "error", headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }) }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  let data: { error?: { code?: number; is_transient?: boolean } };
  try { data = JSON.parse(await readLimitedText(response, 2_000_000)); }
  catch { throw new MetaRequestError("Meta returned an unreadable response. Reconcile any message dispatch before retrying.", false, false, 502); }
  if (!response.ok || data.error) {
    // A 5xx response or unreadable response can follow acceptance. Do not infer
    // non-delivery from it. Only explicit client errors establish rejection.
    const rejected = response.status >= 400 && response.status < 500;
    throw new MetaRequestError(`Meta rejected the request (${data.error?.code || response.status}). Check account readiness, permissions and template status.`, rejected, response.status >= 500 || response.status === 429 || data.error?.is_transient === true, response.status === 429 ? 429 : 422);
  }
  return data as T;
}
export interface MetaTemplate { id: string; name: string; language: string; status: string; category: string; components: { type: string; text?: string }[] }
export async function templates(workspace: Workspace) {
  assert(!workspace.demo, "Demo workspaces do not access live templates.", 409);
  const connection = connectionFor(workspace, "whatsapp");
  assert(connection?.metadata.wabaId, "Connect WhatsApp to select a template.");
  const token = (await credentials(workspace, "whatsapp")).accessToken;
  return (await graph<{ data: MetaTemplate[] }>(`${connection.metadata.wabaId}/message_templates?limit=100`, token)).data;
}
export type BeforeDispatch = (prepared: { body: string; mediaType?: string }) => Promise<void>;
export async function sendText(workspace: Workspace, lead: Lead, message: Message, beforeDispatch: BeforeDispatch) {
  assert(!workspace.demo, "Demo workspaces do not send provider messages.", 409);
  const connection = connectionFor(workspace, "whatsapp");
  assert(connection, "Connect WhatsApp in Integrations.", 409);
  const token = (await credentials(workspace, "whatsapp")).accessToken;
  let mediaType: string | undefined;
  let content: Record<string, unknown> = { type: "text", text: { body: message.body, preview_url: false } };
  if (message.fileId) {
    assertMessageFile(workspace, lead.id, message.fileId);
    const { readFileBytes } = await import("../files");
    const { file, bytes } = await readFileBytes(workspace.id, message.fileId);
    mediaType = file.mime.startsWith("audio/") ? "audio" : file.mime.startsWith("image/") ? "image" : "document";
    assert(mediaType === "audio" || message.body.length <= 1024, "Attachment captions support at most 1024 characters. Shorten the caption before sending.");
    const form = new FormData(); form.set("messaging_product", "whatsapp"); form.set("file", new Blob([new Uint8Array(bytes)], { type: file.mime }), file.name);
    const media = await graph<{ id: string }>(`${connection.externalId}/media`, token, form);
    assert(typeof media.id === "string" && media.id.length > 0, "Meta did not accept the attachment.", 502);
    content = { type: mediaType, [mediaType]: { id: media.id, ...(mediaType === "audio" ? {} : { caption: message.body }), ...(mediaType === "document" ? { filename: file.name } : {}) } };
  }
  // There are no credential/template/media awaits between this guard and the
  // actual message POST. Uploading a media object is not a message dispatch.
  await beforeDispatch({ body: message.body, mediaType });
  const result = await graph<{ messages: { id: string }[] }>(`${connection.externalId}/messages`, token, { messaging_product: "whatsapp", to: lead.whatsappId || lead.phone.replace(/^\+/, ""), ...content, biz_opaque_callback_data: message.id });
  assert(result.messages?.[0]?.id, "Meta did not return a message ID. Reconcile this send before retrying.", 409);
  return result.messages[0].id;
}
export async function sendTemplate(workspace: Workspace, lead: Lead, name: string, language: string, requestId: string, beforeDispatch: BeforeDispatch) {
  assert(!workspace.demo, "Demo workspaces do not send provider templates.", 409);
  const connection = connectionFor(workspace, "whatsapp");
  assert(connection, "Connect WhatsApp in Integrations.", 409);
  const template = (await templates(workspace)).find(item => item.name === name && item.language === language && item.status === "APPROVED");
  assert(template, "Select an approved WhatsApp template before sending.");
  const body = template.components.find(component => component.type === "BODY")?.text || "";
  const placeholders = [...new Set([...body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(match => match[1]))];
  const values: Record<string, string> = { "1": lead.name.split(" ")[0], "2": lead.course, "3": workspace.name, name: lead.name.split(" ")[0], course: lead.course, institute: workspace.name };
  assert(placeholders.every(key => Object.hasOwn(values, key)), "Template variables must be name, course, institute or positions 1–3.");
  const parameters = placeholders.map(key => ({ type: "text", text: values[key], ...(/^\d+$/.test(key) ? {} : { parameter_name: key }) }));
  const rendered = body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => values[key]);
  const token = (await credentials(workspace, "whatsapp")).accessToken;
  await beforeDispatch({ body: rendered });
  const result = await graph<{ messages: { id: string }[] }>(`${connection.externalId}/messages`, token, { messaging_product: "whatsapp", to: lead.whatsappId || lead.phone.replace(/^\+/, ""), type: "template", template: { name, language: { code: language }, components: parameters.length ? [{ type: "body", parameters }] : [] }, biz_opaque_callback_data: requestId });
  assert(result.messages?.[0]?.id, "Delivery is uncertain. Check Meta before retrying.", 409);
  return { providerId: result.messages[0].id, body: rendered };
}

export function applyDelivery(message: Message, status: string, when = isoNow()) {
  const rank: Record<string, number> = { queued: 0, accepted: 0, sent: 1, delivered: 2, read: 3 };
  const stale = Boolean(message.statusAt && Date.parse(when) < Date.parse(message.statusAt));
  if (status === "failed") {
    if (!stale && !["delivered", "read"].includes(message.status)) message.status = "failed";
    else return;
  } else if (Object.hasOwn(rank, status) && ["sent", "delivered", "read"].includes(status)) {
    if (message.status === "failed" && stale && status === "sent") return;
    if ((rank[message.status] || 0) > rank[status]) return;
    message.status = status as Message["status"]; message.error = undefined;
  } else return;
  message.statusAt = laterTimestamp(message.statusAt, when);
  message.dispatchState = "accepted";
}

function providerTimestamp(timestamp?: string, receivedAt = isoNow()) {
  if (!timestamp) return receivedAt;
  const millis = Number(timestamp) * 1000;
  if (!Number.isFinite(millis) || millis < 0 || millis > 8.64e15) return receivedAt;
  return new Date(Math.min(millis, Date.parse(receivedAt))).toISOString();
}
export function receiveMessage(workspace: Workspace, event: { id: string; from: string; name?: string; body: string; timestamp?: string; echo?: boolean; verified?: boolean; mediaType?: string; mediaId?: string }, suppressAutomation = false, receivedAt = isoNow()) {
  hydrateWorkspace(workspace);
  if (workspace.messages.some(message => message.providerId === event.id)) return false;
  const phone = normalizePhone(event.from);
  assert(event.id && event.id.length <= 512 && phone, "Invalid WhatsApp message identity.");
  let lead = workspace.leads.find(item => item.whatsappId === event.from || item.phone === phone);
  const when = providerTimestamp(event.timestamp, receivedAt);
  if (!lead) {
    const assignment = workspace.members!.some(member => member.status === "active" && ["owner", "admin", "counsellor"].includes(member.role) && (!workspace.workosOrganizationId || member.workosId)) ? resolveOwner(workspace) : { owner: "Unassigned", ownerId: null };
    lead = { id: uid(), name: event.name?.slice(0, 100) || "WhatsApp enquiry", phone, whatsappId: event.from, email: "", course: "Undecided", source: "WhatsApp", stage: "New", ...assignment, value: 0, notes: "", nextAction: "Respond to enquiry", createdAt: when, lastContactAt: null, lastInboundAt: null, consent: "unknown", consentSource: "", consentAt: null, isMinor: false, guardianConsent: false, humanOwned: workspace.ai?.mode !== "autonomous" };
    workspace.leads.unshift(lead);
  }
  if (Date.parse(when) < Date.parse(lead.createdAt)) lead.createdAt = when;
  const message: Message = { id: uid(), leadId: lead.id, providerId: event.id, body: event.body.slice(0, 4000), direction: event.echo ? "outbound" : "inbound", author: event.echo ? "WhatsApp Business app" : lead.name, status: event.echo ? "sent" : "received", createdAt: when, receivedAt, mediaType: event.mediaType, providerMediaId: event.mediaId, source: event.echo ? "business-app" : "whatsapp" };
  workspace.messages.push(message);
  if (event.echo) {
    lead.humanOwned = true; lead.lastContactAt = laterTimestamp(lead.lastContactAt, when); stopJobs(workspace, lead.id);
    if (event.verified && !workspace.demo) {
      const connection = connectionFor(workspace, "whatsapp");
      if (connection) { connection.metadata.coexistence = "verified"; connection.metadata.coexistenceVerifiedAt = isoNow(); }
    }
    addActivity(workspace, "Business-app reply received · AI paused for this conversation", "message", lead.id);
  } else {
    const optout = /^\s*(stop|unsubscribe|opt[ -]?out|please stop|बंद|रोकें)[.!\s]*$/i.test(event.body);
    if (optout) { lead.consent = "opted_out"; lead.consentSource = "WhatsApp opt-out"; lead.consentAt = laterTimestamp(lead.consentAt, when); lead.humanOwned = true; stopJobs(workspace, lead.id); }
    // Historical messages remain in the thread, but cannot replace the latest
    // student turn, mark it unread again, or cancel its already scheduled reply.
    if (!lead.lastInboundAt || Date.parse(when) >= Date.parse(lead.lastInboundAt)) {
      lead.lastInboundAt = when; lead.lastInboundMessageId = message.id; lead.unread = true; lead.whatsappId = event.from;
      stopJobs(workspace, lead.id);
      if (!suppressAutomation && !lead.intakePending && workspaceCapabilities(workspace).allowed && workspace.ai?.mode === "autonomous" && !lead.humanOwned && lead.consent !== "opted_out" && !(lead.isMinor && !lead.guardianConsent) && !["Admitted", "Lost"].includes(lead.stage)) workspace.jobs.push({ id: uid(), leadId: lead.id, campaignId: "", kind: "ai.reply", sourceMessageId: message.id, step: 0, status: "pending", dueAt: new Date(Date.now() + 2000).toISOString() });
    }
    addActivity(workspace, `${lead.name} replied on WhatsApp`, "message", lead.id);
  }
  return true;
}

const statusSchema = z.object({ id: z.string().min(1).max(512), status: z.enum(["sent", "delivered", "read", "failed"]), timestamp: z.string().max(20).optional(), recipient_id: z.string().max(30).optional(), biz_opaque_callback_data: z.string().max(100).optional(), errors: z.array(z.object({ code: z.number() })).max(10).optional() });
export function receiveStatus(workspace: Workspace, status: z.infer<typeof statusSchema>) {
  const message = workspace.messages.find(item => item.direction === "outbound" && (item.providerId === status.id || (item.id === status.biz_opaque_callback_data && (!item.providerId || item.providerId === status.id))));
  if (!message || ["draft", "demo"].includes(message.status)) return false;
  const lead = workspace.leads.find(item => item.id === message.leadId);
  if (!lead || (status.recipient_id && normalizePhone(status.recipient_id) !== lead.phone)) return false;
  message.providerId = status.id;
  applyDelivery(message, status.status, providerTimestamp(status.timestamp));
  if (message.status === "failed") message.error = `WhatsApp reported delivery failure${status.errors?.[0] ? ` (${status.errors[0].code})` : ""}.`;
  if (["sent", "delivered", "read"].includes(message.status)) {
    lead.lastContactAt = laterTimestamp(lead.lastContactAt, message.statusAt!);
    if (lead.stage === "New") lead.stage = "Contacted";
  }
  for (const job of workspace.jobs.filter(item => item.messageId === message.id)) {
    job.status = message.status === "failed" ? "failed" : "sent";
    job.lockedAt = null; job.error = message.error;
  }
  for (const campaign of workspace.campaigns) if (campaign.status === "active" && !workspace.jobs.some(job => job.campaignId === campaign.id && ["pending", "processing", "accepted", "failed", "reconcile"].includes(job.status))) campaign.status = "completed";
  return true;
}
const payloadSchema = z.object({ entry: z.array(z.object({ changes: z.array(z.object({ field: z.string(), value: z.record(z.string(), z.unknown()) })).max(100) })).max(100) });
const valueSchema = z.object({ metadata: z.object({ phone_number_id: z.string().regex(/^\d+$/) }), contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).max(100).optional(), messages: z.array(z.record(z.string(), z.unknown())).max(100).optional(), message_echoes: z.array(z.record(z.string(), z.unknown())).max(100).optional(), statuses: z.array(statusSchema).max(100).optional() });
export async function processMetaPayload(raw: unknown, verified = false) {
  assert(verified, "A verified Meta signature is required.", 403);
  assert(productionDatabase(), "Configure the tenant database for WhatsApp webhooks.", 503);
  const payload = payloadSchema.parse(raw);
  const { acceptIntake } = await import("../db/intake");
  let failed = false;
  for (const entry of payload.entry) for (const change of entry.changes) {
    if (!["messages", "smb_message_echoes"].includes(change.field)) continue;
    try {
      const value = valueSchema.parse(change.value), phoneId = value.metadata.phone_number_id;
      const [route] = await database().select().from(connectionRoutes).where(and(eq(connectionRoutes.service, "whatsapp"), eq(connectionRoutes.externalId, phoneId)));
      if (!route) continue;
      const snapshot = await loadWorkspace(route.organizationId), connection = connectionFor(snapshot, "whatsapp");
      const retained = snapshot.connections?.find(item => item.service === "whatsapp" && item.externalId === phoneId);
      assert(retained?.metadata.subscriptionPending !== "true", "WhatsApp setup is pending reconciliation. Retry delivery after setup is completed.", 503);
      if (snapshot.demo || connection?.externalId !== phoneId) continue;
      // Status/safety deliveries are independent of a new enquiry in the same batch.
      if (value.statuses?.length) await mutateWorkspace(route.organizationId, workspace => {
        assert(connectionFor(workspace, "whatsapp")?.id === connection.id && connectionFor(workspace, "whatsapp")?.externalId === phoneId, "WhatsApp routing changed. Retry delivery.", 409);
        for (const status of value.statuses || []) receiveStatus(workspace, status);
      });
      const echo = change.field === "smb_message_echoes";
      for (const msg of (echo ? value.message_echoes : value.messages) || []) {
        try {
          const type = typeof msg.type === "string" ? msg.type : "text";
          const content = msg[type] as Record<string, string> | undefined;
          const from = echo ? msg.to : msg.from;
          if (typeof from !== "string" || typeof msg.id !== "string" || !normalizePhone(from)) continue;
          await acceptIntake(route.organizationId, connection.id, phoneId, { service: "whatsapp", event: { id: msg.id, from, name: value.contacts?.find(contact => contact.wa_id === from)?.profile?.name.slice(0, 100), timestamp: typeof msg.timestamp === "string" ? msg.timestamp : undefined, echo, verified: true, body: (typeof content?.body === "string" ? content.body : typeof content?.caption === "string" ? content.caption : `[${type} message]`).slice(0, 4000), mediaType: type === "text" ? undefined : type, mediaId: typeof content?.id === "string" ? content.id : undefined } });
        } catch { failed = true; }
      }
    } catch { failed = true; }
  }
  assert(!failed, "Some WhatsApp events could not be stored. Retry delivery; accepted events are deduplicated.", 503);
}
