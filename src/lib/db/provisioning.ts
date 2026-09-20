import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { database } from "./client";
import { organizationProvisioning as operations } from "./schema";
import { AppError, assert } from "../errors";

export interface ProvisioningActor { actorId: string; clientId: string }
export type ProvisioningOperation = typeof operations.$inferSelect;
export const provisioningName = z.string().trim().min(2).max(100);
type Transaction = Parameters<Parameters<ReturnType<typeof database>["transaction"]>[0]>[0];
const actorWhere = (actor: ProvisioningActor) => and(eq(operations.actorId, actor.actorId), eq(operations.clientId, actor.clientId));

/** There is no tenant yet. Both context and predicates come only from hostedSession. */
export async function provisioningTransaction<T>(actor: ProvisioningActor, action: (tx: Transaction) => Promise<T>) {
  z.string().min(1).max(200).parse(actor.actorId); z.string().min(1).max(200).parse(actor.clientId);
  return database().transaction(async tx => {
    await tx.execute(sql`select set_config('app.provisioning_actor', ${actor.actorId}, true), set_config('app.provisioning_client', ${actor.clientId}, true)`);
    return action(tx);
  });
}
export function pendingProvisioning(actor: ProvisioningActor) {
  return provisioningTransaction(actor, async tx => (await tx.select().from(operations).where(and(actorWhere(actor), isNull(operations.acknowledgedAt))))[0]);
}
export function readProvisioning(actor: ProvisioningActor, id: string) {
  z.uuid().parse(id);
  return provisioningTransaction(actor, async tx => {
    const [operation] = await tx.select().from(operations).where(and(actorWhere(actor), eq(operations.id, id)));
    assert(operation, "Institute setup was not found for this account.", 404);
    return operation;
  });
}

/** Dispatch permission is returned ONLY by the successful committed insert, never by reading a row. */
export function beginProvisioning(actor: ProvisioningActor, requestId: string, inputName: string) {
  z.uuid().parse(requestId); const name = provisioningName.parse(inputName);
  return provisioningTransaction(actor, async tx => {
    const id = randomUUID(), now = new Date().toISOString();
    const [inserted] = await tx.insert(operations).values({ id, ...actor, requestId, name, externalId: `admitflow-org-${id}`, phase: "org_dispatched", createdAt: now, updatedAt: now }).onConflictDoNothing().returning();
    if (inserted) return { operation: inserted, dispatch: true };
    const [previous] = await tx.select().from(operations).where(and(actorWhere(actor), eq(operations.requestId, requestId)));
    if (previous) {
      assert(previous.name === name, "This setup request already has a different institute name. Resume the original request.", 409);
      return { operation: previous, dispatch: false };
    }
    throw new AppError("An institute setup is already pending. Check its status and acknowledge completion before creating another.", 409, "PROVISIONING_PENDING");
  });
}

/** Negative evidence is sticky across phase/revision races; it never replaces provider IDs or dispatch history. */
export async function markProvisioningReview(actor: ProvisioningActor, id: string) {
  z.uuid().parse(id);
  const marked = await provisioningTransaction(actor, async tx => (await tx.update(operations)
    .set({ reviewCode: "identity_mismatch", revision: sql`${operations.revision} + 1`, updatedAt: new Date().toISOString() })
    .where(and(actorWhere(actor), eq(operations.id, id), isNull(operations.reviewCode))).returning())[0]);
  return marked || readProvisioning(actor, id);
}

type Transition = Partial<Pick<ProvisioningOperation, "phase" | "organizationId" | "membershipId" | "acknowledgedAt">>;
/** A lost compare-and-set is not permission to dispatch. Caller must reload/reconcile. */
export function transitionProvisioning(actor: ProvisioningActor, before: ProvisioningOperation, change: Transition) {
  assert(before.actorId === actor.actorId && before.clientId === actor.clientId, "Institute setup belongs to another account.", 403);
  return provisioningTransaction(actor, async tx => (await tx.update(operations).set({ ...change, revision: before.revision + 1, updatedAt: new Date().toISOString() })
    .where(and(actorWhere(actor), eq(operations.id, before.id), eq(operations.revision, before.revision), eq(operations.phase, before.phase))).returning())[0]);
}
