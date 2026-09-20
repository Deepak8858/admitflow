import { and, asc, count, eq, gt, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { database } from "./client";
import { tenantTransaction } from "./repository";
import { eventReceipts, intakeInbox, organizationRoutes, organizations } from "./schema";
import { intakeContactIdentity, INTAKE_MAX_AGE_MS } from "../intake-retention-policy";

type Tx = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
const scope = (workspaceId: string) => eq(intakeInbox.organizationId, workspaceId);
export const intakePayloadDigestSql = (payload: unknown) => sql<string>`encode(sha256(convert_to(${JSON.stringify(payload)}::jsonb::text, 'UTF8')), 'hex')`;

/** Caller must hold the organization lock. Does not delete identity/dedup/safety evidence. */
export async function scrubIntakeRows(tx: Tx, workspaceId: string, now: string, limit = 100) {
  const rows = await tx.select().from(intakeInbox).where(and(scope(workspaceId), or(eq(intakeInbox.contactKeyVersion, ""), and(isNotNull(intakeInbox.payload), lte(intakeInbox.expiresAt, now)))))
    .orderBy(asc(intakeInbox.expiresAt), asc(intakeInbox.id)).limit(limit).for("update");
  let redacted = 0, rekeyed = 0;
  for (const row of rows) {
    const identity = row.contactKeyVersion ? {} : intakeContactIdentity(workspaceId, row.contactKey);
    if (!row.contactKeyVersion) rekeyed++;
    const expired = row.payload !== null && Date.parse(row.expiresAt) <= Date.parse(now);
    if (expired) redacted++;
    await tx.update(intakeInbox).set({ ...identity, ...(expired ? { payload: null, redactedAt: now, state: row.state === "imported" ? "imported" as const : "expired" as const, error: null } : {}) }).where(and(scope(workspaceId), eq(intakeInbox.id, row.id)));
  }
  // Meta routing receipts hold only provider event metadata, never fetched forms. Erase expired copies too.
  const receipts = await tx.select({ id: eventReceipts.id }).from(eventReceipts).where(and(eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.provider, "meta_leads"), lte(eventReceipts.receivedAt, new Date(Date.parse(now) - INTAKE_MAX_AGE_MS).toISOString()), sql`${eventReceipts.payload} <> '{}'::jsonb`)).orderBy(asc(eventReceipts.receivedAt), asc(eventReceipts.id)).limit(limit).for("update");
  for (const receipt of receipts) await tx.update(eventReceipts).set({ payload: {}, error: null, processedAt: sql`coalesce(${eventReceipts.processedAt}, ${now}::timestamptz)` }).where(and(eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.id, receipt.id), eq(eventReceipts.provider, "meta_leads")));
  return { selected: rows.length, redacted, rekeyed, metadataRedacted: receipts.length };
}

/** Operator inspection does not select payloads, contact values, credentials or event contents. */
export async function inspectIntakeRetention(workspaceId: string, now = new Date().toISOString()) {
  z.uuid().parse(workspaceId); z.iso.datetime().parse(now);
  return tenantTransaction(workspaceId, async tx => {
    const countWhere = async (condition: ReturnType<typeof and>) => (await tx.select({ value: count() }).from(intakeInbox).where(and(scope(workspaceId), condition)))[0].value;
    const [expiredPayloads, legacyContactKeys, expiredHolds] = await Promise.all([
      countWhere(and(isNotNull(intakeInbox.payload), lte(intakeInbox.expiresAt, now))),
      countWhere(eq(intakeInbox.contactKeyVersion, "")),
      countWhere(and(ne(intakeInbox.state, "imported"), lte(intakeInbox.expiresAt, now))),
    ]);
    const [metadata] = await tx.select({ value: count() }).from(eventReceipts).where(and(eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.provider, "meta_leads"), lte(eventReceipts.receivedAt, new Date(Date.parse(now) - INTAKE_MAX_AGE_MS).toISOString()), sql`${eventReceipts.payload} <> '{}'::jsonb`));
    return { workspaceId, expiredPayloads, legacyContactKeys, expiredHolds, expiredMetadata: metadata.value };
  });
}
export async function cleanIntakeRetention(workspaceId: string, limit = 100, now = new Date().toISOString()) {
  z.uuid().parse(workspaceId); z.number().int().min(1).max(500).parse(limit); z.iso.datetime().parse(now);
  return tenantTransaction(workspaceId, async tx => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    const result = await scrubIntakeRows(tx, workspaceId, now, limit);
    if (result.redacted || result.rekeyed) await tx.update(organizations).set({ revision: sql`${organizations.revision} + 1` }).where(eq(organizations.id, workspaceId));
    return result;
  });
}
export async function sweepIntakeRetention(after?: string, tenantLimit = 10) {
  if (after) z.uuid().parse(after);
  z.number().int().min(1).max(20).parse(tenantLimit);
  const routes = await database().select({ id: organizationRoutes.organizationId }).from(organizationRoutes).where(after ? gt(organizationRoutes.organizationId, after) : undefined).orderBy(asc(organizationRoutes.organizationId)).limit(tenantLimit);
  let failed = 0, redacted = 0;
  for (const route of routes) {
    try { const result = await cleanIntakeRetention(route.id); redacted += result.redacted + result.metadataRedacted; }
    catch { failed++; }
  }
  return { selected: routes.length, failed, redacted, after: routes.length === tenantLimit ? routes.at(-1)!.id : undefined };
}
