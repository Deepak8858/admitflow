import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mutatePostgresWorkspace, tenantTransaction } from "./repository";
import { eventReceipts, organizations, members } from "./schema";
import { isoNow, uid, type Workspace } from "../domain";
import { assert } from "../errors";
import { assertActor } from "../permissions";
import type { MemberSnapshot } from "../../app/api/team/members";

type Transaction = Parameters<Parameters<typeof tenantTransaction>[1]>[0];
const role = z.enum(["owner", "admin", "counsellor", "analyst"]);
const expectation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("membership"), id: z.string(), userId: z.string(), role, status: z.enum(["active", "inactive", "pending"]) }),
  z.object({ kind: z.literal("revoke"), id: z.string() }),
  z.object({ kind: z.literal("invite"), email: z.string(), role, previousIds: z.array(z.string()) }),
]);
export type AccessExpectation = z.infer<typeof expectation>;
const receiptSchema = z.object({ token: z.string(), phase: z.enum(["idle", "prepared", "dispatched"]), startedAt: z.number(), expected: expectation.optional() });
type Receipt = z.infer<typeof receiptSchema>;
export type AccessFence = Receipt & { workspaceId: string; organizationId: string };
export const ACCESS_LEASE_MS = 120_000;
const receiptId = (id: string) => `team:access:${id}`;
const busy = "Team access is being updated or awaiting WorkOS confirmation. Refresh the team before retrying.";

async function read(tx: Transaction, workspaceId: string): Promise<Receipt> {
  const [row] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, receiptId(workspaceId)), eq(eventReceipts.organizationId, workspaceId)));
  if (!row) return { token: "initial", phase: "idle", startedAt: 0 };
  const parsed = receiptSchema.safeParse(row.payload);
  assert(row.provider === "workos_access" && parsed.success, "Team access state requires operator review.", 503);
  return parsed.data;
}
async function write(tx: Transaction, workspaceId: string, value: Receipt) {
  await tx.insert(eventReceipts).values({ id: receiptId(workspaceId), organizationId: workspaceId, provider: "workos_access", receivedAt: isoNow(), payload: value })
    .onConflictDoUpdate({ target: eventReceipts.id, set: { payload: value, processedAt: value.phase === "idle" ? isoNow() : null, error: null }, setWhere: eq(eventReceipts.organizationId, workspaceId) });
}
async function lock(tx: Transaction, workspaceId: string, organizationId: string) {
  const [org] = await tx.select({ workosId: organizations.workosId }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
  assert(org?.workosId === organizationId, "Access evidence belongs to another institute.", 403);
}
/** Call only while holding the organization row lock, including inside a projection transaction. */
export async function assertAccessFence(tx: Transaction, fence: AccessFence, allowExpired = false) {
  const value = await read(tx, fence.workspaceId);
  assert(value.token === fence.token && value.phase === fence.phase, "Team access changed while this request was running. Refresh and retry.", 409);
  assert(allowExpired || value.phase !== "prepared" || Date.now() - value.startedAt < ACCESS_LEASE_MS, busy, 409);
  return value;
}
export function readAccessFence(workspaceId: string, organizationId: string): Promise<AccessFence> {
  return tenantTransaction(workspaceId, async tx => {
    await lock(tx, workspaceId, organizationId);
    return { ...await read(tx, workspaceId), workspaceId, organizationId };
  });
}
export function claimAccess(workspaceId: string, organizationId: string): Promise<AccessFence> {
  return tenantTransaction(workspaceId, async tx => {
    await lock(tx, workspaceId, organizationId);
    const previous = await read(tx, workspaceId);
    assert(previous.phase === "idle" || (previous.phase === "prepared" && Date.now() - previous.startedAt >= ACCESS_LEASE_MS), busy, 409);
    const value: Receipt = { token: uid(), phase: "prepared", startedAt: Date.now() };
    await write(tx, workspaceId, value);
    return { ...value, workspaceId, organizationId };
  });
}
/** Record intent before any external write. Dispatched operations never expire into another dispatch. */
export async function dispatchAccess(fence: AccessFence, expected: AccessExpectation): Promise<AccessFence> {
  return tenantTransaction(fence.workspaceId, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    await assertAccessFence(tx, fence);
    assert(fence.phase === "prepared", busy, 409);
    const value: Receipt = { token: fence.token, phase: "dispatched", startedAt: Date.now(), expected: expectation.parse(expected) };
    await write(tx, fence.workspaceId, value);
    return { ...value, workspaceId: fence.workspaceId, organizationId: fence.organizationId };
  });
}
export function accessPostcondition(fence: AccessFence, state: MemberSnapshot) {
  const expected = fence.expected;
  if (!expected) return false;
  if (expected.kind === "membership") return state.memberships.some(member => member.organizationId === fence.organizationId && member.id === expected.id && member.userId === expected.userId && member.status === expected.status && member.role.slug === expected.role);
  if (expected.kind === "revoke") return state.invitations.some(item => item.organizationId === fence.organizationId && item.id === expected.id && item.state === "revoked");
  return state.invitations.some(item => item.organizationId === fence.organizationId && item.email.toLowerCase() === expected.email && item.roleSlug === expected.role && !expected.previousIds.includes(item.id) && ["pending", "accepted"].includes(item.state));
}
/** Fresh reads may confirm a lost response, never infer failure from missing/unchanged provider state. */
export async function confirmAccess(fence: AccessFence, state: MemberSnapshot): Promise<AccessFence> {
  assert(fence.phase === "dispatched" && accessPostcondition(fence, state), busy, 409);
  return tenantTransaction(fence.workspaceId, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    await assertAccessFence(tx, fence);
    const value: Receipt = { token: uid(), phase: "prepared", startedAt: Date.now() };
    await write(tx, fence.workspaceId, value);
    return { ...value, workspaceId: fence.workspaceId, organizationId: fence.organizationId };
  });
}
/** Only a request that knows it did not dispatch may abandon a dispatched intent. */
export async function releaseAccess(fence: AccessFence, beforeDispatch = false) {
  await tenantTransaction(fence.workspaceId, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    const current = await read(tx, fence.workspaceId);
    if (current.token !== fence.token || current.phase !== fence.phase) return;
    if (current.phase === "dispatched" && !beforeDispatch) return;
    await write(tx, fence.workspaceId, { token: uid(), phase: "idle", startedAt: Date.now() });
  });
}
export function mutateAccessWorkspace<T>(fence: AccessFence, action: (workspace: Workspace) => T) {
  return mutatePostgresWorkspace(fence.workspaceId, action, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    await assertAccessFence(tx, fence);
  });
}

/** Capture the fence BEFORE the provider read. Busy operations permit validation, never projection. */
export async function projectAccessIdentity(fence: AccessFence, actor: NonNullable<Workspace["actor"]>, membershipId: string) {
  const unchanged = await tenantTransaction(fence.workspaceId, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    await assertAccessFence(tx, fence, true);
    assert(fence.phase !== "dispatched" || fence.expected?.kind !== "membership" || fence.expected.userId !== actor.id, "Your institute membership is awaiting WorkOS confirmation. Ask another administrator to refresh the team.", 409);
    const rows = await tx.select().from(members).where(and(eq(members.organizationId, fence.workspaceId), eq(members.workosId, actor.id)));
    const member = rows[0];
    actor.memberId = member?.id || membershipId;
    const matches = member?.status === "active" && member.role === actor.role && member.name === actor.name && member.email === actor.email;
    assert(matches || fence.phase === "idle", "Your institute membership is changing. Refresh the team before retrying.", 409);
    return matches;
  });
  if (unchanged) return;
  await mutatePostgresWorkspace(fence.workspaceId, workspace => {
    const member = workspace.members!.find(item => item.workosId === actor.id);
    actor.memberId = member?.id || membershipId;
    if (fence.phase !== "idle") { assertActor(workspace, actor); return; }
    const values = { id: actor.memberId, name: actor.name, email: actor.email, role: actor.role, status: "active" as const, workosId: actor.id };
    if (member) Object.assign(member, values); else workspace.members!.push(values);
    for (const record of [...workspace.leads, ...workspace.tasks!, ...workspace.appointments]) if (record.ownerId === values.id) record.owner = actor.name;
    workspace.team = [...new Set(workspace.members!.filter(item => item.status === "active").map(item => item.name))];
  }, async tx => {
    await lock(tx, fence.workspaceId, fence.organizationId);
    await assertAccessFence(tx, fence);
    if (fence.phase === "idle") await write(tx, fence.workspaceId, { token: uid(), phase: "idle", startedAt: Date.now() });
  });
}
