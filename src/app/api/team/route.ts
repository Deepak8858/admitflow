import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, resolveWorkspace, workos, type SessionContext } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { loadWorkspace, mutateWorkspace } from "@/lib/store";
import { publicWorkspace } from "@/lib/integrations";
import { assert } from "@/lib/errors";
import { addActivity, uid, type Member, type Workspace } from "@/lib/domain";
import { assertActor } from "@/lib/permissions";
import { authorizeMemberChange, projectMembers, type MemberSnapshot } from "./members";
import { claimInvitation, failInvitation, finishInvitation, reconcileInvitations } from "./invitations";
import { confirmBillingSeat, failBillingSeat, prepareBillingEntitlements, reconcileBillingSeats, reserveBillingSeat } from "@/lib/providers/billing";
import { ACCESS_LEASE_MS, claimAccess, confirmAccess, dispatchAccess, mutateAccessWorkspace, readAccessFence, releaseAccess, type AccessFence } from "@/lib/db/team-access";
import { prepareSubscription, assertWorkspaceCapability } from "@/lib/subscription-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const roles = z.enum(["owner", "admin", "counsellor", "analyst"]);
const inviteSchema = z.object({ type: z.literal("invite"), name: z.string().trim().min(1).max(100), email: z.email().max(200).transform(value => value.toLowerCase()), role: roles });
const memberSchema = z.object({ type: z.enum(["role", "deactivate", "reactivate", "revoke"]), id: z.string().min(1).max(200), role: roles.optional() });

type TeamSnapshot = MemberSnapshot & { observedAt: number };
async function snapshot(organizationId: string): Promise<TeamSnapshot> {
  const observedAt = Date.now();
  const management = workos().userManagement;
  const [memberships, invitations] = await Promise.all([
    management.listOrganizationMemberships({ organizationId, statuses: ["active", "inactive", "pending"], limit: 100 }).then(page => page.autoPagination()),
    management.listInvitations({ organizationId, limit: 100 }).then(page => page.autoPagination()),
  ]);
  const users: MemberSnapshot["users"] = [];
  const ids = [...new Set(memberships.map(member => member.userId))];
  for (let offset = 0; offset < ids.length; offset += 8) users.push(...await Promise.all(ids.slice(offset, offset + 8).map(id => management.getUser(id))));
  return { memberships, invitations, users, observedAt };
}

async function reconcile(context: SessionContext, state: TeamSnapshot, fence: AccessFence) {
  const reconciled = (await mutateAccessWorkspace(fence, current => {
    current.members = projectMembers(current.members || [], state, context.workosOrganizationId!);
    current.team = [...new Set(current.members.filter(member => member.status === "active").map(member => member.name))];
    // The owner FK targets the stable member projection; its WorkOS user ID anchors authorization.
    for (const record of [...current.leads, ...current.tasks!, ...current.appointments]) {
      const member = record.ownerId ? current.members.find(item => item.id === record.ownerId && item.workosId) : undefined;
      if (member) record.owner = member.name;
    }
  })).workspace;
  await reconcileBillingSeats(context.workspaceId, context.workosOrganizationId!, state, fence);
  await reconcileInvitations(fence, state.invitations);
  return reconciled;
}
function responseFor(workspace: Workspace, context: SessionContext, message?: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ members: workspace.members, workspace: publicWorkspace(workspace, context.actor), mode: context.actor.backend === "workos" ? "live" : "demo", message, ...extra }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request); requireAdmin(context);
    if (context.actor.backend === "local") return responseFor(await loadWorkspace(context.workspaceId), context, "Local team preview. Invitations do not send email or grant another account access.");
    const previous = await readAccessFence(context.workspaceId, context.workosOrganizationId!);
    let fence: AccessFence;
    if (previous.phase === "dispatched") {
      assert(Date.now() - previous.startedAt >= ACCESS_LEASE_MS, "Team access is still being confirmed. Refresh shortly.", 409);
      // Recovery is a provider read, not permission to repeat the previous write.
      fence = await confirmAccess(previous, await snapshot(context.workosOrganizationId!));
    } else fence = await claimAccess(context.workspaceId, context.workosOrganizationId!);
    try {
      const workspace = await reconcile(context, await snapshot(context.workosOrganizationId!), fence);
      assertActor(workspace, context.actor);
      return responseFor(workspace, context);
    } finally { await releaseAccess(fence); }
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest) {
  let fence: AccessFence | undefined, providerDispatched = false;
  try {
    const raw = await readAction(request, 6000), context = await resolveWorkspace(request); requireAdmin(context);
    const action = raw.type === "invite" ? inviteSchema.parse(raw) : memberSchema.parse(raw);
    if (action.type === "invite" && action.role === "owner") assert(context.actor.role === "owner", "Only an owner can invite another owner.", 403);
    if (context.actor.backend === "local") {
      const { workspace, result } = await mutateWorkspace(context.workspaceId, current => {
        if (action.type === "invite") {
          const existing = current.members!.find(member => member.email.toLowerCase() === action.email && member.status !== "inactive");
          if (existing) return existing;
          const member: Member = { id: uid(), name: action.name, email: action.email, role: action.role, status: "invited" };
          current.members!.push(member);
          addActivity(current, `Demo invitation saved for ${member.name} · no email sent`, "lead");
          return member;
        }
        const target = current.members!.find(member => member.id === action.id); assert(target, "Team member not found.", 404);
        authorizeMemberChange(context.actor, target, action.type, current.members!, action.role);
        if (action.type === "role") { assert(action.role, "Choose a role."); target.role = action.role; }
        else if (action.type === "reactivate") { assert(target.status === "inactive", "Only inactive members can be reactivated.", 409); target.status = "active"; }
        else target.status = "inactive";
        current.team = [...new Set(current.members!.filter(member => member.status === "active").map(member => member.name))];
        return target;
      });
      return responseFor(workspace, context, action.type === "invite" ? "Demo invitation saved. No email was sent and no account access was granted." : "Demo team preview updated. Live account access was not changed.", { member: result, emailSent: false });
    }

    const organizationId = context.workosOrganizationId!;
    assert(organizationId, "Choose an institute first.", 409);
    fence = await claimAccess(context.workspaceId, organizationId);
    const management = workos().userManagement, state = await snapshot(organizationId);
    const current = await reconcile(context, state, fence);
    assertActor(current, context.actor);
    requireAdmin(context);
    if (action.type === "invite" || action.type === "reactivate") {
      if (action.type === "reactivate") { const target = current.members!.find(member => member.id === action.id); assert(target, "Team member not found in this institute.", 404); authorizeMemberChange(context.actor, target, action.type, current.members!, action.role); }
      await prepareSubscription(context.workspaceId);
      await prepareBillingEntitlements(current);
    }
    let message = "Team access updated.", emailSent = false;
    if (action.type === "invite") {
      assert(!current.members!.some(member => member.email.toLowerCase() === action.email && member.status === "active"), "This person already has active access to your institute.", 409);
      assert(!current.members!.some(member => member.email.toLowerCase() === action.email && member.status === "inactive" && member.workosId), "Reactivate this teammate's existing membership instead of sending another invitation.", 409);
      let invitation = state.invitations.find(item => item.organizationId === organizationId && item.email.toLowerCase() === action.email && item.state === "pending" && Date.parse(item.expiresAt) > Date.now());
      if (!invitation) fence = await dispatchAccess(fence, { kind: "invite", email: action.email, role: action.role, previousIds: state.invitations.map(item => item.id) });
      const seat = await reserveBillingSeat(context.workspaceId, { email: action.email, kind: "invite" }, fence);
      let dispatched = Boolean(invitation);
      try {
        assert(!seat || seat.owned || invitation, "An invitation for this recipient is already being confirmed. Refresh the team before retrying.", 409);
        if (!invitation) {
          // WorkOS owns the invitation. A retry first reconciles pending invitations instead of blindly resending email.
          await claimInvitation(context.workspaceId, action.email, state.invitations, fence);
          await mutateAccessWorkspace(fence, workspace => { assertActor(workspace, context.actor); assertWorkspaceCapability(workspace); });
          dispatched = true; providerDispatched = true;
          try { invitation = await management.sendInvitation({ organizationId, email: action.email, roleSlug: action.role, inviterUserId: context.actor.id }); emailSent = true; }
          catch (error) {
            try {
              const existing = await management.listInvitations({ organizationId, email: action.email, limit: 100 });
              invitation = existing.data.find(item => item.organizationId === organizationId && item.email.toLowerCase() === action.email && item.roleSlug === action.role && !state.invitations.some(old => old.id === item.id) && item.state === "pending" && Date.parse(item.expiresAt) > Date.now());
            } catch { /* Preserve the dispatch failure, including uncertainty about whether an email was sent. */ }
            if (!invitation) { await failInvitation(context.workspaceId, action.email, error, fence); throw error; }
          }
        }
        await confirmBillingSeat(seat, invitation.id, invitation.acceptedUserId || undefined, fence);
        await finishInvitation(context.workspaceId, action.email, invitation.id, fence);
      } catch (error) { await failBillingSeat(seat, error, !dispatched, fence); throw error; }
      const id = invitation.id;
      await mutateAccessWorkspace(fence, workspace => {
        const old = workspace.members!.find(member => member.id === id);
        if (old) old.name = action.name;
        else workspace.members!.push({ id, name: action.name, email: invitation!.email, role: invitation!.roleSlug && roles.safeParse(invitation!.roleSlug).success ? invitation!.roleSlug as Member["role"] : action.role, status: "invited" });
      });
      message = emailSent ? "WorkOS sent the institute invitation." : "An invitation is already pending. No additional email was sent.";
    } else {
      const target = current.members!.find(member => member.id === action.id); assert(target, "Team member not found in this institute.", 404);
      authorizeMemberChange(context.actor, target, action.type, current.members!, action.role);
      const membership = state.memberships.find(member => member.organizationId === organizationId && member.userId === target.workosId);
      if (action.type === "revoke" || (action.type === "deactivate" && target.status === "invited")) {
        const invitation = state.invitations.find(item => item.organizationId === organizationId && item.state === "pending" && item.email.toLowerCase() === target.email.toLowerCase());
        assert(invitation, "There is no pending invitation to revoke.", 409);
        fence = await dispatchAccess(fence, { kind: "revoke", id: invitation.id });
        providerDispatched = true;
        await management.revokeInvitation(invitation.id);
        message = "Invitation revoked.";
      } else {
        assert(membership, "This WorkOS membership is no longer available. Refresh the team list.", 409);
        if (action.type === "role") {
          assert(action.role, "Choose a role.");
          if (membership.role.slug !== action.role) {
            fence = await dispatchAccess(fence, { kind: "membership", id: membership.id, userId: membership.userId, role: action.role, status: membership.status });
            providerDispatched = true;
            await management.updateOrganizationMembership(membership.id, { roleSlug: action.role });
          }
        } else if (action.type === "deactivate") {
          if (membership.status !== "inactive") {
            fence = await dispatchAccess(fence, { kind: "membership", id: membership.id, userId: membership.userId, role: target.role, status: "inactive" });
            providerDispatched = true;
            await management.deactivateOrganizationMembership(membership.id);
          }
        } else if (action.type === "reactivate") {
          assert(membership.status !== "pending", "This teammate must accept their invitation.", 409);
          if (membership.status !== "active") {
            fence = await dispatchAccess(fence, { kind: "membership", id: membership.id, userId: membership.userId, role: target.role, status: "active" });
            const seat = await reserveBillingSeat(context.workspaceId, { email: target.email, kind: "reactivate", memberId: target.id, workosId: membership.userId }, fence);
            try {
              assert(!seat || seat.owned, "This membership already has a pending reactivation. Refresh the team before retrying.", 409);
              await mutateAccessWorkspace(fence, workspace => { assertActor(workspace, context.actor); assertWorkspaceCapability(workspace); });
              providerDispatched = true;
              const active = await management.reactivateOrganizationMembership(membership.id);
              await confirmBillingSeat(seat, active.id, active.userId, fence);
            } catch (error) { await failBillingSeat(seat, error, !providerDispatched, fence); throw error; }
          }
        }
      }
    }
    const finalState = await snapshot(organizationId);
    if (fence.phase === "dispatched") fence = await confirmAccess(fence, finalState);
    await reconcile(context, finalState, fence);
    await releaseAccess(fence);
    fence = undefined;
    // A self-service role change must return the newly scoped identity, not the original admin projection.
    const finalContext = await resolveWorkspace(request);
    assert(finalContext.workspaceId === context.workspaceId, "Your institute session changed. Refresh the team list.", 409);
    return responseFor(await loadWorkspace(context.workspaceId), finalContext, message, { emailSent });
  } catch (error) { return apiError(error); }
  finally {
    if (fence) try { await releaseAccess(fence, !providerDispatched); } catch { /* Durable intent remains closed during a database outage. */ }
  }
}
