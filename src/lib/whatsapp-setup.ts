import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { type SessionContext, requireAdmin } from "./auth";
import { productionDatabase } from "./config";
import { assertIntakeConnectionIdentity, validateConnectionCredentials } from "./connections";
import { isoNow, uid, type Connection, type Workspace } from "./domain";
import { assert } from "./errors";
import { assertActor } from "./permissions";
import { sealSecret } from "./secrets";
import { graph } from "./providers/meta";
import { mutatePostgresWorkspace, tenantTransaction } from "./db/repository";
import { assertAccessFence, readAccessFence } from "./db/team-access";
import { connectionRoutes, organizations } from "./db/schema";
import { whatsappSubscriptionOperations as operations } from "./db/whatsapp-schema";

type Transaction = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
type Operation = typeof operations.$inferSelect;
type RefreshAdmin = () => Promise<SessionContext>;
export interface WhatsAppSetupInput { phoneNumberId: string; wabaId: string; accessToken: string; coexistence?: boolean }
const pendingMessage = "Subscription outcome needs reconciliation. Supply fresh credentials to check Meta; an uncertain subscription write is never repeated.";
const metaId = z.string().regex(/^\d{1,80}$/);
const subscriptionPage = z.object({ data: z.array(z.object({ whatsapp_business_api_data: z.object({ id: metaId }) })).max(1000), paging: z.object({ next: z.string().optional() }).optional() });

function hosted(snapshot: Workspace, context: SessionContext) {
  assert(productionDatabase() && context.actor.backend === "workos" && snapshot.workosOrganizationId, "Live WhatsApp setup requires hosted PostgreSQL and WorkOS.", 503);
  assert(!snapshot.demo && snapshot.id === context.workspaceId, "Live WhatsApp setup requires this institute's workspace.", 409);
  requireAdmin(context); assertActor(snapshot, context.actor);
}
async function freshAdmin(snapshot: Workspace, context: SessionContext, refresh: RefreshAdmin) {
  // Capture before the fresh external membership read. A concurrent team mutation
  // invalidates the evidence rather than allowing stale membership projection.
  const fence = await readAccessFence(snapshot.id, snapshot.workosOrganizationId!);
  assert(fence.phase === "idle", "Refresh team access before configuring WhatsApp.", 409);
  const fresh = await refresh();
  assert(fresh.workspaceId === snapshot.id && fresh.actor.id === context.actor.id && fresh.actor.backend === "workos", "Your institute session changed. Restart setup.", 403);
  requireAdmin(fresh);
  return { fence, actor: fresh.actor };
}
async function verify(input: WhatsAppSetupInput) {
  validateConnectionCredentials("whatsapp", { accessToken: input.accessToken }, input.phoneNumberId, { wabaId: input.wabaId });
  const appId = process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID;
  assert(appId && /^\d{1,80}$/.test(appId) && process.env.META_APP_SECRET, "Configure the Meta application before connecting WhatsApp.", 503);
  assert(!process.env.NEXT_PUBLIC_META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID === appId, "The public and server Meta app identities must match.", 503);
  const debug = await graph<{ data?: { is_valid?: boolean; app_id?: string; scopes?: string[] } }>(`debug_token?input_token=${encodeURIComponent(input.accessToken)}`, `${appId}|${process.env.META_APP_SECRET}`);
  assert(debug.data?.is_valid === true && debug.data.app_id === appId, "Use a valid WhatsApp token issued by this Meta application.", 422);
  assert(["whatsapp_business_management", "whatsapp_business_messaging"].every(scope => debug.data?.scopes?.includes(scope)), "Grant WhatsApp management and messaging permissions to this token.", 422);
  const numbers = await graph<{ data?: { id: string; display_phone_number?: string; verified_name?: string }[] }>(`${input.wabaId}/phone_numbers`, input.accessToken);
  const number = numbers.data?.find(item => item.id === input.phoneNumberId);
  assert(number, "This token cannot access that phone number in the original WhatsApp Business Account.", 422);
  return { appId, label: (number.display_phone_number || "WhatsApp Business").slice(0, 100), name: (number.verified_name || "").slice(0, 200) };
}
async function readOperation(tx: Transaction, workspaceId: string) {
  const [operation] = await tx.select().from(operations).where(eq(operations.organizationId, workspaceId));
  return operation;
}
function sameBinding(operation: Operation, connectionId: string, input: WhatsAppSetupInput, appId: string) {
  assert(operation.connectionId === connectionId && operation.externalId === input.phoneNumberId && operation.wabaId === input.wabaId && operation.appId === appId, "The original WhatsApp operation/account/application binding must be retained. Ask an operator to review configuration.", 409);
}
async function lock(tx: Transaction, workspaceId: string) {
  const [org] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
  assert(org, "Workspace not found.", 404);
}
function assertGeneration(workspace: Workspace, connectionId: string, generation: string) {
  const connection = workspace.connections?.find(item => item.id === connectionId && item.service === "whatsapp");
  assert(connection?.status === "unverified" && connection.metadata.setupGeneration === generation && connection.secret, "WhatsApp setup changed or was disconnected. Reconnect deliberately.", 409);
  return connection;
}
async function subscribed(input: WhatsAppSetupInput, appId: string) {
  // Meta's WhatsApp edge nests the app ID; a top-level id is NOT evidence.
  const parsed = subscriptionPage.safeParse(await graph(`${input.wabaId}/subscribed_apps`, input.accessToken));
  assert(parsed.success, "Meta returned an unreadable subscription state. Reconcile again with fresh credentials.", 502);
  const present = parsed.data.data.some(app => app.whatsapp_business_api_data.id === appId);
  assert(present || !parsed.data.paging?.next, "Meta returned an incomplete subscription list. Review Meta configuration; no subscription write was attempted.", 502);
  return present;
}
/** Positive evidence is stored independently of generation/readiness, including after disconnect. */
async function evidence(workspaceId: string, operationId: string, generation: string | undefined, result: "confirmed" | "present" | "absent") {
  await tenantTransaction(workspaceId, async tx => {
    await lock(tx, workspaceId);
    const operation = await readOperation(tx, workspaceId);
    assert(operation?.id === operationId, "WhatsApp subscription operation is unavailable.", 409);
    const now = isoNow();
    const update = result === "confirmed" ? { confirmedAt: operation.confirmedAt || now }
      : result === "present" ? { observedAt: operation.observedAt || now, checkedAt: now } : { checkedAt: now };
    await tx.update(operations).set({ ...update, reconciliation: result }).where(eq(operations.id, operationId));
  });
  if (result !== "absent") await mutatePostgresWorkspace(workspaceId, workspace => {
    const connection = workspace.connections?.find(item => item.service === "whatsapp");
    // A resolved deliberate disconnect goes back to ordinary ignored callbacks.
    // Never restore credentials, readiness or an in-flight newer generation.
    if (generation && connection?.status === "disconnected" && connection.metadata.subscriptionOperationId === operationId && connection.metadata.setupGeneration === generation) connection.metadata = { wabaId: connection.metadata.wabaId };
  }, async () => undefined);
}
async function status(workspaceId: string, operationId: string, generation: string, value: string) {
  await mutatePostgresWorkspace(workspaceId, workspace => {
    const connection = workspace.connections?.find(item => item.service === "whatsapp");
    if (connection?.metadata.setupGeneration === generation && connection.metadata.subscriptionOperationId === operationId && connection.status === "unverified") connection.metadata.subscriptionStatus = value;
  });
}
export async function whatsappSetupStatus(workspaceId: string) {
  return tenantTransaction(workspaceId, async tx => {
    const operation = await readOperation(tx, workspaceId);
    if (!operation) return null;
    const { id, externalId, wabaId, appId, createdAt, dispatchedAt, confirmedAt, observedAt, checkedAt, reconciliation } = operation;
    return { id, phoneNumberId: externalId, wabaId, appId, createdAt, dispatchedAt, confirmedAt, observedAt, checkedAt, reconciliation, replayAllowed: false };
  });
}

export async function setupWhatsApp(snapshot: Workspace, context: SessionContext, input: WhatsAppSetupInput, refresh: RefreshAdmin) {
  hosted(snapshot, context);
  assertIntakeConnectionIdentity(snapshot, "whatsapp", input.phoneNumberId, { wabaId: input.wabaId });
  const verified = await verify(input), encrypted = await sealSecret({ accessToken: input.accessToken }, snapshot.id);
  const authorization = await freshAdmin(snapshot, context, refresh);
  const generation = uid(), connectionId = snapshot.connections?.find(item => item.service === "whatsapp")?.id || uid();
  let operation!: Operation;
  await mutatePostgresWorkspace(snapshot.id, workspace => {
    assertActor(workspace, authorization.actor);
    // Includes absent -> absent disconnect, which still advances the aggregate revision.
    assert(workspace.revision === snapshot.revision, "The workspace changed during WhatsApp verification. Refresh and reconnect deliberately.", 409);
    assertIntakeConnectionIdentity(workspace, "whatsapp", input.phoneNumberId, { wabaId: input.wabaId });
    const current = workspace.connections?.find(item => item.service === "whatsapp");
    const coexistence = current?.metadata.coexistence === "verified" ? "verified" : input.coexistence ? "requested" : "standard";
    const connection: Connection = { id: connectionId, service: "whatsapp", externalId: input.phoneNumberId, status: "unverified", label: verified.label, secret: encrypted, updatedAt: isoNow(), metadata: {
      wabaId: input.wabaId, appId: verified.appId, name: verified.name, coexistence,
      ...(coexistence === "verified" && current?.metadata.coexistenceVerifiedAt ? { coexistenceVerifiedAt: current.metadata.coexistenceVerifiedAt } : {}),
      setupGeneration: generation, subscriptionOperationId: operation.id, subscriptionPending: "true", subscriptionStatus: "reserved", readiness: "unverified",
    } };
    if (current) Object.assign(current, connection); else (workspace.connections ||= []).push(connection);
  }, async tx => {
    await assertAccessFence(tx, authorization.fence);
    const existing = await readOperation(tx, snapshot.id);
    if (existing) { sameBinding(existing, connectionId, input, verified.appId); operation = existing; }
    else operation = { id: uid(), organizationId: snapshot.id, connectionId, service: "whatsapp", externalId: input.phoneNumberId, wabaId: input.wabaId, appId: verified.appId, generation, dispatchGeneration: null, createdAt: isoNow(), dispatchedAt: null, confirmedAt: null, observedAt: null, checkedAt: null, reconciliation: "reserved" };
  }, async tx => {
    await tx.insert(operations).values(operation).onConflictDoNothing({ target: operations.organizationId });
    // Explicit reservation also works before the aggregate routing predicate upgrade.
    const [route] = await tx.insert(connectionRoutes).values({ service: "whatsapp", externalId: input.phoneNumberId, organizationId: snapshot.id }).onConflictDoUpdate({ target: [connectionRoutes.service, connectionRoutes.externalId], set: { organizationId: snapshot.id }, setWhere: eq(connectionRoutes.organizationId, snapshot.id) }).returning();
    assert(route, "This WhatsApp account belongs to another institute.", 409);
  });
  let present: boolean;
  try { present = await subscribed(input, verified.appId); }
  catch { await status(snapshot.id, operation.id, generation, "uncertain"); return { connected: false, message: pendingMessage }; }
  await evidence(snapshot.id, operation.id, generation, present ? "present" : "absent");
  if (!present && !operation.dispatchedAt) {
    const dispatchAuthorization = await freshAdmin(snapshot, context, refresh);
    const claimed = await mutatePostgresWorkspace(snapshot.id, workspace => {
      assertActor(workspace, dispatchAuthorization.actor);
      const connection = assertGeneration(workspace, connectionId, generation);
      connection.metadata.subscriptionStatus = "uncertain";
      return true;
    }, async tx => {
      await assertAccessFence(tx, dispatchAuthorization.fence);
      const [claimed] = await tx.update(operations).set({ dispatchedAt: isoNow(), dispatchGeneration: generation, reconciliation: "uncertain" }).where(and(eq(operations.id, operation.id), eq(operations.organizationId, snapshot.id), isNull(operations.dispatchedAt))).returning();
      assert(claimed, pendingMessage, 409);
    });
    assert(claimed.result, pendingMessage, 409);
    // The committed marker is the dispatch boundary. There are no retries, even
    // for explicit errors or a process crash before the transport actually starts.
    try {
      const response = await graph<{ success?: boolean }>(`${input.wabaId}/subscribed_apps`, input.accessToken, {});
      if (response.success !== true) return { connected: false, message: pendingMessage };
    } catch { return { connected: false, message: pendingMessage }; }
    // Never combine evidence persistence with local activation: disconnect may win.
    await evidence(snapshot.id, operation.id, generation, "confirmed");
    present = true;
  }
  if (!present) {
    await status(snapshot.id, operation.id, generation, "absent");
    return { connected: false, message: pendingMessage };
  }
  const activationAuthorization = await freshAdmin(snapshot, context, refresh);
  await mutatePostgresWorkspace(snapshot.id, workspace => {
    assertActor(workspace, activationAuthorization.actor);
    const connection = assertGeneration(workspace, connectionId, generation);
    connection.status = "connected"; connection.updatedAt = isoNow();
    connection.metadata.subscriptionStatus = "active"; connection.metadata.subscriptionPending = "false";
    connection.metadata.readiness = "credentials_verified"; connection.metadata.verifiedAt = isoNow();
  }, tx => assertAccessFence(tx, activationAuthorization.fence).then(() => undefined));
  return { connected: true, message: "WhatsApp account and subscription verified. Message delivery is tracked separately." };
}

/** Read-only provider reconciliation never dispatches, stores credentials or reconnects. */
export async function reconcileWhatsApp(snapshot: Workspace, context: SessionContext, input: WhatsAppSetupInput, refresh: RefreshAdmin) {
  hosted(snapshot, context);
  const connection = snapshot.connections?.find(item => item.service === "whatsapp");
  assert(connection, "Start WhatsApp setup before reconciliation.", 409);
  assertIntakeConnectionIdentity(snapshot, "whatsapp", input.phoneNumberId, { wabaId: input.wabaId });
  const verified = await verify(input), authorization = await freshAdmin(snapshot, context, refresh);
  const operation = await tenantTransaction(snapshot.id, async tx => {
    await lock(tx, snapshot.id); await assertAccessFence(tx, authorization.fence);
    const current = await readOperation(tx, snapshot.id);
    assert(current, "No durable WhatsApp operation exists. Reconnect deliberately to verify this legacy connection.", 409);
    sameBinding(current, connection.id, input, verified.appId);
    return current;
  });
  const present = await subscribed(input, verified.appId);
  await evidence(snapshot.id, operation.id, connection.metadata.setupGeneration, present ? "present" : "absent");
  return { connected: false, present, message: present ? "Meta currently lists this app subscription. This does not prove the original write outcome. Use Verify and reconnect with fresh credentials to activate WhatsApp." : "Meta did not list this app. The original write remains non-replayable; check Meta configuration or contact support. No subscription was written." };
}
