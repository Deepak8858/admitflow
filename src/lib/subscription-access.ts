import { eq } from "drizzle-orm";
import { productionDatabase } from "./config";
import { tenantTransaction } from "./db/repository";
import { organizations, instituteTrials } from "./db/schema";
import { assert } from "./errors";
import { assertCapability, actionCapability, subscriptionCapabilities, SubscriptionRestricted } from "./subscription-policy";
import type { Workspace } from "./domain";

type Transaction = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
export async function readSubscriptionState(tx: Transaction, organization: typeof organizations.$inferSelect) {
  const [trial] = organization.workosId ? await tx.select({ startedAt: instituteTrials.startedAt, endsAt: instituteTrials.endsAt, consumed: instituteTrials.consumed }).from(instituteTrials).where(eq(instituteTrials.workosId, organization.workosId)) : [];
  return { demo: organization.demo, subscription: organization.subscription, trial };
}
export function assertWorkspaceCapability(workspace: Pick<Workspace, "demo" | "subscription" | "trial">) { assertCapability(workspace, productionDatabase()); }
export function assertActionCapability(workspace: Workspace, action: Record<string, unknown>) {
  if (actionCapability(workspace, action)) assertWorkspaceCapability(workspace);
}
/** Provider refresh occurs before the final short check, never in an aggregate callback. */
export async function prepareSubscription(workspaceId: string) {
  if (!productionDatabase()) return;
  const { refreshBillingAccess } = await import("./providers/billing");
  try { await refreshBillingAccess(workspaceId); }
  catch { throw new SubscriptionRestricted({ allowed: false, reason: "verification_required", message: "Subscription verification is unavailable. Existing data and billing remain available; retry verification before using paid features.", checkedAt: new Date().toISOString() }); }
}
export async function requirePaidCapability(workspaceId: string) {
  if (!productionDatabase()) return;
  await prepareSubscription(workspaceId);
  await tenantTransaction(workspaceId, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    assert(organization, "Institute not found.", 404);
    assertWorkspaceCapability(await readSubscriptionState(tx, organization));
  });
}
export function workspaceCapabilities(workspace: Pick<Workspace, "demo" | "subscription" | "trial">) { return subscriptionCapabilities(workspace, productionDatabase()); }
