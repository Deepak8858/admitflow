import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, gt, count, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { productionDatabase } from "../config";
import { database } from "../db/client";
import { tenantTransaction } from "../db/repository";
import { assertAccessFence, type AccessFence } from "../db/team-access";
import { connectionRoutes, eventReceipts, organizationRoutes, organizations, members as memberTable, leads as leadTable } from "../db/schema";
import { isoNow, uid, type Member, type Subscription, type SubscriptionEntitlements, type SubscriptionLimits, type Workspace } from "../domain";
import { AppError, assert } from "../errors";
import { readLimitedText } from "../http";
import { instituteTrials } from "../db/schema";
import { subscriptionNeedsRefresh } from "../subscription-policy";
import { readSubscriptionState, assertWorkspaceCapability, workspaceCapabilities } from "../subscription-access";

const PRODUCT = "admitflow_saas";
const limit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const limitsSchema = z.object({ members: limit.optional(), leads: limit.optional() }).strict();
const planSchema = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,49}$/), name: z.string().trim().min(1).max(100), description: z.string().max(300).optional(), razorpayPlanId: z.string().regex(/^plan_[A-Za-z0-9]+$/), totalCount: z.number().int().min(1).max(1200), limits: limitsSchema.optional() }).strict();
export type BillingPlan = z.infer<typeof planSchema>;
export interface BillingPlanOption { id: string; name: string; description?: string; totalCount: number; amount: number; currency: string; period: string; interval: number; limits: SubscriptionLimits }
const subscriptionSchema = z.object({
  id: z.string().regex(/^sub_[A-Za-z0-9]+$/), plan_id: z.string().regex(/^plan_[A-Za-z0-9]+$/),
  status: z.enum(["created", "authenticated", "active", "pending", "halted", "paused", "cancelled", "completed", "expired"]),
  notes: z.preprocess(value => value == null || (Array.isArray(value) && value.length === 0) ? {} : value, z.record(z.string(), z.unknown())), short_url: z.string().nullable().optional(),
  current_end: z.number().int().nonnegative().max(253402300799).nullable().optional(), charge_at: z.number().int().nonnegative().max(253402300799).nullable().optional(),
  customer_id: z.string().nullable().optional(),
});
export type BillingSubscription = z.infer<typeof subscriptionSchema>;
export interface BillingOverview {
  mode: "demo" | "setup" | "test" | "live";
  subscription: Subscription;
  plans: BillingPlanOption[];
  message: string;
  providerStatus?: BillingSubscription["status"];
  checkoutUrl?: string;
  canCancel: boolean;
  entitlements: BillingEntitlementSnapshot;
}
const operationSchema = z.object({ requestId: z.uuid(), planId: z.string(), providerPlanId: z.string(), planName: z.string(), totalCount: z.number(), startedAt: z.number(), phase: z.enum(["creating", "uncertain", "ready", "failed"]), providerId: z.string().optional() });
type CheckoutOperation = z.infer<typeof operationSchema>;
type BillingTransaction = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
type OrganizationRow = typeof organizations.$inferSelect;
const operationId = (workspaceId: string) => `billing:checkout:${workspaceId}`;
const requestReceiptId = (workspaceId: string, requestId: string) => `billing:request:${workspaceId}:${requestId}`;
const terminal = (status: BillingSubscription["status"]) => ["cancelled", "completed", "expired"].includes(status);
const unlimited = (): SubscriptionLimits => ({ members: null, leads: null });
export const normalizedPlanLimits = (plan: Pick<BillingPlan, "limits">): SubscriptionLimits => ({ members: plan.limits?.members ?? null, leads: plan.limits?.leads ?? null });
const savedEntitlementsSchema = z.object({ version: z.literal(1), subscriptionId: z.string().regex(/^sub_[A-Za-z0-9]+$/), planId: z.string().min(1), providerPlanId: z.string().regex(/^plan_[A-Za-z0-9]+$/), limits: z.object({ members: limit, leads: limit }).strict() });

export interface BillingEntitlementPolicy {
  state: "catalog" | "snapshot" | "unconfigured" | "unverified" | "invalid" | "local" | "demo";
  planId?: string; providerPlanId?: string;
  limits: SubscriptionLimits | null;
  message: string;
}
export interface BillingEntitlementSnapshot extends BillingEntitlementPolicy {
  usage: { members: number; leads: number; reservedMembers: number };
  enforcement: { members: "team_invite_reactivate"; leads: "workspace_create_import" };
  checkedAt: string;
}

function savedEntitlements(subscription?: Subscription): SubscriptionEntitlements | undefined {
  const parsed = savedEntitlementsSchema.safeParse(subscription?.entitlements);
  return parsed.success && parsed.data.subscriptionId === subscription?.providerId && parsed.data.providerPlanId === subscription.providerPlanId && parsed.data.planId === subscription.planId ? parsed.data : undefined;
}

/** Plan identity is established by a verified provider plan ID, never by the display label in Subscription.plan. */
export function billingEntitlementPolicy(workspace: Pick<Workspace, "demo" | "subscription">, rawCatalog = process.env.BILLING_PLANS_JSON, hosted = productionDatabase()): BillingEntitlementPolicy {
  if (workspace.demo) return { state: "demo", limits: unlimited(), message: "Demo data has no enforced subscription limits." };
  if (!hosted) return { state: "local", limits: unlimited(), message: "Local preview accounts have no enforced subscription limits." };
  const subscription = workspace.subscription, saved = savedEntitlements(subscription);
  if (!subscription?.providerId) return { state: "unconfigured", limits: unlimited(), message: "No verified subscription is linked. No application limits are configured for this workspace." };
  let catalog: BillingPlan[] = [];
  if (rawCatalog?.trim()) {
    try { catalog = parseBillingPlans(rawCatalog); }
    catch { return { state: "invalid", limits: null, message: "The billing catalog is invalid. New seats and enquiries are paused until its configuration is corrected." }; }
  }
  const plan = subscription.providerPlanId ? catalog.find(item => item.razorpayPlanId === subscription.providerPlanId) : undefined;
  if (plan) return { state: "catalog", planId: plan.id, providerPlanId: plan.razorpayPlanId, limits: normalizedPlanLimits(plan), message: "Catalog limits apply to app invitations/reactivations and manual/CSV enquiry additions. Existing records are retained." };
  if (saved) return { state: "snapshot", planId: saved.planId, providerPlanId: saved.providerPlanId, limits: saved.limits, message: "Using the last verified plan limits because this provider plan is absent from the current catalog." };
  if (subscription.entitlements) return { state: "invalid", limits: null, message: "The saved limits do not match this subscription. Restore its catalog configuration and verify Billing before adding capacity." };
  if (!subscription.providerPlanId && catalog.some(item => Object.values(normalizedPlanLimits(item)).some(value => value !== null))) return { state: "unverified", limits: null, message: "Verify the linked subscription in Billing before adding seats or enquiries; its plan identity has not been reconciled yet." };
  return { state: "unconfigured", planId: subscription.planId, providerPlanId: subscription.providerPlanId, limits: unlimited(), message: "No limits are configured for this verified plan. Members and enquiries are unlimited through the app quota guards." };
}

/** Backfill old subscription JSON from Razorpay only when configured limits need the missing stable identity. */
export async function prepareBillingEntitlements(workspace: Workspace) {
  const policy = billingEntitlementPolicy(workspace);
  if (policy.state === "unverified") await refreshSubscription(workspace.id, workspace.subscription!.providerId!);
  else assert(policy.state !== "invalid", policy.message, 503);
}

/** Call AFTER the complete domain transition, INSIDE mutateWorkspace's tenant lock, so imports roll back as a unit. */
export function assertEnquiryEntitlement(workspace: Workspace, previousCount: number, action: "lead.create" | "lead.import") {
  assertWorkspaceCapability(workspace);
  const added = workspace.leads.length - previousCount;
  if (added <= 0) return;
  const policy = billingEntitlementPolicy(workspace);
  assert(policy.limits, policy.message, 503);
  const maximum = policy.limits.leads;
  if (maximum !== null && workspace.leads.length > maximum) throw new AppError(action === "lead.import"
    ? `This import would add ${added} new enquiries to ${previousCount}, exceeding the plan limit of ${maximum}. No import rows were saved. ${Math.max(0, maximum - previousCount)} spaces remain; duplicates and invalid rows do not use capacity.`
    : `The enquiry limit is ${maximum}; ${previousCount} enquiries are already stored. No enquiry was added.`, 409);
}

export function parseBillingPlans(raw: string): BillingPlan[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new AppError("BILLING_PLANS_JSON must contain a valid JSON array of platform subscription plans.", 503); }
  const result = z.array(planSchema).min(1).max(12).safeParse(value);
  assert(result.success, "Configure BILLING_PLANS_JSON with id, name, razorpayPlanId, totalCount and optional positive-integer or null members/leads limits.", 503);
  assert(new Set(result.data.map(plan => plan.id)).size === result.data.length && new Set(result.data.map(plan => plan.razorpayPlanId)).size === result.data.length, "Platform billing plan IDs must be unique.", 503);
  return result.data;
}
function keys() {
  const keyId = process.env.BILLING_RAZORPAY_KEY_ID, keySecret = process.env.BILLING_RAZORPAY_KEY_SECRET;
  assert(keyId && keySecret, "Platform billing needs BILLING_RAZORPAY_KEY_ID and BILLING_RAZORPAY_KEY_SECRET.", 503);
  return { keyId, keySecret };
}
function plans() { return parseBillingPlans(process.env.BILLING_PLANS_JSON || ""); }
function billingSetup() {
  assert(productionDatabase(), "Hosted subscription billing requires the production database.", 503);
  const config = keys();
  assert(process.env.BILLING_RAZORPAY_WEBHOOK_SECRET, "Configure BILLING_RAZORPAY_WEBHOOK_SECRET before enabling subscription checkout.", 503);
  return { ...config, plans: plans() };
}

class BillingProviderError extends AppError {
  constructor(public definitive: boolean, status: number) {
    super(`Razorpay could not complete the platform subscription operation (${status}). Check billing configuration or retry.`, definitive ? 422 : 503);
  }
}
async function billingRequest(path: string, body?: Record<string, unknown>): Promise<unknown> {
  const config = keys();
  // These are global SaaS billing credentials, never an institute's fee-collection connection.
  const response = await fetch(`https://api.razorpay.com/v1/${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Basic ${Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64")}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
  if (!response.ok) throw new BillingProviderError(response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status), response.status);
  try { return JSON.parse(await readLimitedText(response, 2_000_000)); }
  catch { throw new AppError("Razorpay returned an unreadable billing response. Retry reconciliation.", 502); }
}
async function fetchSubscription(id: string) {
  assert(/^sub_[A-Za-z0-9]+$/.test(id), "Invalid subscription reference.", 409);
  const result = subscriptionSchema.safeParse(await billingRequest(`subscriptions/${encodeURIComponent(id)}`));
  assert(result.success && result.data.id === id, "Razorpay returned an invalid subscription response. Retry reconciliation.", 502);
  return result.data;
}
async function planOption(plan: BillingPlan): Promise<BillingPlanOption> {
  const result = z.object({ id: z.string(), period: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]), interval: z.number().int().positive(), item: z.object({ amount: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/) }) }).safeParse(await billingRequest(`plans/${encodeURIComponent(plan.razorpayPlanId)}`));
  assert(result.success && result.data.id === plan.razorpayPlanId, "The configured billing plan could not be verified with Razorpay.", 502);
  return { id: plan.id, name: plan.name, description: plan.description, totalCount: plan.totalCount, amount: result.data.item.amount, currency: result.data.item.currency, period: result.data.period, interval: result.data.interval, limits: normalizedPlanLimits(plan) };
}
const OVERVIEW_PLAN_TTL_MS = 5 * 60_000;
let overviewConfiguration = "";
const overviewPlans = new Map<string, { promise: Promise<BillingPlanOption>; expiresAt?: number }>();
function syncOverviewConfiguration() {
  const fingerprint = createHash("sha256").update(JSON.stringify([process.env.BILLING_RAZORPAY_KEY_ID, process.env.BILLING_RAZORPAY_KEY_SECRET, process.env.BILLING_RAZORPAY_ACCOUNT_ID, process.env.BILLING_RAZORPAY_WEBHOOK_SECRET, process.env.BILLING_PLANS_JSON, process.env.DATABASE_URL])).digest("hex");
  if (overviewConfiguration !== fingerprint) { overviewPlans.clear(); overviewConfiguration = fingerprint; }
}
function overviewPlanOption(plan: BillingPlan): Promise<BillingPlanOption> {
  const cached = overviewPlans.get(plan.id);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) return cached.promise.then(option => structuredClone(option));
  // Only validated catalog members reach this function (at most 12); failures never remain cached.
  const entry: { promise: Promise<BillingPlanOption>; expiresAt?: number } = { promise: planOption(plan) };
  overviewPlans.set(plan.id, entry);
  entry.promise = entry.promise.then(option => {
    entry.expiresAt = Date.now() + OVERVIEW_PLAN_TTL_MS;
    return option;
  }, error => {
    if (overviewPlans.get(plan.id) === entry) overviewPlans.delete(plan.id);
    throw error;
  });
  return entry.promise.then(option => structuredClone(option));
}

export function billingCheckoutUrl(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.port && !url.username && !url.password && ["rzp.io", "razorpay.com", "checkout.razorpay.com"].includes(url.hostname)) return url.toString();
  } catch { /* Invalid provider URLs are never sent to the browser. */ }
  return undefined;
}
export function assertBillingTenant(entity: BillingSubscription, workspaceId: string) {
  assert(entity.notes.admitflow_product === PRODUCT && entity.notes.admitflow_workspace_id === workspaceId, "This subscription does not belong to this institute's AdmitFlow billing account.", 403);
}

/** The existing Subscription shape is a projection; provider lifecycle detail stays in the billing API. */
export function projectBillingSubscription(current: Subscription | undefined, entity: BillingSubscription, name: string, plan?: BillingPlan): Subscription {
  assert(!current?.providerId || current.providerId === entity.id, "A different subscription is already bound to this institute.", 409);
  assert(!plan || plan.razorpayPlanId === entity.plan_id, "The catalog plan does not match the verified provider subscription.", 409);
  const planId = plan?.id || (current?.providerPlanId === entity.plan_id ? current.planId : undefined);
  const existingSnapshot = savedEntitlements(current);
  const entitlements = plan ? { version: 1 as const, subscriptionId: entity.id, planId: plan.id, providerPlanId: entity.plan_id, limits: normalizedPlanLimits(plan) } : existingSnapshot?.providerPlanId === entity.plan_id ? existingSnapshot : undefined;
  const identity = { providerPlanId: entity.plan_id, ...(planId ? { planId } : {}), ...(entitlements ? { entitlements } : {}) };
  // A late checkout response cannot roll an activated or cancelled subscription back to trial.
  if (current?.providerId === entity.id && (current.status === "cancelled" || (current.status !== "trial" && ["created", "authenticated"].includes(entity.status)))) {
    const { planId: _planId, providerPlanId: _providerPlanId, entitlements: _entitlements, ...previous } = current;
    return { ...previous, ...identity };
  }
  const status: Subscription["status"] = terminal(entity.status) ? "cancelled" : entity.status === "active" ? "active" : ["pending", "halted", "paused"].includes(entity.status) ? "past_due" : "trial";
  const renews = entity.charge_at || entity.current_end;
  return { status, plan: name, providerId: entity.id, ...identity, providerStatus: entity.status, verifiedAt: isoNow(), ...(entity.current_end && entity.current_end > 0 ? { currentPeriodEnd: new Date(entity.current_end * 1000).toISOString() } : {}), ...(!terminal(entity.status) && renews && renews > 0 ? { renewsAt: new Date(renews * 1000).toISOString() } : {}) };
}

async function lockedOrganization(tx: BillingTransaction, workspaceId: string) {
  const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
  assert(organization && !organization.demo, "Live billing is not available for this institute.", 409);
  return organization;
}
async function checkoutOperation(tx: BillingTransaction, workspaceId: string) {
  const [row] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, operationId(workspaceId)), eq(eventReceipts.organizationId, workspaceId)));
  if (!row) return undefined;
  const result = operationSchema.safeParse(row.payload);
  assert(result.success, "The checkout operation record needs reconciliation.", 503);
  return result.data;
}
async function saveOperation(tx: BillingTransaction, workspaceId: string, operation: CheckoutOperation, error: string | null = null) {
  const processedAt = operation.phase === "ready" || operation.phase === "failed" ? isoNow() : null;
  for (const id of [operationId(workspaceId), requestReceiptId(workspaceId, operation.requestId)]) await tx.insert(eventReceipts).values({ id, organizationId: workspaceId, provider: "billing_checkout", receivedAt: isoNow(), payload: { ...operation }, processedAt, error }).onConflictDoUpdate({ target: eventReceipts.id, set: { payload: { ...operation }, processedAt, error }, setWhere: eq(eventReceipts.organizationId, workspaceId) });
}
async function persistSubscription(tx: BillingTransaction, organization: OrganizationRow, entity: BillingSubscription, planName: string, allowReplacement = false) {
  assertBillingTenant(entity, organization.id);
  await blockPendingPaidJobs(tx, organization);
  const previous = organization.subscription;
  assert(!previous.providerId || previous.providerId === entity.id || (allowReplacement && previous.status === "cancelled"), "A different subscription is already bound to this institute.", 409);
  let plan: BillingPlan | undefined;
  try { plan = plans().find(item => item.razorpayPlanId === entity.plan_id); } catch { /* Preserve an existing verified snapshot if catalog configuration is unavailable. */ }
  assert(previous.providerId !== entity.id || !previous.entitlements || savedEntitlements(previous) || plan, "The saved limit snapshot needs a valid catalog before it can be reconciled.", 503);
  const next = projectBillingSubscription(previous.providerId && previous.providerId !== entity.id ? undefined : previous, entity, planName, plan);
  if (organization.workosId && !["created", "authenticated"].includes(entity.status)) {
    await tx.insert(instituteTrials).values({ workosId: organization.workosId, consumed: true, provenance: "verified-subscription" }).onConflictDoUpdate({ target: instituteTrials.workosId, set: { consumed: true } });
  }
  await tx.insert(connectionRoutes).values({ service: "billing", externalId: entity.id, organizationId: organization.id }).onConflictDoNothing();
  const [route] = await tx.select().from(connectionRoutes).where(and(eq(connectionRoutes.service, "billing"), eq(connectionRoutes.externalId, entity.id)));
  assert(route?.organizationId === organization.id, "Subscription routing conflicts with another institute.", 409);
  if (!isDeepStrictEqual(next, previous)) await tx.update(organizations).set({ subscription: next, revision: sql`${organizations.revision} + 1` }).where(eq(organizations.id, organization.id));
  await blockPendingPaidJobs(tx, { ...organization, subscription: next });
  return next;
}
function configuredPlanName(entity: BillingSubscription, fallback: string) {
  try { return plans().find(plan => plan.razorpayPlanId === entity.plan_id)?.name || fallback; } catch { return fallback; }
}
function matchesOperation(operation: CheckoutOperation | undefined, entity: BillingSubscription) {
  return Boolean(operation && operation.requestId === entity.notes.admitflow_checkout_id && operation.providerPlanId === entity.plan_id && (!operation.providerId || operation.providerId === entity.id));
}
async function finalizeCheckout(workspaceId: string, operation: CheckoutOperation, entity: BillingSubscription) {
  return tenantTransaction(workspaceId, async tx => {
    const organization = await lockedOrganization(tx, workspaceId), current = await checkoutOperation(tx, workspaceId);
    assert(current?.requestId === operation.requestId && matchesOperation(current, entity), "Checkout changed while it was being created. Refresh billing to reconcile.", 409);
    const subscription = await persistSubscription(tx, organization, entity, operation.planName, true);
    await saveOperation(tx, workspaceId, { ...current, phase: "ready", providerId: entity.id });
    return { subscription, checkoutUrl: subscription.status === "cancelled" ? undefined : billingCheckoutUrl(entity.short_url), providerStatus: subscription.status === "cancelled" ? "cancelled" as const : entity.status };
  });
}
async function refreshSubscription(workspaceId: string, subscriptionId: string) {
  return tenantTransaction(workspaceId, async tx => {
    const organization = await lockedOrganization(tx, workspaceId);
    assert(organization.subscription.providerId === subscriptionId, "The subscription changed. Refresh billing.", 409);
    // Fetch while holding the tenant row lock so out-of-order callbacks cannot regress a newer provider snapshot.
    const entity = await fetchSubscription(subscriptionId);
    const subscription = await persistSubscription(tx, organization, entity, configuredPlanName(entity, organization.subscription.plan));
    return { subscription, entity };
  });
}

/** Preserve accepted/uncertain operations, but never automatically revive scheduled paid work. */
async function blockPendingPaidJobs(tx: BillingTransaction, organization: OrganizationRow) {
  const policy = workspaceCapabilities(await readSubscriptionState(tx, organization));
  // Stale evidence alone is not a known delinquency; the next dispatch must verify it.
  if (policy.allowed || policy.reason === "verification_required") return;
  const blocked = await tx.execute(sql`update jobs j set status = 'failed', locked_at = null,
    error = ${policy.message}, payload = j.payload || '{"blockedReason":"subscription"}'::jsonb
    where j.organization_id = ${organization.id} and j.status in ('pending', 'processing') and j.dispatched_at is null
      and j.kind in ('followup', 'reminder', 'ai.reply', 'appointment.book', 'knowledge.index')
      and not exists (select 1 from messages m where m.organization_id = j.organization_id and m.id = j.message_id
        and (m.provider_id is not null or m.dispatched_at is not null or m.status_at is not null))
    returning j.id`);
  if (blocked.rows.length) {
    await tx.execute(sql`update messages m set status = 'failed', error = ${policy.message}
      where m.organization_id = ${organization.id} and m.status = 'queued' and m.dispatched_at is null and m.provider_id is null
      and exists (select 1 from jobs j where j.organization_id = m.organization_id and j.message_id = m.id and j.status = 'failed' and j.payload->>'blockedReason' = 'subscription')`);
    await tx.update(organizations).set({ revision: sql`${organizations.revision} + 1` }).where(eq(organizations.id, organization.id));
  }
}
/** Refresh under the existing tenant serialization; a concurrent fresh result suppresses duplicate reads. */
export async function refreshBillingAccess(workspaceId: string) {
  return tenantTransaction(workspaceId, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    assert(organization, "Institute not found.", 404);
    if (organization.demo) return;
    await blockPendingPaidJobs(tx, organization);
    if (!subscriptionNeedsRefresh(organization.subscription)) return;
    const entity = await fetchSubscription(organization.subscription.providerId!);
    await persistSubscription(tx, organization, entity, configuredPlanName(entity, organization.subscription.plan));
  });
}

/** One bounded page per tick; advance past failures so one provider outage cannot starve other institutes. */
export async function reconcileSubscriptions(after?: string, limit = 10) {
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 20, "Invalid reconciliation batch.", 400);
  const routes = await database().select().from(organizationRoutes).where(after ? gt(organizationRoutes.organizationId, after) : undefined).orderBy(asc(organizationRoutes.organizationId)).limit(limit);
  let failed = 0;
  for (const route of routes) {
    if (!route.workosId) continue;
    try { await refreshBillingAccess(route.organizationId); } catch { failed++; }
  }
  return { selected: routes.length, failed, after: routes.length === limit ? routes.at(-1)!.organizationId : undefined };
}

const seatSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), emailHash: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["invite", "reactivate"]), phase: z.enum(["reserved", "confirmed", "uncertain", "released"]),
  changedAt: z.number().int().nonnegative(), providerRef: z.string().optional(), memberId: z.string().optional(), workosId: z.string().optional(),
});
type SeatReservation = z.infer<typeof seatSchema>;
export interface BillingSeatClaim { workspaceId: string; id: string; requestId: string; owned: boolean }
export interface BillingSeatEvidence {
  observedAt: number;
  memberships: { id: string; userId: string; organizationId: string; status: string }[];
  invitations: { id: string; email: string; organizationId: string | null; state: string; acceptedUserId: string | null }[];
}
const emailHash = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex");

async function seatRows(tx: BillingTransaction, workspaceId: string) {
  const rows = await tx.select({ id: eventReceipts.id, payload: eventReceipts.payload }).from(eventReceipts).where(and(eq(eventReceipts.organizationId, workspaceId), eq(eventReceipts.provider, "billing_seat")));
  return rows.map(row => {
    const result = seatSchema.safeParse(row.payload);
    assert(result.success, "A pending seat reservation needs reconciliation before capacity can be checked.", 503);
    return { id: row.id, reservation: result.data };
  });
}
type SeatMember = Pick<Member, "id" | "email" | "status"> & { workosId?: string | null };

/** Active identities count individually. Invitation projections/reservations for the same recipient count once. */
export function billingSeatUsage(members: SeatMember[], reservations: SeatReservation[] = []) {
  const identities = new Set<string>(), memberIds = new Set<string>(), emails = new Set<string>();
  let used = 0, reserved = 0;
  for (const member of members.filter(item => item.status === "active")) {
    const identity = member.workosId ? `workos:${member.workosId}` : `member:${member.id}`;
    if (!identities.has(identity)) { used++; identities.add(identity); }
    memberIds.add(member.id); if (member.email) emails.add(emailHash(member.email));
  }
  for (const member of members.filter(item => item.status === "invited")) {
    const identity = member.workosId ? `workos:${member.workosId}` : `member:${member.id}`, hash = member.email ? emailHash(member.email) : undefined;
    if (!identities.has(identity) && (!hash || !emails.has(hash))) used++;
    identities.add(identity); memberIds.add(member.id); if (hash) emails.add(hash);
  }
  for (const seat of reservations.filter(item => item.phase !== "released")) {
    if (emails.has(seat.emailHash) || (seat.memberId && memberIds.has(seat.memberId)) || (seat.workosId && identities.has(`workos:${seat.workosId}`))) continue;
    used++; reserved++; emails.add(seat.emailHash);
    if (seat.workosId) identities.add(`workos:${seat.workosId}`);
    if (seat.memberId) memberIds.add(seat.memberId);
  }
  return { members: used, reservedMembers: reserved };
}

function entitlementSnapshot(policy: BillingEntitlementPolicy, members: SeatMember[], leads: number, reservations: SeatReservation[] = []): BillingEntitlementSnapshot {
  return { ...policy, usage: { ...billingSeatUsage(members, reservations), leads }, enforcement: { members: "team_invite_reactivate", leads: "workspace_create_import" }, checkedAt: isoNow() };
}
export async function readBillingEntitlements(workspace: Workspace): Promise<BillingEntitlementSnapshot> {
  if (workspace.demo || !productionDatabase()) return entitlementSnapshot(billingEntitlementPolicy(workspace), workspace.members || [], workspace.leads.length);
  return tenantTransaction(workspace.id, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspace.id)).for("share");
    assert(organization, "Institute not found.", 404);
    const members = await tx.select().from(memberTable).where(eq(memberTable.organizationId, workspace.id));
    const [leads] = await tx.select({ value: count() }).from(leadTable).where(eq(leadTable.organizationId, workspace.id));
    const reservations = await seatRows(tx, workspace.id);
    return entitlementSnapshot(billingEntitlementPolicy(organization), members as SeatMember[], Number(leads.value), reservations.map(row => row.reservation));
  });
}

/** The capacity check and reservation share the same tenant row lock as workspace writes. No email has been sent yet. */
export async function reserveBillingSeat(workspaceId: string, input: { email: string; kind: "invite" | "reactivate"; memberId?: string; workosId?: string }, fence?: AccessFence): Promise<BillingSeatClaim | null> {
  if (!productionDatabase()) return null;
  const email = z.email().parse(input.email.trim().toLowerCase()), hash = emailHash(email), id = `billing:seat:${workspaceId}:${hash}`;
  return tenantTransaction(workspaceId, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    assert(organization, "Institute not found.", 404);
    if (organization.demo) return null;
    if (fence) { assert(fence.workspaceId === workspaceId, "Invalid seat fence.", 403); await assertAccessFence(tx, fence); }
    assertWorkspaceCapability(await readSubscriptionState(tx, organization));
    const members = await tx.select().from(memberTable).where(eq(memberTable.organizationId, workspaceId));
    if (input.kind === "reactivate") assert(members.some(member => member.id === input.memberId && member.workosId === input.workosId && member.email.toLowerCase() === email), "The seat does not belong to this institute membership.", 403);
    const rows = await seatRows(tx, workspaceId), previous = rows.find(row => row.id === id)?.reservation;
    if (previous && previous.phase !== "released") return { workspaceId, id, requestId: previous.requestId, owned: false };
    const represented = members.some(member => ["active", "invited"].includes(member.status) && (member.email.toLowerCase() === email || Boolean(input.workosId && member.workosId === input.workosId)));
    if (!represented) {
      const policy = billingEntitlementPolicy(organization), usage = billingSeatUsage(members as SeatMember[], rows.map(row => row.reservation));
      assert(policy.limits, policy.message, 503);
      if (policy.limits.members !== null && usage.members + 1 > policy.limits.members) throw new AppError(`The member limit is ${policy.limits.members}; ${usage.members} seats are already active, invited or reserved. No invitation or reactivation was sent.`, 409);
    }
    const reservation: SeatReservation = { version: 1, requestId: uid(), emailHash: hash, kind: input.kind, phase: "reserved", changedAt: Date.now(), ...(input.memberId ? { memberId: input.memberId } : {}), ...(input.workosId ? { workosId: input.workosId } : {}) };
    await tx.insert(eventReceipts).values({ id, organizationId: workspaceId, provider: "billing_seat", receivedAt: isoNow(), payload: { ...reservation } }).onConflictDoUpdate({ target: eventReceipts.id, set: { payload: { ...reservation }, processedAt: null, error: null }, setWhere: eq(eventReceipts.organizationId, workspaceId) });
    return { workspaceId, id, requestId: reservation.requestId, owned: true };
  });
}

export async function confirmBillingSeat(claim: BillingSeatClaim | null, providerRef: string, workosId?: string, fence?: AccessFence) {
  if (!claim) return;
  await tenantTransaction(claim.workspaceId, async tx => {
    await lockedOrganization(tx, claim.workspaceId);
    if (fence) { assert(fence.workspaceId === claim.workspaceId, "Invalid seat fence.", 403); await assertAccessFence(tx, fence); }
    const row = (await seatRows(tx, claim.workspaceId)).find(item => item.id === claim.id);
    assert(row?.reservation.requestId === claim.requestId && row.reservation.phase !== "released", "The seat reservation changed. Refresh the team to reconcile it.", 409);
    await tx.update(eventReceipts).set({ payload: { ...row.reservation, phase: "confirmed", providerRef, ...(workosId ? { workosId } : {}), changedAt: Date.now() }, processedAt: isoNow(), error: null }).where(and(eq(eventReceipts.id, claim.id), eq(eventReceipts.organizationId, claim.workspaceId)));
  });
}
export async function failBillingSeat(claim: BillingSeatClaim | null, error: unknown, beforeDispatch = false, fence?: AccessFence) {
  if (!claim?.owned) return;
  const definitive = beforeDispatch || [400, 401, 403, 404, 422].includes(Number((error as { status?: unknown } | null)?.status));
  try {
    await tenantTransaction(claim.workspaceId, async tx => {
      await lockedOrganization(tx, claim.workspaceId);
      if (fence) { assert(fence.workspaceId === claim.workspaceId, "Invalid seat fence.", 403); await assertAccessFence(tx, fence); }
      const row = (await seatRows(tx, claim.workspaceId)).find(item => item.id === claim.id);
      if (row?.reservation.requestId === claim.requestId && row.reservation.phase === "reserved") await tx.update(eventReceipts).set({ payload: { ...row.reservation, phase: definitive ? "released" : "uncertain", changedAt: Date.now() }, processedAt: definitive ? isoNow() : null, error: definitive ? null : "Seat dispatch is uncertain. Capacity remains reserved until WorkOS confirmation." }).where(and(eq(eventReceipts.id, claim.id), eq(eventReceipts.organizationId, claim.workspaceId)));
    });
  } catch { /* The durable reservation remains occupied during an outage; it never fails open. */ }
}

/** Only positive, newer WorkOS evidence releases a confirmed reservation. Missing/stale projections cannot free in-flight seats. */
export async function reconcileBillingSeats(workspaceId: string, organizationId: string, evidence: BillingSeatEvidence, fence?: AccessFence) {
  if (!productionDatabase()) return;
  await tenantTransaction(workspaceId, async tx => {
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    assert(organization, "Institute not found.", 404);
    if (organization.demo) return;
    assert(organization.workosId === organizationId, "Seat evidence belongs to another institute.", 403);
    if (fence) { assert(fence.workspaceId === workspaceId && fence.organizationId === organizationId, "Invalid seat fence.", 403); await assertAccessFence(tx, fence); }
    const rows = await seatRows(tx, workspaceId);
    for (const row of rows) {
      const seat = row.reservation;
      if (fence && ["reserved", "uncertain"].includes(seat.phase) && seat.changedAt < evidence.observedAt) {
        const invitation = seat.kind === "invite" ? evidence.invitations.find(item => item.organizationId === organizationId && emailHash(item.email) === seat.emailHash && ["pending", "accepted"].includes(item.state)) : undefined;
        const membership = seat.kind === "reactivate" ? evidence.memberships.find(item => item.organizationId === organizationId && item.userId === seat.workosId && item.status === "active") : undefined;
        const providerRef = invitation?.id || membership?.id, workosId = invitation?.acceptedUserId || membership?.userId || seat.workosId;
        if (providerRef) {
          await tx.update(eventReceipts).set({ payload: { ...seat, phase: "confirmed", providerRef, ...(workosId ? { workosId } : {}), changedAt: Date.now() }, processedAt: isoNow(), error: null }).where(and(eq(eventReceipts.id, row.id), eq(eventReceipts.organizationId, workspaceId)));
          continue;
        }
      }
      if (seat.phase !== "confirmed" || !seat.providerRef || seat.changedAt >= evidence.observedAt) continue;
      const invitation = seat.kind === "invite" ? evidence.invitations.find(item => item.organizationId === organizationId && item.id === seat.providerRef) : undefined;
      const workosId = invitation?.acceptedUserId || seat.workosId;
      const membership = evidence.memberships.find(item => item.organizationId === organizationId && (seat.kind === "reactivate" ? item.id === seat.providerRef && item.userId === seat.workosId : Boolean(workosId && item.userId === workosId)));
      const released = Boolean(invitation && ["expired", "revoked"].includes(invitation.state) || membership?.status === "inactive");
      if (!released && workosId === seat.workosId) continue;
      await tx.update(eventReceipts).set({ payload: { ...seat, ...(workosId ? { workosId } : {}), phase: released ? "released" : "confirmed", changedAt: Date.now() }, error: null, processedAt: isoNow() }).where(and(eq(eventReceipts.id, row.id), eq(eventReceipts.organizationId, workspaceId)));
    }
  });
}

const invoiceTime = z.number().int().nonnegative().max(253402300799).nullable().optional();
const invoiceSchema = z.object({
  id: z.string().regex(/^inv_[A-Za-z0-9]+$/), entity: z.literal("invoice"), subscription_id: z.string().regex(/^sub_[A-Za-z0-9]+$/),
  invoice_number: z.string().max(100).nullable().optional(), customer_id: z.string().nullable().optional(),
  status: z.enum(["draft", "issued", "partially_paid", "paid", "expired", "cancelled", "deleted"]),
  amount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), amount_paid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), amount_due: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[A-Z]{3}$/),
  created_at: z.number().int().nonnegative().max(253402300799), issued_at: invoiceTime, paid_at: invoiceTime, date: invoiceTime, expire_by: invoiceTime,
  short_url: z.string().max(4000).nullable().optional(),
});
export interface BillingInvoice {
  id: string; number: string | null; status: z.infer<typeof invoiceSchema>["status"];
  total: number; paid: number; due: number; currency: string;
  createdAt: string; issuedAt: string | null; paidAt: string | null; expiresAt: string | null; hostedUrl: string | null;
}
export interface BillingInvoicePage {
  mode: "demo" | "setup" | "test" | "live"; state: "ready" | "empty" | "no_subscription" | "demo" | "setup";
  invoices: BillingInvoice[]; page: number; pageSize: number; hasMore: boolean; message: string;
}
const invoiceDate = (seconds: number | null | undefined) => typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;
export function projectBillingInvoice(raw: unknown, subscription: BillingSubscription): BillingInvoice {
  const parsed = invoiceSchema.safeParse(raw);
  assert(parsed.success, "Razorpay returned an invalid invoice response.", 502);
  const invoice = parsed.data;
  assert(invoice.subscription_id === subscription.id && (!subscription.customer_id || invoice.customer_id === subscription.customer_id), "The provider invoice does not match this institute's verified subscription.", 502);
  return { id: invoice.id, number: invoice.invoice_number || null, status: invoice.status, total: invoice.amount, paid: invoice.amount_paid, due: invoice.amount_due, currency: invoice.currency, createdAt: invoiceDate(invoice.created_at)!, issuedAt: invoiceDate(invoice.issued_at ?? invoice.date), paidAt: invoiceDate(invoice.paid_at), expiresAt: invoiceDate(invoice.expire_by), hostedUrl: billingCheckoutUrl(invoice.short_url) || null };
}

/** Read-only provider access. Neither a subscription ID nor an invoice ID is accepted from the browser. */
export async function listBillingInvoices(workspace: Workspace, page = 1): Promise<BillingInvoicePage> {
  assert(Number.isSafeInteger(page) && page >= 1 && page <= 10000, "Choose a valid invoice page.", 400);
  const base = { invoices: [] as BillingInvoice[], page, pageSize: 10, hasMore: false };
  if (workspace.demo) return { ...base, mode: "demo", state: "demo", message: "Demo workspaces do not have billing invoices." };
  if (!productionDatabase()) return { ...base, mode: "setup", state: "setup", message: "Hosted invoice access is unavailable in local preview accounts." };
  let config: ReturnType<typeof keys>;
  try { config = keys(); } catch { return { ...base, mode: "setup", state: "setup", message: "Configure the platform Razorpay billing keys to access subscription invoices." }; }
  return tenantTransaction(workspace.id, async tx => {
    // Hold a shared tenant lock while reading the provider, so cancellation/replacement cannot swap the binding mid-list.
    const [organization] = await tx.select().from(organizations).where(eq(organizations.id, workspace.id)).for("share");
    assert(organization && !organization.demo, "Invoice access is unavailable for this institute.", 409);
    const mode = config.keyId.startsWith("rzp_test_") ? "test" as const : "live" as const;
    const id = organization.subscription.providerId;
    if (!id) return { ...base, mode, state: "no_subscription" as const, message: "No verified provider subscription is linked. Invoices appear after Razorpay issues them." };
    const subscription = await fetchSubscription(id);
    assertBillingTenant(subscription, workspace.id);
    const query = new URLSearchParams({ subscription_id: id, count: String(base.pageSize + 1), skip: String((page - 1) * base.pageSize) });
    const result = z.object({ items: z.array(z.unknown()).max(base.pageSize + 1) }).safeParse(await billingRequest(`invoices?${query}`));
    assert(result.success, "Razorpay returned an invalid invoice list.", 502);
    // Validate the entire provider page, including the look-ahead row, before exposing any invoice or hosted URL.
    const verified = result.data.items.map(item => projectBillingInvoice(item, subscription));
    assert(new Set(verified.map(invoice => invoice.id)).size === verified.length, "Razorpay returned a duplicate invoice page. Retry the list.", 502);
    return { ...base, mode, state: verified.length ? "ready" as const : "empty" as const, invoices: verified.slice(0, base.pageSize), hasMore: verified.length > base.pageSize, message: verified.length ? "Invoices for the currently linked AdmitFlow subscription. Amounts are provider-confirmed currency subunits." : "No invoices are available on this page for the current subscription." };
  });
}

export async function billingOverview(workspace: Workspace): Promise<BillingOverview> {
  syncOverviewConfiguration();
  const subscription = workspace.subscription || { status: "trial" as const, plan: "Pilot" };
  if (workspace.demo) return { mode: "demo", subscription, plans: [], canCancel: false, entitlements: await readBillingEntitlements(workspace), message: "Demo workspace · no subscription is purchased and no payment is collected." };
  let config: ReturnType<typeof billingSetup>;
  try { config = billingSetup(); }
  catch (error) {
    // A missing plan catalog must not prevent cancellation of an existing, verified subscription.
    const latest = subscription.providerId && productionDatabase() && process.env.BILLING_RAZORPAY_KEY_ID && process.env.BILLING_RAZORPAY_KEY_SECRET ? await refreshSubscription(workspace.id, subscription.providerId) : undefined;
    return { mode: "setup", subscription: latest?.subscription || subscription, plans: [], providerStatus: latest?.entity.status, canCancel: Boolean(latest && !terminal(latest.entity.status)), entitlements: await readBillingEntitlements(workspace), message: error instanceof AppError ? error.message : "Platform billing setup is incomplete." };
  }
  const options = await Promise.all(config.plans.map(overviewPlanOption));
  const latest = subscription.providerId ? await refreshSubscription(workspace.id, subscription.providerId) : undefined;
  const entity = latest?.entity;
  return { mode: config.keyId.startsWith("rzp_test_") ? "test" : "live", subscription: latest?.subscription || subscription, plans: options, providerStatus: entity?.status, checkoutUrl: entity && ["created", "authenticated"].includes(entity.status) ? billingCheckoutUrl(entity.short_url) : undefined, canCancel: Boolean(entity && !terminal(entity.status)), entitlements: await readBillingEntitlements(workspace), message: config.keyId.startsWith("rzp_test_") ? "Razorpay test mode. Test subscriptions do not collect a live payment." : "Your AdmitFlow subscription is billed separately from student fees collected by your institute." };
}

async function recoverCheckout(workspaceId: string, operation: CheckoutOperation) {
  if (operation.providerId) return finalizeCheckout(workspaceId, operation, await fetchSubscription(operation.providerId));
  assert(Date.now() - operation.startedAt >= 30_000, "Checkout is still being created. Wait a moment, then retry.", 409);
  // Razorpay Subscriptions has no documented create-idempotency key. Never POST again after an uncertain result.
  // Look for the durable operation marker before considering the checkout complete.
  for (let skip = 0; skip < 500; skip += 100) {
    const page = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).parse(await billingRequest(`subscriptions?count=100&skip=${skip}`));
    const matching = page.items.filter(item => {
      const notes = item.notes as Record<string, unknown> | undefined;
      return notes?.admitflow_product === PRODUCT && notes.admitflow_workspace_id === workspaceId && notes.admitflow_checkout_id === operation.requestId;
    });
    assert(matching.length <= 1, "More than one provider subscription matches this checkout. Reconcile it in Razorpay before continuing.", 409);
    if (matching[0]) return finalizeCheckout(workspaceId, operation, await fetchSubscription(String(matching[0].id)));
    if (page.items.length < 100) break;
  }
  throw new AppError("The previous checkout has an uncertain provider result. Review its operation reference in the billing records; a duplicate subscription has not been created.", 409);
}

export async function createBillingCheckout(workspaceId: string, planId: string, requestId: string) {
  const config = billingSetup(), plan = config.plans.find(item => item.id === planId);
  assert(plan, "Choose one of the configured AdmitFlow subscription plans.", 400);
  z.uuid().parse(requestId);
  await planOption(plan); // Validate the server-selected provider plan and amount before creating anything.
  const claim = await tenantTransaction(workspaceId, async tx => {
    const organization = await lockedOrganization(tx, workspaceId);
    if (organization.subscription.providerId && organization.subscription.status !== "cancelled") return { existing: organization.subscription.providerId };
    const [pastRequest] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, requestReceiptId(workspaceId, requestId)), eq(eventReceipts.organizationId, workspaceId)));
    assert(!pastRequest?.processedAt || pastRequest.payload.phase === "failed", "This checkout request was already completed. Refresh billing before starting a new subscription.", 409);
    const previous = await checkoutOperation(tx, workspaceId);
    if (previous && ["creating", "uncertain"].includes(previous.phase)) {
      assert(previous.planId === planId, "Reconcile the previous plan's checkout before choosing another subscription.", 409);
      return { pending: previous };
    }
    const operation: CheckoutOperation = { requestId, planId: plan.id, providerPlanId: plan.razorpayPlanId, planName: plan.name, totalCount: plan.totalCount, startedAt: Date.now(), phase: "creating" };
    await saveOperation(tx, workspaceId, operation);
    return { operation };
  });
  if (claim.existing) {
    const latest = await refreshSubscription(workspaceId, claim.existing);
    assert(latest.entity.plan_id === plan.razorpayPlanId && ["created", "authenticated"].includes(latest.entity.status), "This institute already has a subscription. Manage it before starting another plan.", 409);
    return { subscription: latest.subscription, providerStatus: latest.entity.status, checkoutUrl: billingCheckoutUrl(latest.entity.short_url) };
  }
  if (claim.pending) return recoverCheckout(workspaceId, claim.pending);
  const operation = claim.operation!;
  let entity: BillingSubscription | undefined;
  try {
    const parsed = subscriptionSchema.safeParse(await billingRequest("subscriptions", { plan_id: operation.providerPlanId, total_count: operation.totalCount, quantity: 1, customer_notify: true, expire_by: Math.floor(Date.now() / 1000) + 86400, notes: { admitflow_product: PRODUCT, admitflow_workspace_id: workspaceId, admitflow_checkout_id: requestId } }));
    assert(parsed.success, "The subscription response was incomplete. Refresh billing to reconcile before trying again.", 502);
    entity = parsed.data;
    assertBillingTenant(entity, workspaceId);
    assert(matchesOperation(operation, entity), "The provider subscription did not match the requested plan.", 502);
    return await finalizeCheckout(workspaceId, operation, entity);
  } catch (error) {
    try {
      await tenantTransaction(workspaceId, async tx => {
        await lockedOrganization(tx, workspaceId);
        const latest = await checkoutOperation(tx, workspaceId);
        if (latest?.requestId === requestId && latest.phase === "creating") await saveOperation(tx, workspaceId, { ...latest, phase: error instanceof BillingProviderError && error.definitive ? "failed" : "uncertain", ...(entity?.id ? { providerId: entity.id } : {}) }, "Subscription creation did not complete. Reconcile the provider result before another create.");
      });
    } catch { /* Keep the original error. A durable creating marker still prevents another provider POST. */ }
    throw error;
  }
}

export async function cancelBillingSubscription(workspaceId: string) {
  assert(productionDatabase(), "Hosted subscription billing requires the production database.", 503);
  keys();
  return tenantTransaction(workspaceId, async tx => {
    const organization = await lockedOrganization(tx, workspaceId), id = organization.subscription.providerId;
    assert(id, "There is no provider subscription to cancel.", 409);
    let entity = await fetchSubscription(id);
    assertBillingTenant(entity, workspaceId);
    if (!terminal(entity.status)) {
      const result = subscriptionSchema.safeParse(await billingRequest(`subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: false }));
      assert(result.success && result.data.id === id, "Cancellation is awaiting provider confirmation. Refresh billing before retrying.", 502);
      entity = result.data;
      assert(terminal(entity.status), "Razorpay has not confirmed immediate cancellation. Refresh billing to check its status.", 502);
    }
    const subscription = await persistSubscription(tx, organization, entity, configuredPlanName(entity, organization.subscription.plan));
    await tx.insert(eventReceipts).values({ id: `billing:cancel:${id}`, organizationId: workspaceId, provider: "billing_cancel", receivedAt: isoNow(), processedAt: isoNow(), payload: { subscriptionId: id, immediate: true } }).onConflictDoNothing();
    return { subscription, providerStatus: entity.status, message: "Recurring subscription billing has ended. Existing payments were not refunded." };
  });
}

const webhookSchema = z.object({ event: z.string().max(120), account_id: z.string().optional(), payload: z.object({ subscription: z.object({ entity: z.object({ id: z.string().regex(/^sub_[A-Za-z0-9]+$/) }) }).optional() }) });
const subscriptionEvents = new Set(["subscription.authenticated", "subscription.activated", "subscription.charged", "subscription.pending", "subscription.halted", "subscription.cancelled", "subscription.completed", "subscription.paused", "subscription.resumed", "subscription.updated"]);

export async function processBillingWebhook(raw: unknown, eventId: string) {
  const event = webhookSchema.parse(raw);
  if (!subscriptionEvents.has(event.event)) return { ignored: true };
  if (process.env.BILLING_RAZORPAY_ACCOUNT_ID) assert(event.account_id === process.env.BILLING_RAZORPAY_ACCOUNT_ID, "Unexpected billing account.", 403);
  assert(productionDatabase(), "Platform billing webhook routing is not configured.", 503);
  const id = event.payload.subscription?.entity.id;
  assert(id, "Subscription event is missing its subscription reference.", 400);
  const receiptId = `billing:event:${eventId}`;
  const [route] = await database().select().from(connectionRoutes).where(and(eq(connectionRoutes.service, "billing"), eq(connectionRoutes.externalId, id)));
  let workspaceId = route?.organizationId;
  if (!workspaceId) {
    // A callback can beat the create response. Only the server's persisted checkout marker may bootstrap a route.
    const entity = await fetchSubscription(id), candidate = z.uuid().safeParse(entity.notes.admitflow_workspace_id);
    if (entity.notes.admitflow_product !== PRODUCT || !candidate.success) return { ignored: true };
    const [organization] = await database().select().from(organizationRoutes).where(eq(organizationRoutes.organizationId, candidate.data));
    if (!organization) return { ignored: true };
    workspaceId = organization.organizationId;
  }
  try {
    return await tenantTransaction(workspaceId, async tx => {
      const organization = await lockedOrganization(tx, workspaceId);
      const [previousReceipt] = await tx.select().from(eventReceipts).where(eq(eventReceipts.id, receiptId));
      if (previousReceipt?.processedAt) return { duplicate: true };
      assert(!previousReceipt || previousReceipt.organizationId === workspaceId, "Billing event routing does not match the original receipt.", 409);
      await tx.insert(eventReceipts).values({ id: receiptId, organizationId: workspaceId, provider: "billing", receivedAt: isoNow(), payload: { event: event.event, subscriptionId: id } }).onConflictDoNothing();
      const entity = await fetchSubscription(id);
      assertBillingTenant(entity, workspaceId);
      const operation = await checkoutOperation(tx, workspaceId);
      const matches = matchesOperation(operation, entity);
      const ownsCurrent = organization.subscription.providerId === id;
      if (!ownsCurrent && !(matches && (!organization.subscription.providerId || organization.subscription.status === "cancelled"))) {
        await tx.update(eventReceipts).set({ processedAt: isoNow(), error: null, payload: { event: event.event, subscriptionId: id, ignored: "Not the current or pending subscription" } }).where(eq(eventReceipts.id, receiptId));
        return { ignored: true };
      }
      const subscription = await persistSubscription(tx, organization, entity, matches ? operation!.planName : configuredPlanName(entity, organization.subscription.plan), matches);
      if (matches) await saveOperation(tx, workspaceId, { ...operation!, phase: "ready", providerId: id });
      await tx.update(eventReceipts).set({ processedAt: isoNow(), error: null }).where(eq(eventReceipts.id, receiptId));
      return { received: true, status: subscription.status };
    });
  } catch (error) {
    // Retain failed deliveries for operations visibility; an unprocessed receipt never suppresses a retry.
    try { await tenantTransaction(workspaceId, tx => tx.insert(eventReceipts).values({ id: receiptId, organizationId: workspaceId, provider: "billing", receivedAt: isoNow(), payload: { event: event.event, subscriptionId: id }, error: "Subscription reconciliation failed. Retry webhook delivery." }).onConflictDoUpdate({ target: eventReceipts.id, set: { error: "Subscription reconciliation failed. Retry webhook delivery." }, setWhere: and(eq(eventReceipts.organizationId, workspaceId), isNull(eventReceipts.processedAt)) })); } catch { /* Database recovery will be retried by the webhook sender. */ }
    throw error;
  }
}
