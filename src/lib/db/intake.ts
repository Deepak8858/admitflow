import { createHash } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { mutatePostgresWorkspace, tenantTransaction } from "./repository";
import { intakeInbox, organizations } from "./schema";
import { intakePayloadSchema, MAX_INTAKE_BYTES, type IntakePayload } from "../intake-types";
import { AppError, assert } from "../errors";
import { connectionFor } from "../connections";
import { isoNow, normalizePhone, stopJobs, type Workspace } from "../domain";
import { assertActor, assertPermission } from "../permissions";
import { assertWorkspaceCapability, workspaceCapabilities, prepareSubscription } from "../subscription-access";
import { assertEnquiryEntitlement, prepareBillingEntitlements } from "../providers/billing";
import { receiveMessage } from "../providers/meta";
import { applyMetaLead, metaLeadPhone } from "../providers/meta-leads";
import { loadWorkspace } from "../store";
import { intakeContactIdentity, intakeExpiry, intakeHeldPhones } from "../intake-retention-policy";
import { intakePayloadDigestSql } from "./intake-retention";

type Row = typeof intakeInbox.$inferSelect;
type Actor = NonNullable<Workspace["actor"]>;
class IntakeDeadlineCrossed extends AppError {
  constructor() { super("Intake expired during processing. Refresh the intake summary before retrying.", 409); }
}
function checkDeadline(expiresAt: string) {
  if (Date.parse(expiresAt) <= Date.now()) throw new IntakeDeadlineCrossed();
}
/** Caller holds the organization lock; never rewrite terminal or immutable receipt evidence. */
async function expireRows(tx: Parameters<Parameters<typeof tenantTransaction>[1]>[0], workspaceId: string, ids: string[]) {
  if (!ids.length) return [];
  const now = isoNow();
  return tx.update(intakeInbox).set({ state: "expired", payload: null, redactedAt: now, error: null })
    .where(and(eq(intakeInbox.organizationId, workspaceId), inArray(intakeInbox.id, ids), ne(intakeInbox.state, "imported"), isNotNull(intakeInbox.payload), lte(intakeInbox.expiresAt, now))).returning({ id: intakeInbox.id });
}
function payloadValue(raw: unknown): IntakePayload {
  const payload = intakePayloadSchema.parse(raw);
  assert(Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_INTAKE_BYTES - 12000, "The signed enquiry exceeds the intake payload limit.", 413);
  if (payload.service === "whatsapp") assert(normalizePhone(payload.event.from), "Invalid WhatsApp identity.", 400);
  else assert(payload.event.leadgenId === payload.form.id && (!payload.event.formId || !payload.form.form_id || payload.event.formId === payload.form.form_id), "Meta form identity mismatch.", 422);
  return JSON.parse(JSON.stringify(payload)) as IntakePayload;
}
function apply(workspace: Workspace, payload: IntakePayload, manual: boolean, receivedAt: string) {
  if (payload.service === "whatsapp") {
    receiveMessage(workspace, payload.event, manual, receivedAt);
    const lead = workspace.leads.find(item => item.whatsappId === payload.event.from || item.phone === normalizePhone(payload.event.from));
    if (manual && lead) { lead.humanOwned = true; stopJobs(workspace, lead.id); }
  } else {
    const result = applyMetaLead(workspace, payload.event, payload.form, receivedAt);
    const lead = workspace.leads.find(item => item.id === result.leadId);
    if (manual && lead) { lead.humanOwned = true; stopJobs(workspace, lead.id); }
  }
}
const intakeId = (workspaceId: string, service: string, externalId: string, eventId: string) => createHash("sha256").update(JSON.stringify([workspaceId, service, externalId, eventId])).digest("hex");
export async function storedMetaIntake(workspaceId: string, pageId: string, eventId: string) {
  return tenantTransaction(workspaceId, async tx => {
    const [row] = await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, intakeId(workspaceId, "meta_leads", pageId, eventId))));
    if (row && Date.parse(row.expiresAt) <= Date.now()) return { ...row, payload: null };
    return row;
  });
}
/** Called only by verified adapters. Original receipt time is server-owned, never a provider event timestamp. */
export async function acceptIntake(workspaceId: string, connectionId: string, externalId: string, raw: IntakePayload, originalReceivedAt?: string) {
  const payload = payloadValue(raw), eventId = payload.service === "whatsapp" ? payload.event.id : payload.event.leadgenId;
  const id = intakeId(workspaceId, payload.service, externalId, eventId);
  const phone = payload.service === "whatsapp" ? normalizePhone(payload.event.from)! : metaLeadPhone(payload.form) || "";
  const identity = intakeContactIdentity(workspaceId, phone);
  let previous: Row | undefined, pendingContact = false, deferred = false, expired = false, digest = "", now = isoNow();
  const receivedAt = originalReceivedAt ? z.iso.datetime().parse(originalReceivedAt) : now;
  assert(Date.parse(receivedAt) <= Date.parse(now), "Invalid intake receipt time.", 400);
  const deadline = intakeExpiry(receivedAt);
  const attempt = () => mutatePostgresWorkspace(workspaceId, workspace => {
    const connection = connectionFor(workspace, payload.service);
    assert(!workspace.demo && connection?.id === connectionId && connection.externalId === externalId, "The intake connection changed. Restore the original connection before retrying.", 409);
    now = isoNow();
    if (previous) {
      assert(previous.connectionId === connectionId && previous.payloadDigest === digest, "The intake identity is already bound to a different payload or connection.", 409);
      return { duplicate: true, deferred: previous.state !== "imported", expired: previous.state !== "imported" && Date.parse(previous.expiresAt) <= Date.parse(now) };
    }
    const candidate = structuredClone(workspace), before = candidate.leads.length;
    const manual = !workspaceCapabilities(workspace).allowed || pendingContact;
    now = isoNow(); expired = Date.parse(deadline) <= Date.parse(now);
    if (expired) { deferred = true; workspace.revision = (workspace.revision || 0) + 1; return { duplicate: false, deferred, expired }; }
    apply(candidate, payload, manual, receivedAt);
    deferred = candidate.leads.length > before && (!workspaceCapabilities(workspace).allowed || pendingContact);
    if (!deferred) Object.assign(workspace, candidate);
    else workspace.revision = (workspace.revision || 0) + 1;
    return { duplicate: false, deferred, expired: false };
  }, async tx => {
    [previous] = await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, id)));
    const hashed = await tx.execute<{ digest: string }>(sql`select ${intakePayloadDigestSql(payload)} as digest`); digest = hashed.rows[0].digest;
    if (phone) {
      const held = await tx.select({ contactKey: intakeInbox.contactKey, contactKeyVersion: intakeInbox.contactKeyVersion }).from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), ne(intakeInbox.state, "imported")));
      pendingContact = intakeHeldPhones(workspaceId, [phone], held).has(phone);
    }
  }, async tx => {
    if (previous) return;
    const expiresAt = intakeExpiry(receivedAt, deferred ? null : now);
    if (!expired) checkDeadline(expiresAt);
    await tx.insert(intakeInbox).values({ id, organizationId: workspaceId, connectionId, service: payload.service, externalId, ...identity, receivedAt, payload: expired ? null : payload, payloadDigest: digest, expiresAt, redactedAt: expired ? now : null, state: expired ? "expired" : deferred ? "deferred" : "imported", processedAt: deferred ? null : now });
    // Throwing here rolls back workspace persistence as well as the receipt write.
    if (!expired) checkDeadline(expiresAt);
  });
  try { return await attempt(); }
  catch (error) {
    if (!(error instanceof IntakeDeadlineCrossed)) throw error;
    // One retry only, retaining the first receipt/identity after the known local rollback.
    previous = undefined; pendingContact = false; deferred = false;
    return attempt();
  }
}
export async function intakeSummary(workspaceId: string, actor: Actor) {
  assertPermission(actor.role, "intake.import");
  let rows: Pick<Row, "id" | "error">[] = [], expiredCount = 0;
  return (await mutatePostgresWorkspace(workspaceId, workspace => {
    assertActor(workspace, actor);
    return { count: Math.min(rows.length, 1000), capped: rows.length > 1000, expiredCount, needsConnection: rows.some(row => row.error), message: "Import available enquiries after subscription recovery. Expired payloads cannot be recovered; their contact safety holds remain. No replies or campaigns are scheduled automatically." };
  }, async tx => {
    const now = isoNow(), scope = and(eq(intakeInbox.organizationId, workspaceId), ne(intakeInbox.state, "imported"));
    rows = await tx.select({ id: intakeInbox.id, error: intakeInbox.error }).from(intakeInbox).where(and(scope, isNotNull(intakeInbox.payload), gt(intakeInbox.expiresAt, now), ne(intakeInbox.state, "expired"))).orderBy(asc(intakeInbox.id)).limit(1001);
    const [expired] = await tx.select({ value: count() }).from(intakeInbox).where(and(scope, or(eq(intakeInbox.state, "expired"), lte(intakeInbox.expiresAt, now)))); expiredCount = expired.value;
  })).result;
}
/** Expired receipts are not importable even when cleanup has not run. */
export async function importIntake(workspaceId: string, actor: Actor, after?: string) {
  if (after !== undefined) z.string().regex(/^[a-f0-9]{64}$/).parse(after);
  const initial = await loadWorkspace(workspaceId); assertActor(initial, actor); assertPermission(actor.role, "intake.import");
  await prepareSubscription(workspaceId); await prepareBillingEntitlements(await loadWorkspace(workspaceId));
  let rows: Row[] = [], hasMore = false;
  const processed: { row: Row; processedAt: string; expiresAt: string }[] = [], expired: string[] = [], changedConnection: string[] = [];
  try {
    return await mutatePostgresWorkspace(workspaceId, workspace => {
      assertActor(workspace, actor); assertPermission(actor.role, "intake.import"); assertWorkspaceCapability(workspace);
      const before = workspace.leads.length;
      for (const row of rows) {
        if (Date.parse(row.expiresAt) <= Date.now()) { expired.push(row.id); continue; }
        const connection = connectionFor(workspace, row.service);
        if (!connection || connection.id !== row.connectionId || connection.externalId !== row.externalId) { changedConnection.push(row.id); continue; }
        const payload = payloadValue(row.payload);
        assert(payload.service === row.service, "Stored intake binding is invalid.", 409);
        const processedAt = isoNow();
        if (Date.parse(row.expiresAt) <= Date.parse(processedAt)) { expired.push(row.id); continue; }
        apply(workspace, payload, true, row.receivedAt);
        processed.push({ row, processedAt, expiresAt: new Date(Math.min(Date.parse(row.expiresAt), Date.parse(intakeExpiry(row.receivedAt, processedAt)))).toISOString() });
      }
      assertEnquiryEntitlement(workspace, before, "lead.import");
      if (expired.length) workspace.revision = (workspace.revision || 0) + 1;
      return { imported: processed.length, blocked: changedConnection.length, hasMore, after: hasMore ? rows.at(-1)?.id : undefined };
    }, async tx => {
      const now = isoNow();
      const page = await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), ne(intakeInbox.state, "imported"), ne(intakeInbox.state, "expired"), isNotNull(intakeInbox.payload), gt(intakeInbox.expiresAt, now), after ? gt(intakeInbox.id, after) : undefined)).orderBy(asc(intakeInbox.id)).limit(26);
      hasMore = page.length > 25; rows = page.slice(0, 25);
    }, async tx => {
      for (const { expiresAt } of processed) checkDeadline(expiresAt);
      await expireRows(tx, workspaceId, expired);
      for (const { row, processedAt, expiresAt } of processed) {
        checkDeadline(expiresAt);
        await tx.update(intakeInbox).set({ state: "imported", processedAt, expiresAt, error: null }).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, row.id)));
      }
      for (const id of changedConnection) await tx.update(intakeInbox).set({ error: "Original provider connection must be restored before import." }).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, id)));
      // Recheck every applied receipt after all awaited writes, not just its own update.
      for (const { expiresAt } of processed) checkDeadline(expiresAt);
    });
  } catch (error) {
    if (!(error instanceof IntakeDeadlineCrossed)) throw error;
    // The import transaction has rolled back. Redact due receipts under the same cleanup lock.
    await tenantTransaction(workspaceId, async tx => {
      await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
      const redacted = await expireRows(tx, workspaceId, rows.map(row => row.id));
      if (redacted.length) await tx.update(organizations).set({ revision: sql`${organizations.revision} + 1` }).where(eq(organizations.id, workspaceId));
    });
    throw error;
  }
}
