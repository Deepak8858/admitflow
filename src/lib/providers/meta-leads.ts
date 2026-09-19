import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectionFor, credentials, saveConnection } from "../connections";
import { productionDatabase } from "../config";
import { database } from "../db/client";
import { tenantTransaction } from "../db/repository";
import { connectionRoutes, eventReceipts } from "../db/schema";
import { addActivity, isoNow, normalizePhone, uid, type Lead, type Workspace } from "../domain";
import { AppError, assert } from "../errors";
import { loadWorkspace, mutateWorkspace } from "../store";
import { graph } from "./meta";

const metaId = z.string().regex(/^\d{1,80}$/);
import { metaLeadFormSchema as leadSchema } from "../intake-types";
export type MetaLeadForm = z.infer<typeof leadSchema>;
export interface MetaLeadEvent { pageId: string; leadgenId: string; formId?: string; adId?: string; createdTime?: number }
const markerFor = (event: MetaLeadEvent) => `meta.leadgen.${event.pageId}.${event.leadgenId}`;

export function metaLeadFields(form: MetaLeadForm) {
  return Object.fromEntries(form.field_data.map(field => [field.name.trim().toLowerCase().replace(/\s+/g, "_"), field.values.join("; ").trim().slice(0, 2000)]));
}
export function metaLeadPhone(form: MetaLeadForm) {
  const fields = metaLeadFields(form);
  return normalizePhone(fields.phone_number || fields.phone || fields.mobile_number || "");
}
/** A form submission is an enquiry, not WhatsApp opt-in and not an inbound WhatsApp message. */
export function applyMetaLead(workspace: Workspace, event: MetaLeadEvent, form: MetaLeadForm, receivedAt = isoNow()) {
  assert(form.id === event.leadgenId && (!event.formId || !form.form_id || event.formId === form.form_id), "Meta returned a different form enquiry.", 422);
  const marker = markerFor(event);
  const duplicate = workspace.leads.find(lead => lead.customFields?.[marker]);
  if (duplicate) return { duplicate: true, created: false, leadId: duplicate.id };
  const fields = metaLeadFields(form);
  const phone = metaLeadPhone(form);
  const emailValue = (fields.email || fields.email_address || "").toLowerCase();
  const email = z.email().safeParse(emailValue).success ? emailValue : "";
  let lead = phone ? workspace.leads.find(item => item.phone === phone) : undefined;
  // Shared family email addresses must not merge two different valid phone numbers.
  if (!lead && email) lead = workspace.leads.find(item => item.email.toLowerCase() === email && (!phone || !normalizePhone(item.phone)));
  const created = !lead;
  const submitted = form.created_time ? Date.parse(form.created_time) : event.createdTime ? event.createdTime * 1000 : NaN;
  const when = Number.isFinite(submitted) && submitted > 0 && submitted <= Date.parse(receivedAt) + 86400_000 ? new Date(submitted).toISOString() : receivedAt;
  if (!lead) {
    const assignee = workspace.members?.find(member => member.status === "active" && member.role === "counsellor" && member.workosId)
      || workspace.members?.find(member => member.status === "active" && ["owner", "admin"].includes(member.role) && member.workosId);
    const interest = fields.course || fields.course_interest || fields.program || fields.programme || "";
    lead = {
      id: uid(), name: (fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(" ") || fields.name || email || "Meta form enquiry").slice(0, 200),
      // A non-dialable source identifier keeps email-only enquiries distinct in the unique-phone schema.
      phone: phone || `meta:${event.pageId}:${event.leadgenId}`, email,
      course: workspace.courses.find(course => course.toLowerCase() === interest.toLowerCase()) || "Undecided", source: "Meta Lead Ads", stage: "New",
      owner: assignee?.name || "Unassigned", ownerId: assignee?.id || null,
      value: 0, notes: "Enquiry submitted through a Meta lead form.", nextAction: "Review the form enquiry and confirm contact details and messaging consent",
      createdAt: when, lastContactAt: null, lastInboundAt: null, consent: "unknown", consentSource: "", consentAt: null,
      isMinor: false, guardianConsent: false, humanOwned: true, unread: true, customFields: {},
    } satisfies Lead;
    workspace.leads.unshift(lead);
  }
  if (Date.parse(when) < Date.parse(lead.createdAt)) lead.createdAt = when;
  lead.customFields ||= {};
  lead.customFields[marker] = when;
  lead.customFields["meta.page_id"] = event.pageId;
  lead.customFields["meta.leadgen_id"] = event.leadgenId;
  if (event.formId || form.form_id) lead.customFields["meta.form_id"] = event.formId || form.form_id!;
  if (event.adId || form.ad_id) lead.customFields["meta.ad_id"] = event.adId || form.ad_id!;
  for (const field of form.field_data) lead.customFields[`meta.field.${field.name}`] = field.values.join("; ").slice(0, 2000);
  if (!lead.email && email) lead.email = email;
  if (phone && !normalizePhone(lead.phone)) lead.phone = phone;
  workspace.messages.push({ id: uid(), leadId: lead.id, providerId: `meta_leads:${event.pageId}:${event.leadgenId}`, source: "meta_leads", direction: "internal", author: "Meta Lead Ads", status: "received", createdAt: when, body: [`Meta lead form ${event.formId || form.form_id || "submission"}`, ...form.field_data.map(field => `${field.name}: ${field.values.join("; ")}`), "WhatsApp consent has not been inferred from this form."].join("\n").slice(0, 4000) });
  addActivity(workspace, created ? "New enquiry received from Meta Lead Ads" : "Another Meta form submission attached to this enquiry", "lead", lead.id);
  return { duplicate: false, created, leadId: lead.id };
}

/** Invoke from the admin-only /api/connections branch instead of saving an unverified Page ID. */
export async function registerMetaLeadPage(workspaceId: string, input: { pageId: string; accessToken: string }) {
  const pageId = metaId.parse(input.pageId), accessToken = z.string().trim().min(10).max(10000).parse(input.accessToken);
  const workspace = await loadWorkspace(workspaceId);
  assert(!workspace.demo, "Demo workspaces cannot connect a live Meta Page.", 409);
  assert(productionDatabase(), "Meta Lead Ads webhook routing requires the production database.", 503);
  const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID;
  assert(appId && process.env.META_APP_SECRET, "Configure the Meta app ID and META_APP_SECRET before connecting a Page.", 503);
  const debug = await graph<{ data: { is_valid: boolean; app_id: string; scopes?: string[]; expires_at?: number } }>(`debug_token?input_token=${encodeURIComponent(accessToken)}`, `${appId}|${process.env.META_APP_SECRET}`);
  assert(debug.data.is_valid && debug.data.app_id === appId, "Use a valid Page access token issued by this Meta application.", 422);
  if (debug.data.scopes) assert(["leads_retrieval", "pages_manage_metadata"].every(scope => debug.data.scopes!.includes(scope)), "Grant leads_retrieval and pages_manage_metadata to this Page token.", 422);
  const page = await graph<{ id: string; name: string }>("me?fields=id,name", accessToken);
  assert(page.id === pageId && page.name, "The token must be the Page access token for the selected Page ID.", 422);
  await graph(`${pageId}/leadgen_forms?fields=id&limit=1`, accessToken);
  const apps = await graph<{ data: { id: string; subscribed_fields?: string[] }[] }>(`${pageId}/subscribed_apps`, accessToken);
  const fields = [...new Set([...(apps.data.find(app => app.id === appId)?.subscribed_fields || []), "leadgen"])];
  // Persist the verified Page route before subscribing, so the first callback can be routed immediately.
  const saved = await saveConnection(workspaceId, "meta_leads", { accessToken }, pageId, page.name, { subscriptionStatus: "pending", appId, ...(debug.data.expires_at ? { tokenExpiresAt: new Date(debug.data.expires_at * 1000).toISOString() } : {}) });
  const savedConnection = saved.workspace.connections!.find(item => item.service === "meta_leads")!;
  try {
    const result = await graph<{ success?: boolean }>(`${pageId}/subscribed_apps`, accessToken, { subscribed_fields: fields });
    assert(result.success === true, "Meta did not confirm the Page webhook subscription.", 502);
    await mutateWorkspace(workspaceId, current => {
      const connection = current.connections!.find(item => item.id === savedConnection.id && item.secret === savedConnection.secret);
      if (connection) { connection.metadata.subscriptionStatus = "active"; connection.updatedAt = isoNow(); }
    });
    return { connected: true, pageId, label: page.name };
  } catch (error) {
    await mutateWorkspace(workspaceId, current => {
      const connection = current.connections!.find(item => item.id === savedConnection.id && item.secret === savedConnection.secret);
      if (connection) { connection.status = "error"; connection.metadata.subscriptionStatus = "error"; connection.metadata.lastLeadError = "Page verified, but webhook subscription failed. Reconnect this Page."; }
    });
    throw error;
  }
}

async function processLead(event: MetaLeadEvent) {
  const [route] = await database().select().from(connectionRoutes).where(and(eq(connectionRoutes.service, "meta_leads"), eq(connectionRoutes.externalId, event.pageId)));
  if (!route) return { ignored: true };
  const receiptId = `meta_leads:${event.pageId}:${event.leadgenId}`;
  const receipt = await tenantTransaction(route.organizationId, async tx => {
    await tx.insert(eventReceipts).values({ id: receiptId, organizationId: route.organizationId, provider: "meta_leads", receivedAt: isoNow(), payload: { ...event } }).onConflictDoNothing();
    const [row] = await tx.select().from(eventReceipts).where(eq(eventReceipts.id, receiptId));
    return row;
  });
  if (receipt.processedAt || receipt.organizationId !== route.organizationId) return { duplicate: true };
  try {
    const workspace = await loadWorkspace(route.organizationId), connection = connectionFor(workspace, "meta_leads");
    assert(connection?.externalId === event.pageId, "The Meta Page connection needs to be restored before this enquiry can be imported.", 409);
    const { acceptIntake, storedMetaIntake } = await import("../db/intake");
    const stored = await storedMetaIntake(route.organizationId, event.pageId, event.leadgenId);
    const form = stored?.payload.service === "meta_leads" ? stored.payload.form : leadSchema.parse(await graph(`${event.leadgenId}?fields=id,created_time,field_data,form_id,ad_id`, (await credentials(workspace, "meta_leads")).accessToken));
    const result = await acceptIntake(route.organizationId, connection.id, event.pageId, { service: "meta_leads", event, form });
    await mutateWorkspace(route.organizationId, current => {
      const active = connectionFor(current, "meta_leads");
      if (active?.id === connection.id && active.externalId === event.pageId) {
        active.metadata.lastLeadAt = isoNow(); active.metadata.lastLeadgenId = event.leadgenId;
        delete active.metadata.lastLeadError; delete active.metadata.lastLeadErrorAt;
      }
    });
    await tenantTransaction(route.organizationId, tx => tx.update(eventReceipts).set({ processedAt: isoNow(), error: null }).where(and(eq(eventReceipts.id, receiptId), eq(eventReceipts.organizationId, route.organizationId))));
    return result.result;
  } catch (error) {
    const message = error instanceof AppError ? error.message : "Meta enquiry import failed. Check Page access and retry webhook delivery.";
    await tenantTransaction(route.organizationId, tx => tx.update(eventReceipts).set({ error: message.slice(0, 500) }).where(and(eq(eventReceipts.id, receiptId), eq(eventReceipts.organizationId, route.organizationId))));
    await mutateWorkspace(route.organizationId, current => {
      const connection = current.connections?.find(item => item.service === "meta_leads" && item.externalId === event.pageId);
      if (connection) { connection.metadata.lastLeadError = message.slice(0, 500); connection.metadata.lastLeadErrorAt = isoNow(); connection.metadata.lastLeadgenId = event.leadgenId; }
    });
    throw error;
  }
}

const payloadSchema = z.object({ object: z.string(), entry: z.array(z.object({ id: metaId, changes: z.array(z.object({ field: z.string(), value: z.unknown() })).max(1000) })).max(1000) });
const changeSchema = z.object({ leadgen_id: metaId, page_id: metaId.optional(), form_id: metaId.optional(), ad_id: metaId.optional(), created_time: z.number().int().positive().optional() });

export async function processMetaLeadPayload(raw: unknown) {
  const payload = payloadSchema.parse(raw);
  if (payload.object !== "page") return { processed: 0 };
  assert(productionDatabase(), "Meta Lead Ads webhook routing is not configured.", 503);
  let failed = false, processed = 0;
  for (const entry of payload.entry) for (const change of entry.changes) {
    if (change.field !== "leadgen") continue;
    try {
      const value = changeSchema.parse(change.value);
      assert(!value.page_id || value.page_id === entry.id, "The Meta Page ID does not match the signed entry.", 400);
      await processLead({ pageId: entry.id, leadgenId: value.leadgen_id, formId: value.form_id, adId: value.ad_id, createdTime: value.created_time });
      processed++;
    } catch { failed = true; }
  }
  assert(!failed, "Some Meta enquiries could not be imported. Retry delivery; completed enquiries are deduplicated.", 503);
  return { processed };
}
