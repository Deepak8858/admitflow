import { z } from "zod";
import { connectionFor, credentials } from "../connections";
import { loadWorkspace, mutateWorkspace } from "../store";
import { assert } from "../errors";
import { readLimitedText } from "../http";
import { uid, isoNow, stopJobs, addActivity, type Workspace } from "../domain";

const paymentId = z.string().regex(/^pay_[A-Za-z0-9]{1,100}$/);
const refundId = z.string().regex(/^rfnd_[A-Za-z0-9]{1,100}$/);
const paise = z.number().int().positive().max(1_000_000_000);
const paymentSchema = z.object({
  id: paymentId, status: z.enum(["captured", "refunded"]), captured: z.boolean().optional(), amount: paise, currency: z.literal("INR"),
  notes: z.preprocess(value => value == null || Array.isArray(value) && value.length === 0 ? {} : value, z.record(z.string(), z.unknown())),
}).refine(value => value.captured !== false && (value.status !== "refunded" || value.captured === true), "The payment has not been captured.");
const refundSchema = z.object({ id: refundId, payment_id: paymentId, amount: paise, currency: z.literal("INR"), status: z.literal("processed") });
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
  const keys = await credentials(workspace, "razorpay") as { keyId: string; keySecret: string };
  return razorpay<{ short_url: string; id: string }>(keys, "payment_links", { amount: amountPaise, currency: "INR", description: `${workspace.name} · ${lead.course}`, customer: { name: lead.name, ...(lead.email ? { email: lead.email } : {}), contact: lead.phone }, notify: { sms: false, email: false }, notes: { admitflow_lead_id: lead.id, admitflow_workspace_id: workspace.id } });
}
export function applyPaymentEvent(workspace: Workspace, event: { event: string; payload: Record<string, { entity: unknown }> }): "applied" | "duplicate" | "ignored" {
  if (event.event === "payment.captured") {
    const payment = paymentSchema.parse(event.payload.payment?.entity);
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
  const { createHash } = await import("node:crypto");
  const workspace = await loadWorkspace(workspaceId), connection = connectionFor(workspace, "razorpay");
  const keys = await credentials(workspace, "razorpay") as { keyId: string; keySecret: string };
  assert(connection?.id === expected.connectionId && createHash("sha256").update(keys.keyId).digest("hex") === expected.keyFingerprint, "The payment account changed. Operator reconciliation is required.", 409);
  const payment = paymentSchema.parse(await razorpay(keys, `payments/${reference.paymentId}`));
  assert(payment.id === reference.paymentId, "Razorpay returned a different payment.", 502);
  const refund = reference.event === "refund.processed" ? refundSchema.parse(await razorpay(keys, `refunds/${reference.refundId}`)) : undefined;
  if (refund && reference.event === "refund.processed") assert(refund.id === reference.refundId && refund.payment_id === payment.id && refund.amount === reference.amount, "Razorpay returned a different refund.", 502);
  else assert(payment.amount === reference.amount, "Razorpay returned a different payment amount.", 502);
  return mutateWorkspace(workspaceId, current => {
    const active = connectionFor(current, "razorpay");
    assert(!current.demo && active?.id === connection.id && active.secret === connection.secret, "The payment connection changed. Retry reconciliation.", 409);
    const result = applyPaymentEvent(current, { event: "payment.captured", payload: { payment: { entity: payment } } });
    if (result === "ignored") return result;
    return refund ? applyPaymentEvent(current, { event: "refund.processed", payload: { refund: { entity: refund } } }) : result;
  });
}
