import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { connectionFor, credentials } from "../connections";
import { loadWorkspace } from "../store";
import { assert } from "../errors";
import { readLimitedText } from "../http";
import { uid, isoNow, stopJobs, addActivity, type Workspace } from "../domain";
import { productionDatabase } from "../config";
import { mutatePostgresWorkspace, tenantTransaction } from "../db/repository";
import { connections, eventReceipts, leads, organizations } from "../db/schema";

const paymentId = z.string().regex(/^pay_[A-Za-z0-9]{1,100}$/);
const refundId = z.string().regex(/^rfnd_[A-Za-z0-9]{1,100}$/);
const providerLinkId = z.string().regex(/^plink_[A-Za-z0-9]{1,100}$/);
const paise = z.number().int().positive().max(1_000_000_000);
const paymentSchema = z.object({
  id: paymentId, status: z.enum(["captured", "refunded"]), captured: z.literal(true), amount: paise, currency: z.literal("INR"),
});
const attributedPaymentSchema = paymentSchema.extend({
  // Preserve the internal ledger helper's captured-status contract. External
  // events and provider GETs still use paymentSchema and require captured: true.
  captured: z.literal(true).optional(),
  notes: z.preprocess(value => value == null || Array.isArray(value) && value.length === 0 ? {} : value, z.record(z.string(), z.unknown())),
}).refine(value => value.status !== "refunded" || value.captured === true, "The payment has not been captured.");
const refundSchema = z.object({ id: refundId, payment_id: paymentId, amount: paise, currency: z.literal("INR"), status: z.literal("processed") });
const issuedLinkSchema = z.object({
  version: z.literal(2), providerLinkId, leadId: z.uuid(), amountPaise: paise, currency: z.literal("INR"),
  connectionId: z.uuid(), keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  creditedPaymentId: paymentId.optional(),
});
const linkReceiptId = (workspaceId: string, linkId: string) => `razorpay_link:${workspaceId}:${linkId}`;
const linkReceiptScope = (workspaceId: string, linkId: string) => and(
  eq(eventReceipts.id, linkReceiptId(workspaceId, linkId)), eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.provider, "razorpay_link"),
);
const keyFingerprint = (keyId: string) => createHash("sha256").update(keyId).digest("hex");
export const paymentEventReferenceSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("payment.captured"), paymentId, amount: paise }),
  z.object({ event: z.literal("refund.processed"), paymentId, refundId, amount: paise }),
]);
export type PaymentEventReference = z.infer<typeof paymentEventReferenceSchema>;

/** Keep only signed reconciliation references, never customer/card data, in the inbox. */
export function paymentEventReference(raw: unknown): PaymentEventReference | null {
  const envelope = z.object({ event: z.string().min(1).max(100), payload: z.unknown().optional() }).parse(raw);
  if (envelope.event === "payment.captured") {
    const { payload } = z.object({ payload: z.object({ payment: z.object({ entity: paymentSchema }) }) }).parse(raw);
    assert(payload.payment.entity.status === "captured", "Invalid capture event.");
    return { event: envelope.event, paymentId: payload.payment.entity.id, amount: payload.payment.entity.amount };
  }
  if (envelope.event === "refund.processed") {
    const { payload } = z.object({ payload: z.object({ refund: z.object({ entity: refundSchema }) }) }).parse(raw);
    return { event: envelope.event, paymentId: payload.refund.entity.payment_id, refundId: payload.refund.entity.id, amount: payload.refund.entity.amount };
  }
  return null;
}

export async function razorpay<T = Record<string, unknown>>(keys: { keyId: string; keySecret: string }, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString("base64")}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000), cache: "no-store", redirect: "error" });
  assert(response.ok, `Razorpay could not complete the operation (${response.status}).`, 502);
  return JSON.parse(await readLimitedText(response, 1_000_000)) as T;
}
export async function createPaymentLink(workspace: Workspace, leadId: string, amount: number) {
  const lead = workspace.leads.find(item => item.id === leadId);
  const amountPaise = Math.round(amount * 100);
  assert(lead && Number.isFinite(amount) && amount > 0 && amount <= 10000000 && amountPaise > 0 && amount === amountPaise / 100, "Choose a student and valid payment amount.");
  assert(productionDatabase() && !workspace.demo, "Hosted payment links require a connected institute workspace.", 503);
  const connection = connectionFor(workspace, "razorpay");
  assert(connection?.status === "connected" && connection.secret, "Connect Razorpay before issuing a payment link.", 409);
  const keys = await credentials(workspace, "razorpay") as { keyId: string; keySecret: string };
  const response = z.object({
    id: providerLinkId, short_url: z.url(), amount: z.literal(amountPaise), currency: z.literal("INR"), accept_partial: z.literal(false),
  }).parse(await razorpay(keys, "payment_links", { amount: amountPaise, currency: "INR", accept_partial: false, description: `${workspace.name} · ${lead.course}`, customer: { name: lead.name, ...(lead.email ? { email: lead.email } : {}), contact: lead.phone }, notify: { sms: false, email: false }, notes: { admitflow_lead_id: lead.id, admitflow_workspace_id: workspace.id } }));
  const url = new URL(response.short_url);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.port && ["rzp.io", "razorpay.com", "checkout.razorpay.com"].includes(url.hostname), "Razorpay returned an invalid payment link.", 502);
  await tenantTransaction(workspace.id, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspace.id)).for("update");
    const [active] = await tx.select().from(connections).where(and(eq(connections.organizationId, workspace.id), eq(connections.id, connection.id), eq(connections.service, "razorpay")));
    const [currentLead] = await tx.select({ id: leads.id }).from(leads).where(and(eq(leads.organizationId, workspace.id), eq(leads.id, lead.id)));
    assert(organization && !organization.demo && currentLead && active?.status === "connected" && active.secret === connection.secret, "The payment account or enquiry changed while issuing the link.", 409);
    await tx.insert(eventReceipts).values({ id: linkReceiptId(workspace.id, response.id), organizationId: workspace.id, provider: "razorpay_link", receivedAt: isoNow(), processedAt: isoNow(), payload: {
      version: 2, providerLinkId: response.id, leadId: lead.id, amountPaise, currency: "INR", connectionId: connection.id, keyFingerprint: keyFingerprint(keys.keyId),
    } });
  });
  return { id: response.id, short_url: url.toString() };
}
async function canonicalPaymentLink(keys: { keyId: string; keySecret: string }, payment: z.infer<typeof paymentSchema>) {
  // Razorpay documents this filter and the canonical link's captured payments array.
  // Link notes are not documented to propagate to Payments and are never authority.
  const matches = z.object({ payment_links: z.array(z.object({ id: providerLinkId })).length(1) })
    .parse(await razorpay(keys, `payment_links?payment_id=${payment.id}`));
  const id = matches.payment_links[0].id;
  const link = z.object({
    id: z.literal(id), amount: z.literal(payment.amount), amount_paid: z.literal(payment.amount), currency: z.literal("INR"),
    accept_partial: z.literal(false), status: z.literal("paid"),
    payments: z.array(z.object({
      payment_id: z.literal(payment.id), amount: z.literal(payment.amount), status: z.literal("captured"),
      // The documented fetch example omits plink_id; enforce it whenever returned.
      plink_id: z.literal(id).optional(),
    })).length(1),
  }).parse(await razorpay(keys, `payment_links/${id}`));
  return link.id;
}
/** Internal ledger operation: callers must supply attribution from trusted local records. */
export function applyPaymentEvent(workspace: Workspace, event: { event: string; payload: Record<string, { entity: unknown }> }): "applied" | "duplicate" | "ignored" {
  if (event.event === "payment.captured") {
    const payment = attributedPaymentSchema.parse(event.payload.payment?.entity);
    if (payment.notes.admitflow_workspace_id !== workspace.id) return "ignored";
    const lead = workspace.leads.find(item => item.id === payment.notes.admitflow_lead_id);
    assert(lead, "The payment's enquiry is not available. Reconcile its attribution before replay.", 409);
    const existing = workspace.revenue.find(item => item.providerId === payment.id);
    if (existing) {
      assert(existing.origin === "razorpay" && existing.leadId === lead.id && Math.round(existing.amount * 100) === payment.amount, "The payment conflicts with its existing receipt.", 409);
      return "duplicate";
    }
    const campaign = workspace.campaigns.find(item => item.leadIds.includes(lead.id));
    workspace.revenue.push({ id: uid(), leadId: lead.id, amount: payment.amount / 100, recordedAt: isoNow(), campaignId: campaign?.id || null, reference: payment.id, origin: "razorpay", providerId: payment.id });
    lead.stage = "Admitted"; stopJobs(workspace, lead.id);
    addActivity(workspace, "Razorpay confirmed an admission payment", "revenue", lead.id);
    return "applied";
  }
  if (event.event === "refund.processed") {
    const refund = refundSchema.parse(event.payload.refund?.entity);
    const payment = workspace.revenue.find(item => item.providerId === refund.payment_id && item.origin === "razorpay");
    assert(payment, "The captured payment must be reconciled before its refund.", 409);
    workspace.refunds ||= [];
    const existing = workspace.refunds.find(item => item.reference === refund.id);
    if (existing) {
      assert(existing.revenueId === payment.id && Math.round(existing.amount * 100) === refund.amount, "The refund conflicts with an existing reference.", 409);
      return "duplicate";
    }
    const refunded = workspace.refunds.filter(item => item.revenueId === payment.id).reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
    assert(Number.isSafeInteger(refunded) && refunded >= 0 && refunded + refund.amount <= Math.round(payment.amount * 100), "Invalid refund amount.", 409);
    workspace.refunds.push({ id: uid(), revenueId: payment.id, amount: refund.amount / 100, reference: refund.id, recordedAt: isoNow() });
    addActivity(workspace, "Razorpay refund reconciled", "revenue", payment.leadId);
    return "applied";
  }
  return "ignored";
}

/** Provider GETs precede the tenant transaction; the credential version is checked again at commit. */
export async function reconcilePayment(workspaceId: string, reference: PaymentEventReference, expected: { connectionId: string; keyFingerprint: string }) {
  assert(productionDatabase(), "Payment reconciliation requires hosted storage.", 503);
  reference = paymentEventReferenceSchema.parse(reference);
  const workspace = await loadWorkspace(workspaceId), connection = connectionFor(workspace, "razorpay");
  const keys = await credentials(workspace, "razorpay") as { keyId: string; keySecret: string };
  assert(connection?.id === expected.connectionId && keyFingerprint(keys.keyId) === expected.keyFingerprint, "The payment account changed. Operator reconciliation is required.", 409);
  const payment = paymentSchema.parse(await razorpay(keys, `payments/${reference.paymentId}`));
  assert(payment.id === reference.paymentId, "Razorpay returned a different payment.", 502);
  const existing = workspace.revenue.find(item => item.providerId === payment.id);
  if (existing) assert(existing.origin === "razorpay" && Math.round(existing.amount * 100) === payment.amount, "The payment conflicts with its existing receipt.", 409);
  // Existing receipts retain their attribution, including legacy receipts with no link
  // provenance. They may receive refunds, but this path may never recreate a receipt.
  const linkId = existing ? undefined : await canonicalPaymentLink(keys, payment);
  const refund = reference.event === "refund.processed" ? refundSchema.parse(await razorpay(keys, `refunds/${reference.refundId}`)) : undefined;
  if (refund && reference.event === "refund.processed") assert(refund.id === reference.refundId && refund.payment_id === payment.id && refund.amount === reference.amount, "Razorpay returned a different refund.", 502);
  else assert(payment.amount === reference.amount, "Razorpay returned a different payment amount.", 502);
  let issued: z.infer<typeof issuedLinkSchema> | undefined;
  return mutatePostgresWorkspace(workspaceId, current => {
    const active = connectionFor(current, "razorpay");
    assert(!current.demo && active?.status === "connected" && active.id === connection.id && active.secret === connection.secret, "The payment connection changed. Retry reconciliation.", 409);
    if (existing) assert(current.revenue.some(item => item.id === existing.id && item.providerId === payment.id && item.origin === "razorpay" && item.leadId === existing.leadId && Math.round(item.amount * 100) === payment.amount), "The existing payment receipt changed. Operator reconciliation is required.", 409);
    if (issued?.creditedPaymentId) assert(current.revenue.some(item => item.providerId === issued!.creditedPaymentId), "The issued link's credited receipt is missing. Operator reconciliation is required.", 409);
    const leadId = existing ? existing.leadId : issued!.leadId;
    const result = applyPaymentEvent(current, { event: "payment.captured", payload: { payment: { entity: {
      ...payment, notes: { admitflow_workspace_id: workspaceId, admitflow_lead_id: leadId },
    } } } });
    return refund ? applyPaymentEvent(current, { event: "refund.processed", payload: { refund: { entity: refund } } }) : result;
  }, async tx => {
    if (!linkId) return;
    const [receipt] = await tx.select().from(eventReceipts).where(linkReceiptScope(workspaceId, linkId)).for("update");
    const parsed = issuedLinkSchema.safeParse(receipt?.payload);
    assert(receipt?.processedAt && parsed.success && parsed.data.providerLinkId === linkId
      && parsed.data.amountPaise === payment.amount && parsed.data.currency === payment.currency
      && parsed.data.connectionId === expected.connectionId && parsed.data.keyFingerprint === expected.keyFingerprint,
    "The payment does not match a recorded provider link. Operator reconciliation is required.", 409);
    issued = parsed.data;
    assert(!issued.creditedPaymentId || issued.creditedPaymentId === payment.id, "This issued link already credited another payment. Operator reconciliation is required.", 409);
  }, async tx => {
    if (!linkId || !issued) return;
    // Commit the permanent one-payment claim with the ledger; rollback restores both.
    // Refunds never release the claim.
    await tx.update(eventReceipts).set({ payload: { ...issued, creditedPaymentId: payment.id } }).where(linkReceiptScope(workspaceId, linkId));
  });
}
