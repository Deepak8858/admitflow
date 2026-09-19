import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { mutatePostgresWorkspace, tenantTransaction } from "./repository";
import { intakeInbox } from "./schema";
import { intakePayloadSchema, MAX_INTAKE_BYTES, type IntakePayload } from "../intake-types";
import { assert } from "../errors";
import { connectionFor } from "../connections";
import { isoNow, normalizePhone, stopJobs, type Workspace } from "../domain";
import { assertActor, assertPermission } from "../permissions";
import { assertWorkspaceCapability, workspaceCapabilities, prepareSubscription } from "../subscription-access";
import { assertEnquiryEntitlement, prepareBillingEntitlements } from "../providers/billing";
import { receiveMessage } from "../providers/meta";
import { applyMetaLead, metaLeadPhone } from "../providers/meta-leads";
import { loadWorkspace } from "../store";

type Row = typeof intakeInbox.$inferSelect;
type Actor = NonNullable<Workspace["actor"]>;
function payloadValue(raw: unknown): IntakePayload {
  const payload = intakePayloadSchema.parse(raw);
  // Leave room for JSONB's whitespace representation in the database bound.
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
  return tenantTransaction(workspaceId, async tx => (await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, intakeId(workspaceId, "meta_leads", pageId, eventId)))))[0]);
}
/** Called only by verified provider adapters. Receipt and aggregate commit together. */
export async function acceptIntake(workspaceId: string, connectionId: string, externalId: string, raw: IntakePayload) {
  const payload = payloadValue(raw), eventId = payload.service === "whatsapp" ? payload.event.id : payload.event.leadgenId;
  const id = intakeId(workspaceId, payload.service, externalId, eventId);
  const contactKey = payload.service === "whatsapp" ? normalizePhone(payload.event.from)! : metaLeadPhone(payload.form) || "";
  let previous: Row | undefined, pendingContact = false, deferred = false;
  const receivedAt = isoNow();
  return mutatePostgresWorkspace(workspaceId, workspace => {
    const connection = connectionFor(workspace, payload.service);
    assert(!workspace.demo && connection?.id === connectionId && connection.externalId === externalId, "The intake connection changed. Restore the original connection before retrying.", 409);
    if (previous) {
      assert(previous.connectionId === connectionId && isDeepStrictEqual(previous.payload, payload), "The intake identity is already bound to a different payload or connection.", 409);
      return { duplicate: true, deferred: previous.state !== "imported" };
    }
    const candidate = structuredClone(workspace), before = candidate.leads.length;
    apply(candidate, payload, !workspaceCapabilities(workspace).allowed || pendingContact, receivedAt);
    const creates = candidate.leads.length > before;
    // Existing records and opt-outs remain writable even when new intake is restricted.
    deferred = creates && (!workspaceCapabilities(workspace).allowed || pendingContact);
    if (!deferred) Object.assign(workspace, candidate);
    // A new deferred receipt must notify open clients even without an aggregate change.
    else workspace.revision = (workspace.revision || 0) + 1;
    return { duplicate: false, deferred };
  }, async tx => {
    [previous] = await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, id)));
    if (contactKey) pendingContact = (await tx.select({ id: intakeInbox.id }).from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.contactKey, contactKey), ne(intakeInbox.state, "imported"))).limit(1)).length > 0;
  }, async tx => {
    if (!previous) await tx.insert(intakeInbox).values({ id, organizationId: workspaceId, connectionId, service: payload.service, externalId, contactKey, receivedAt, payload, state: deferred ? "deferred" : "imported", processedAt: deferred ? null : isoNow() });
  });
}
export async function intakeSummary(workspaceId: string, actor: Actor) {
  assertPermission(actor.role, "intake.import");
  let rows: Pick<Row, "id" | "error">[] = [];
  return (await mutatePostgresWorkspace(workspaceId, workspace => {
    assertActor(workspace, actor);
    return { count: Math.min(rows.length, 1000), capped: rows.length > 1000, needsConnection: rows.some(row => row.error), message: "Import in batches after subscription recovery. No replies or campaigns are scheduled automatically." };
  }, async tx => {
    rows = await tx.select({ id: intakeInbox.id, error: intakeInbox.error }).from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), ne(intakeInbox.state, "imported"))).orderBy(asc(intakeInbox.id)).limit(1001);
  })).result;
}
/** Page cursor is a receipt hash, not caller-selected provider/tenant data. A failed quota check rolls back the entire page. */
export async function importIntake(workspaceId: string, actor: Actor, after?: string) {
  if (after !== undefined) z.string().regex(/^[a-f0-9]{64}$/).parse(after);
  const initial = await loadWorkspace(workspaceId); assertActor(initial, actor); assertPermission(actor.role, "intake.import");
  await prepareSubscription(workspaceId); await prepareBillingEntitlements(await loadWorkspace(workspaceId));
  let rows: Row[] = [], processed: string[] = [], changedConnection: string[] = [], hasMore = false;
  return mutatePostgresWorkspace(workspaceId, workspace => {
    assertActor(workspace, actor); assertPermission(actor.role, "intake.import"); assertWorkspaceCapability(workspace);
    const before = workspace.leads.length;
    for (const row of rows) {
      const connection = connectionFor(workspace, row.service);
      if (!connection || connection.id !== row.connectionId || connection.externalId !== row.externalId) { changedConnection.push(row.id); continue; }
      const payload = payloadValue(row.payload);
      assert(payload.service === row.service, "Stored intake binding is invalid.", 409);
      apply(workspace, payload, true, row.receivedAt); processed.push(row.id);
    }
    assertEnquiryEntitlement(workspace, before, "lead.import");
    return { imported: processed.length, blocked: changedConnection.length, hasMore, after: hasMore ? rows.at(-1)?.id : undefined };
  }, async tx => {
    const page = await tx.select().from(intakeInbox).where(and(eq(intakeInbox.organizationId, workspaceId), ne(intakeInbox.state, "imported"), after ? gt(intakeInbox.id, after) : undefined)).orderBy(asc(intakeInbox.id)).limit(26);
    hasMore = page.length > 25; rows = page.slice(0, 25);
  }, async tx => {
    for (const id of processed) await tx.update(intakeInbox).set({ state: "imported", processedAt: isoNow(), error: null }).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, id)));
    for (const id of changedConnection) await tx.update(intakeInbox).set({ error: "Original provider connection must be restored before import." }).where(and(eq(intakeInbox.organizationId, workspaceId), eq(intakeInbox.id, id)));
  });
}
