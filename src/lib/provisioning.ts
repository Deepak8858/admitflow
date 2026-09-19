import { z } from "zod";
import { assert } from "./errors";
import { beginProvisioning, markProvisioningReview, pendingProvisioning, readProvisioning, transitionProvisioning, type ProvisioningActor, type ProvisioningOperation } from "./db/provisioning";
import type { ProvisioningStatus } from "./provisioning-types";

/** Structural subset of the installed SDK. Provider payloads are validated, not trusted via TS casts. */
export interface ProvisioningProvider {
  organizations: {
    createOrganization(input: { name: string; externalId: string; metadata: Record<string, string> }, options: { idempotencyKey: string }): Promise<unknown>;
    getOrganizationByExternalId(externalId: string): Promise<unknown>;
    getOrganization(id: string): Promise<unknown>;
  };
  userManagement: {
    listOrganizationMemberships(input: { userId: string; organizationId: string; statuses: ("active" | "inactive" | "pending")[] }): Promise<{ autoPagination(): Promise<unknown[]> }>;
    createOrganizationMembership(input: { userId: string; organizationId: string; roleSlug: string }): Promise<unknown>;
  };
}
const organizationSchema = z.object({ id: z.string().regex(/^org_[A-Za-z0-9_]+$/), externalId: z.string(), metadata: z.record(z.string(), z.string()) });
const membershipSchema = z.object({ id: z.string().min(1).max(200), organizationId: z.string(), userId: z.string(), status: z.enum(["active", "inactive", "pending"]), role: z.object({ slug: z.string() }) });
const metadata = (operation: ProvisioningOperation) => ({ admitflow_operation_id: operation.id, admitflow_actor_id: operation.actorId, admitflow_client_id: operation.clientId });
function matchingOrganization(operation: ProvisioningOperation, value: unknown) {
  const parsed = organizationSchema.safeParse(value);
  return parsed.success && parsed.data.externalId === operation.externalId && (!operation.organizationId || parsed.data.id === operation.organizationId)
    && Object.entries(metadata(operation)).every(([key, value]) => parsed.data.metadata[key] === value) ? parsed.data : undefined;
}
function matchingMembership(operation: ProvisioningOperation, value: unknown) {
  const parsed = membershipSchema.safeParse(value);
  return parsed.success && parsed.data.organizationId === operation.organizationId && parsed.data.userId === operation.actorId
    && (!operation.membershipId || parsed.data.id === operation.membershipId) && parsed.data.status === "active" && parsed.data.role.slug === "owner" ? parsed.data : undefined;
}
export function provisioningStatus(operation: ProvisioningOperation): ProvisioningStatus {
  const state = operation.reviewCode ? "review_required" : operation.phase === "ready" ? "ready" : operation.phase === "org_confirmed" ? "continue" : "pending";
  const message = state === "ready" ? "Your institute was created. Open it to finish signing in, or acknowledge setup before creating another."
    : state === "continue" ? "Your institute was confirmed. Continue to set up your owner membership."
    : state === "review_required" ? "Setup identity or membership changed. Ask support to review this operation; do not create a replacement."
    : "Setup is awaiting WorkOS confirmation. Check status; this request will not resend an uncertain creation.";
  return { id: operation.id, requestId: operation.requestId, name: operation.name, state, message, ...(operation.organizationId ? { organizationId: operation.organizationId } : {}), acknowledged: Boolean(operation.acknowledgedAt) };
}
async function update(actor: ProvisioningActor, before: ProvisioningOperation, change: Parameters<typeof transitionProvisioning>[2]) {
  return await transitionProvisioning(actor, before, change) || readProvisioning(actor, before.id);
}
async function review(actor: ProvisioningActor, operation: ProvisioningOperation) { return markProvisioningReview(actor, operation.id); }
async function memberships(provider: ProvisioningProvider, operation: ProvisioningOperation) {
  return (await provider.userManagement.listOrganizationMemberships({ userId: operation.actorId, organizationId: operation.organizationId!, statuses: ["active", "inactive", "pending"] })).autoPagination();
}

/** Reads may confirm positive evidence. Absence and exceptions never reset dispatch permission. */
export async function reconcileProvisioning(actor: ProvisioningActor, operation: ProvisioningOperation, provider: ProvisioningProvider): Promise<ProvisioningOperation> {
  if (operation.reviewCode || operation.phase === "ready") return operation;
  if (operation.phase === "org_dispatched") {
    let value: unknown;
    try { value = await provider.organizations.getOrganizationByExternalId(operation.externalId); }
    catch { return operation; }
    const organization = matchingOrganization(operation, value);
    if (!organization) return review(actor, operation);
    return update(actor, operation, { phase: "org_confirmed", organizationId: organization.id });
  }
  if (operation.phase === "membership_dispatched") {
    let organization: unknown, values: unknown[];
    try { organization = await provider.organizations.getOrganization(operation.organizationId!); values = await memberships(provider, operation); } catch { return operation; }
    if (!matchingOrganization(operation, organization)) return review(actor, operation);
    if (!values.length) return operation;
    const membership = values.length === 1 ? matchingMembership(operation, values[0]) : undefined;
    if (!membership) return review(actor, operation);
    return update(actor, operation, { phase: "ready", membershipId: membership.id });
  }
  return operation;
}
export async function pendingProvisioningStatus(actor: ProvisioningActor, provider: ProvisioningProvider) {
  const operation = await pendingProvisioning(actor);
  return operation ? provisioningStatus(await reconcileProvisioning(actor, operation, provider)) : null;
}

async function completeMembership(actor: ProvisioningActor, operation: ProvisioningOperation, provider: ProvisioningProvider) {
  if (operation.phase !== "org_confirmed" || operation.reviewCode || operation.acknowledgedAt) return operation;
  let organization: unknown, values: unknown[];
  try { organization = await provider.organizations.getOrganization(operation.organizationId!); values = await memberships(provider, operation); }
  catch { return operation; }
  if (!matchingOrganization(operation, organization)) return review(actor, operation);
  if (values.length) {
    const member = values.length === 1 ? matchingMembership(operation, values[0]) : undefined;
    return member ? update(actor, operation, { phase: "ready", membershipId: member.id }) : review(actor, operation);
  }
  const claimed = await transitionProvisioning(actor, operation, { phase: "membership_dispatched" });
  if (!claimed) return readProvisioning(actor, operation.id);
  let value: unknown;
  try { value = await provider.userManagement.createOrganizationMembership({ userId: claimed.actorId, organizationId: claimed.organizationId!, roleSlug: "owner" }); }
  catch { return claimed; }
  const membership = matchingMembership(claimed, value);
  return membership ? update(actor, claimed, { phase: "ready", membershipId: membership.id }) : review(actor, claimed);
}
export async function startProvisioning(actor: ProvisioningActor, requestId: string, name: string, provider: ProvisioningProvider) {
  const start = await beginProvisioning(actor, requestId, name);
  let operation = start.operation;
  if (start.dispatch) {
    let value: unknown;
    try { value = await provider.organizations.createOrganization({ name: operation.name, externalId: operation.externalId, metadata: metadata(operation) }, { idempotencyKey: operation.id }); }
    catch { return provisioningStatus(operation); }
    const organization = matchingOrganization(operation, value);
    if (!organization) return provisioningStatus(await review(actor, operation));
    operation = await update(actor, operation, { phase: "org_confirmed", organizationId: organization.id });
  } else operation = await reconcileProvisioning(actor, operation, provider);
  return provisioningStatus(await completeMembership(actor, operation, provider));
}
export async function continueProvisioning(actor: ProvisioningActor, id: string, provider: ProvisioningProvider) {
  const operation = await reconcileProvisioning(actor, await readProvisioning(actor, id), provider);
  return provisioningStatus(await completeMembership(actor, operation, provider));
}
/** Completion is not authorization: refresh positive membership evidence before open OR acknowledgement. */
export async function readyProvisioning(actor: ProvisioningActor, id: string, provider: ProvisioningProvider) {
  const operation = await readProvisioning(actor, id);
  assert(operation.phase === "ready" && !operation.reviewCode, "Institute setup is not ready. Check its status first.", 409);
  let organization: unknown, values: unknown[];
  try { organization = await provider.organizations.getOrganization(operation.organizationId!); values = await memberships(provider, operation); }
  catch { assert(false, "Institute access could not be verified. Retry opening it later.", 503); }
  assert(matchingOrganization(operation, organization) && values.length === 1 && matchingMembership(operation, values[0]), "Institute ownership changed. Ask an administrator to review access.", 403);
  return operation;
}
export async function acknowledgeProvisioning(actor: ProvisioningActor, id: string, provider: ProvisioningProvider) {
  const operation = await readyProvisioning(actor, id, provider);
  return provisioningStatus(operation.acknowledgedAt ? operation : await update(actor, operation, { acknowledgedAt: new Date().toISOString() }));
}
