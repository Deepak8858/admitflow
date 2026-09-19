import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { tenantTransaction } from "@/lib/db/repository";
import { eventReceipts, organizations } from "@/lib/db/schema";
import { isoNow } from "@/lib/domain";
import { assert } from "@/lib/errors";
import type { MemberSnapshot } from "./members";
import { assertAccessFence, type AccessFence } from "@/lib/db/team-access";

const receiptId = (workspaceId: string, email: string) => `team:invite:${workspaceId}:${createHash("sha256").update(email.toLowerCase()).digest("hex")}`;

/** WorkOS sendInvitation has no SDK idempotency-key option. Claim before dispatching an email. */
export async function claimInvitation(workspaceId: string, email: string, invitations: MemberSnapshot["invitations"], fence?: AccessFence) {
  return tenantTransaction(workspaceId, async tx => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    if (fence) { assert(fence.workspaceId === workspaceId, "Invalid invitation fence.", 403); await assertAccessFence(tx, fence); }
    const id = receiptId(workspaceId, email);
    const [previous] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, id), eq(eventReceipts.organizationId, workspaceId)));
    if (previous) {
      assert(!["creating", "uncertain"].includes(String(previous.payload.phase)), "The previous invitation is awaiting WorkOS confirmation. Refresh the team list before retrying; another email has not been sent.", 409);
      if (previous.payload.phase === "ready") assert(invitations.some(invitation => invitation.id === previous.payload.invitationId && ["expired", "revoked"].includes(invitation.state)), "This email already has an invitation record. Refresh the team list to reconcile its status.", 409);
    }
    await tx.insert(eventReceipts).values({ id, organizationId: workspaceId, provider: "workos_invitation", receivedAt: isoNow(), payload: { phase: "creating" } }).onConflictDoUpdate({ target: eventReceipts.id, set: { payload: { phase: "creating" }, receivedAt: isoNow(), processedAt: null, error: null }, setWhere: eq(eventReceipts.organizationId, workspaceId) });
  });
}

export async function finishInvitation(workspaceId: string, email: string, invitationId: string, fence?: AccessFence) {
  await tenantTransaction(workspaceId, async tx => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
    if (fence) { assert(fence.workspaceId === workspaceId, "Invalid invitation fence.", 403); await assertAccessFence(tx, fence); }
    await tx.insert(eventReceipts).values({ id: receiptId(workspaceId, email), organizationId: workspaceId, provider: "workos_invitation", receivedAt: isoNow(), processedAt: isoNow(), payload: { phase: "ready", invitationId } }).onConflictDoUpdate({ target: eventReceipts.id, set: { payload: { phase: "ready", invitationId }, processedAt: isoNow(), error: null }, setWhere: eq(eventReceipts.organizationId, workspaceId) });
  });
}

export async function reconcileInvitations(fence: AccessFence, invitations: MemberSnapshot["invitations"]) {
  await tenantTransaction(fence.workspaceId, async tx => {
    await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, fence.workspaceId)).for("update");
    await assertAccessFence(tx, fence);
    for (const invitation of invitations.filter(item => item.organizationId === fence.organizationId && ["pending", "accepted"].includes(item.state))) {
      const id = receiptId(fence.workspaceId, invitation.email);
      const [row] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, id), eq(eventReceipts.organizationId, fence.workspaceId)));
      if (row && ["creating", "uncertain"].includes(String(row.payload.phase))) await tx.update(eventReceipts).set({ payload: { phase: "ready", invitationId: invitation.id }, processedAt: isoNow(), error: null }).where(and(eq(eventReceipts.id, id), eq(eventReceipts.organizationId, fence.workspaceId)));
    }
  });
}

export async function failInvitation(workspaceId: string, email: string, error: unknown, fence?: AccessFence) {
  const status = Number((error as { status?: unknown } | null)?.status);
  const definitive = [400, 401, 403, 404, 422].includes(status);
  try {
    await tenantTransaction(workspaceId, async tx => {
      await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, workspaceId)).for("update");
      if (fence) { assert(fence.workspaceId === workspaceId, "Invalid invitation fence.", 403); await assertAccessFence(tx, fence); }
      const id = receiptId(workspaceId, email);
      const [receipt] = await tx.select().from(eventReceipts).where(and(eq(eventReceipts.id, id), eq(eventReceipts.organizationId, workspaceId)));
      if (receipt?.payload.phase === "creating") await tx.update(eventReceipts).set({ payload: { phase: definitive ? "failed" : "uncertain" }, processedAt: definitive ? isoNow() : null, error: "WorkOS invitation dispatch did not complete. Reconcile the provider invitation before another send." }).where(eq(eventReceipts.id, id));
    });
  } catch { /* The original creating record still prevents a duplicate dispatch during a database outage. */ }
}
