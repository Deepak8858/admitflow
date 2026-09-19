import type { Invitation, OrganizationMembership, User } from "@workos-inc/node";
import type { Member, Role } from "@/lib/domain";
import { assert } from "@/lib/errors";

const knownRole = (role: string | null | undefined) => ["owner", "admin", "counsellor", "analyst"].includes(role || "");
const appRole = (role: string | null | undefined): Role => knownRole(role) ? role as Role : "analyst";
const emailKey = (value: string) => value.trim().toLowerCase();
export type MemberSnapshot = {
  memberships: Pick<OrganizationMembership, "id" | "userId" | "organizationId" | "status" | "role">[];
  invitations: Pick<Invitation, "id" | "email" | "state" | "organizationId" | "acceptedUserId" | "roleSlug" | "expiresAt">[];
  users: Pick<User, "id" | "email" | "firstName" | "lastName">[];
};

/** Email is used only for invitation display/deduplication. Membership identity always comes from WorkOS userId. */
export function projectMembers(previous: Member[], snapshot: MemberSnapshot, organizationId: string, now = Date.now()): Member[] {
  const members: Member[] = [];
  const users = new Map(snapshot.users.map(user => [user.id, user]));
  for (const membership of snapshot.memberships.filter(member => member.organizationId === organizationId)) {
    const user = users.get(membership.userId), old = previous.find(member => member.workosId === membership.userId);
    const email = user?.email || old?.email || "";
    const invite = snapshot.invitations.find(item => item.organizationId === organizationId && item.state === "pending" && emailKey(item.email) === emailKey(email));
    const display = old || previous.find(member => member.id === invite?.id);
    members.push({
      // Retain a projection's primary key if WorkOS recreated the membership, avoiding a unique-identity collision.
      id: old?.id || membership.id, workosId: membership.userId,
      name: [user?.firstName, user?.lastName].filter(Boolean).join(" ") || display?.name || email.split("@")[0] || "Team member",
      email, role: appRole(membership.role.slug),
      status: !knownRole(membership.role.slug) ? "inactive" : membership.status === "pending" ? "invited" : membership.status,
    });
  }
  for (const invitation of snapshot.invitations.filter(item => item.organizationId === organizationId && item.state === "pending" && Date.parse(item.expiresAt) > now)) {
    if (members.some(member => emailKey(member.email) === emailKey(invitation.email))) continue;
    const old = previous.find(member => member.id === invitation.id);
    members.push({ id: invitation.id, name: old?.name || invitation.email.split("@")[0], email: invitation.email, role: appRole(invitation.roleSlug), status: knownRole(invitation.roleSlug) ? "invited" : "inactive" });
  }
  // Preserve departed users as inactive audit/display records, never as active assignees.
  for (const old of previous) {
    if (members.some(member => member.id === old.id || Boolean(old.workosId && member.workosId === old.workosId))) continue;
    // Unclaimed legacy members can still be referenced by owner foreign keys; they remain inactive until reassigned.
    if (old.workosId || old.status !== "invited") members.push({ ...old, status: "inactive" });
  }
  return members.sort((a, b) => a.id.localeCompare(b.id));
}

export function authorizeMemberChange(actor: { id: string; role: Role }, target: Member, action: "role" | "deactivate" | "reactivate" | "revoke", members: Member[], nextRole?: Role) {
  assert(["owner", "admin"].includes(actor.role), "An institute administrator is required.", 403);
  if (target.role === "owner" || nextRole === "owner") assert(actor.role === "owner", "Only an owner can manage ownership roles.", 403);
  if (action === "deactivate") assert(target.workosId !== actor.id, "Ask another administrator to deactivate your membership.", 409);
  if ((action === "deactivate" || (action === "role" && nextRole !== "owner")) && target.role === "owner" && target.status === "active") assert(members.some(member => member.id !== target.id && member.role === "owner" && member.status === "active"), "Keep at least one active institute owner.", 409);
}
