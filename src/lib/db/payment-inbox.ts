import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { productionDatabase } from "../config";
import { database } from "./client";
import { tenantTransaction } from "./repository";
import { connections, eventReceipts, organizations, organizationRoutes } from "./schema";
import { assert } from "../errors";
import { isoNow, uid, type Connection } from "../domain";
import { paymentEventReferenceSchema, reconcilePayment, type PaymentEventReference } from "../providers/payments";

const PROVIDER = "razorpay_admission";
export const PAYMENT_MAX_ATTEMPTS = 8;
export const PAYMENT_LEASE_MS = 120_000;
const stateSchema = z.object({
  version: z.literal(1), reference: paymentEventReferenceSchema,
  connectionId: z.uuid(), keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  attempts: z.number().int().nonnegative(), status: z.enum(["pending", "processing", "failed", "processed", "ignored"]),
  nextAttemptAt: z.iso.datetime().nullable(), claim: z.uuid().optional(),
});
type State = z.infer<typeof stateSchema>;
const scope = (workspaceId: string, id: string) => and(eq(eventReceipts.provider, PROVIDER), eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.id, id));
const fingerprint = (keyId: string) => createHash("sha256").update(keyId).digest("hex");

/** Called only after validating the signature over the exact bounded body. */
export async function acceptPaymentEvent(workspaceId: string, reference: PaymentEventReference, body: string, connection: Connection, keyId: string) {
  assert(productionDatabase(), "Hosted payment delivery requires PostgreSQL.", 503);
  z.uuid().parse(workspaceId);
  reference = paymentEventReferenceSchema.parse(reference);
  // Ignore the unsigned event-ID header entirely. Whitespace variants remain financially idempotent.
  const id = `razorpay_admission:${workspaceId}:${createHash("sha256").update(body).digest("hex")}`;
  const payload: State = { version: 1, reference, connectionId: connection.id, keyFingerprint: fingerprint(keyId), attempts: 0, status: "pending", nextAttemptAt: isoNow() };
  return tenantTransaction(workspaceId, async tx => {
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    if (org?.demo) return { received: true, ignored: true };
    assert(org?.workosId, "This institute cannot receive hosted payments. Restore its identity configuration and retry.", 503);
    const [active] = await tx.select().from(connections).where(and(eq(connections.organizationId, workspaceId), eq(connections.id, connection.id), eq(connections.service, "razorpay")));
    assert(active?.status === "connected" && active.secret === connection.secret, "The payment connection changed. Retry delivery.", 503);
    await tx.insert(eventReceipts).values({ id, organizationId: workspaceId, provider: PROVIDER, receivedAt: isoNow(), payload }).onConflictDoNothing();
    const [receipt] = await tx.select().from(eventReceipts).where(scope(workspaceId, id));
    assert(receipt, "The payment event could not be saved.", 503);
    return { received: true, queued: !receipt.processedAt, duplicate: Boolean(receipt.processedAt) };
  });
}

/** No external writes are performed: all provider operations are authoritative GETs. */
export async function processPaymentReceipt(workspaceId: string, id: string, now = Date.now()) {
  const claimed = await tenantTransaction(workspaceId, async tx => {
    const [row] = await tx.select().from(eventReceipts).where(scope(workspaceId, id)).for("update");
    if (!row || row.processedAt) return null;
    const parsed = stateSchema.safeParse(row.payload);
    if (!parsed.success) {
      await tx.update(eventReceipts).set({ error: "Invalid payment inbox state; operator repair required.", payload: { ...row.payload, nextAttemptAt: null, status: "failed" } }).where(scope(workspaceId, id));
      return null;
    }
    const state = parsed.data;
    if (!state.nextAttemptAt || Date.parse(state.nextAttemptAt) > now) return null;
    if (state.attempts >= PAYMENT_MAX_ATTEMPTS) {
      await tx.update(eventReceipts).set({ payload: { ...state, status: "failed", nextAttemptAt: null }, error: "Payment reconciliation exhausted retries; inspect and replay this receipt." }).where(scope(workspaceId, id));
      return null;
    }
    const next: State = { ...state, attempts: state.attempts + 1, status: "processing", claim: uid(), nextAttemptAt: new Date(now + PAYMENT_LEASE_MS).toISOString() };
    await tx.update(eventReceipts).set({ payload: next, error: null }).where(scope(workspaceId, id));
    return next;
  });
  if (!claimed) return "skipped" as const;
  const owned = and(scope(workspaceId, id), isNull(eventReceipts.processedAt), sql`${eventReceipts.payload}->>'claim' = ${claimed.claim!}`);
  try {
    const result = await reconcilePayment(workspaceId, claimed.reference, claimed);
    // If we crash here, replay sees identical provider IDs and does not duplicate the money.
    const status = result.result === "ignored" ? "ignored" : "processed";
    const finished = await tenantTransaction(workspaceId, tx => tx.update(eventReceipts).set({ payload: { ...claimed, status, nextAttemptAt: null }, processedAt: isoNow(), error: null }).where(owned).returning({ id: eventReceipts.id }));
    return finished.length ? status : "skipped" as const;
  } catch {
    const failed = claimed.attempts >= PAYMENT_MAX_ATTEMPTS;
    const retryAt = new Date(Date.now() + Math.min(3_600_000, 30_000 * 2 ** (claimed.attempts - 1))).toISOString();
    const finished = await tenantTransaction(workspaceId, tx => tx.update(eventReceipts).set({
      payload: { ...claimed, status: failed ? "failed" : "pending", nextAttemptAt: failed ? null : retryAt },
      error: "Payment reconciliation failed. Verify merchant credentials, attribution and provider state before replay.",
    }).where(owned).returning({ id: eventReceipts.id }));
    if (!finished.length) return "skipped" as const;
    console.error("Payment reconciliation failed", JSON.stringify({ workspaceId, receiptId: id, attempts: claimed.attempts, exhausted: failed }));
    return failed ? "failed" as const : "pending" as const;
  }
}

/** Page routing IDs only; all receipt reads and claims enforce the selected tenant's RLS. */
export async function recoverPaymentEvents(after?: string, tenantLimit = 10, receiptLimit = 10) {
  assert(productionDatabase(), "Payment recovery requires PostgreSQL.", 503);
  if (after !== undefined) z.uuid().parse(after);
  z.number().int().min(1).max(20).parse(tenantLimit);
  z.number().int().min(1).max(100).parse(receiptLimit);
  const routes = await database().select({ organizationId: organizationRoutes.organizationId }).from(organizationRoutes)
    .where(after ? gt(organizationRoutes.organizationId, after) : undefined).orderBy(asc(organizationRoutes.organizationId)).limit(tenantLimit);
  const results = { tenants: routes.length, tenantFailures: 0, selected: 0, processed: 0, ignored: 0, pending: 0, failed: 0, skipped: 0 };
  for (const { organizationId } of routes) {
    let failed = false;
    try {
      const rows = await tenantTransaction(organizationId, tx => tx.select({ id: eventReceipts.id }).from(eventReceipts)
        .where(and(eq(eventReceipts.organizationId, organizationId), eq(eventReceipts.provider, PROVIDER), isNull(eventReceipts.processedAt), sql`${eventReceipts.payload}->>'nextAttemptAt' <= ${isoNow()}`))
        .orderBy(sql`${eventReceipts.payload}->>'nextAttemptAt'`, asc(eventReceipts.id)).limit(receiptLimit));
      results.selected += rows.length;
      for (const row of rows) {
        try { results[await processPaymentReceipt(organizationId, row.id)]++; } catch { failed = true; }
      }
    } catch { failed = true; }
    if (failed) results.tenantFailures++;
  }
  // Always visit the full tenant page. A capped tenant backlog is revisited on the next sweep.
  return { ...results, after: routes.length === tenantLimit ? routes.at(-1)!.organizationId : undefined };
}

/** An operator must select one tenant and receipt. Inspection never fetches credentials or provider data. */
export async function inspectPaymentEvents(workspaceId: string, limit = 50) {
  z.uuid().parse(workspaceId); z.number().int().min(1).max(100).parse(limit);
  return tenantTransaction(workspaceId, async tx => {
    const rows = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.provider, PROVIDER), eq(eventReceipts.organizationId, workspaceId), isNull(eventReceipts.processedAt))).orderBy(asc(eventReceipts.receivedAt), asc(eventReceipts.id)).limit(limit);
    return rows.map(row => {
      const state = stateSchema.safeParse(row.payload);
      return { id: row.id, receivedAt: row.receivedAt, status: state.success ? state.data.status : "invalid", attempts: state.success ? state.data.attempts : null, nextAttemptAt: state.success ? state.data.nextAttemptAt : null, error: row.error };
    });
  });
}
export async function retryPaymentEvent(workspaceId: string, id: string) {
  z.uuid().parse(workspaceId);
  assert(id.startsWith(`razorpay_admission:${workspaceId}:`) && /^[a-f0-9]{64}$/.test(id.split(":").at(-1) || ""), "Choose a payment receipt belonging to this institute.");
  await tenantTransaction(workspaceId, async tx => {
    const [row] = await tx.select().from(eventReceipts).where(scope(workspaceId, id)).for("update");
    assert(row, "Payment receipt not found.", 404);
    if (row.processedAt) return;
    const state = stateSchema.parse(row.payload);
    assert(state.status !== "processing" || !state.nextAttemptAt || Date.parse(state.nextAttemptAt) <= Date.now(), "This receipt is still being processed.", 409);
    await tx.update(eventReceipts).set({ payload: { ...state, status: "pending", attempts: 0, nextAttemptAt: isoNow() }, error: null }).where(scope(workspaceId, id));
  });
  return processPaymentReceipt(workspaceId, id);
}
