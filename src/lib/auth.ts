import { WorkOS } from "@workos-inc/node";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { productionDatabase, workosConfigured } from "./config";
import { AppError, assert } from "./errors";
import { sessionWorkspace, loadWorkspace } from "./store";
import { createWorkspace } from "./seed";
import { database } from "./db/client";
import { organizationRoutes } from "./db/schema";
import { createPostgresWorkspace } from "./db/repository";
import { readAccessFence, projectAccessIdentity } from "./db/team-access";
import type { Workspace, Role } from "./domain";

export type Actor = NonNullable<Workspace["actor"]>;
export interface SessionContext { workspaceId: string; actor: Actor; workosOrganizationId?: string }
let sdk: WorkOS | undefined;
export function workos() {
  assert(workosConfigured(), "WorkOS is not configured. Add the AuthKit environment variables.", 503);
  // Durable access intents own recovery; transport retries must never repeat an uncertain write.
  return sdk ||= new WorkOS(process.env.WORKOS_API_KEY!, { clientId: process.env.WORKOS_CLIENT_ID, maxRetries: 0, timeout: 15_000 });
}
export function roleFrom(value?: string): Role {
  assert(["owner", "admin", "counsellor", "analyst"].includes(value || ""), "Your WorkOS role is not configured for this institute.", 403);
  return value as Role;
}

export async function hostedSession() {
  assert(workosConfigured() && productionDatabase(), "Production sign-in requires WorkOS and Neon configuration.", 503);
  const { withAuth } = await import("@workos-inc/authkit-nextjs");
  const session = await withAuth();
  assert(session.user, "Sign in to continue.", 401);
  return session;
}
export async function resolveWorkspace(request: NextRequest): Promise<SessionContext> {
  if (!productionDatabase()) {
    const workspaceId = sessionWorkspace(request.cookies.get("admitflow_session")?.value);
    assert(workspaceId, "Your session expired. Refresh or sign in again.", 401);
    const workspace = await loadWorkspace(workspaceId);
    return { workspaceId, actor: { id: workspace.id, name: workspace.userName, email: workspace.email, role: "owner", backend: "local" } };
  }
  const session = await hostedSession();
  if (!session.organizationId) throw new AppError("Choose or create your institute to continue.", 409, "ORGANIZATION_REQUIRED");
  let [mapping] = await database().select().from(organizationRoutes).where(eq(organizationRoutes.workosId, session.organizationId));
  let fence = mapping ? await readAccessFence(mapping.organizationId, session.organizationId) : undefined;
  const activeMembership = async () => {
    const memberships = await workos().userManagement.listOrganizationMemberships({ userId: session.user!.id, organizationId: session.organizationId!, statuses: ["active"] });
    const membership = memberships.data.find(item => item.userId === session.user!.id && item.organizationId === session.organizationId && item.status === "active");
    assert(membership, "Your institute membership is no longer active.", 403);
    return membership;
  };
  let membership = await activeMembership();
  const actor: Actor = { id: session.user!.id, memberId: membership.id, email: session.user!.email, name: [session.user!.firstName, session.user!.lastName].filter(Boolean).join(" ") || session.user!.email.split("@")[0], role: roleFrom(membership.role?.slug), backend: "workos" };
  if (!mapping) {
    const org = await workos().organizations.getOrganization(session.organizationId);
    const fresh = createWorkspace(false);
    fresh.name = org.name; fresh.userName = actor.name; fresh.email = actor.email; fresh.team = [actor.name];
    fresh.members = [{ id: membership.id, name: actor.name, email: actor.email, role: actor.role, status: "active", workosId: actor.id }];
    try { await createPostgresWorkspace(fresh, session.organizationId); }
    catch (error) { const [existing] = await database().select().from(organizationRoutes).where(eq(organizationRoutes.workosId, session.organizationId)); if (!existing) throw error; }
    [mapping] = await database().select().from(organizationRoutes).where(eq(organizationRoutes.workosId, session.organizationId));
  }
  assert(mapping, "Institute provisioning is still in progress. Please retry.", 503);
  // A provisioning race must not reuse a membership fetched before the winning tenant existed.
  if (!fence) {
    fence = await readAccessFence(mapping.organizationId, session.organizationId);
    membership = await activeMembership();
    actor.role = roleFrom(membership.role?.slug);
  }
  await projectAccessIdentity(fence, actor, membership.id);
  return { workspaceId: mapping.organizationId, workosOrganizationId: session.organizationId, actor };
}

export function requireAdmin(context: SessionContext) { if (!["owner", "admin"].includes(context.actor.role)) throw new AppError("An institute administrator is required.", 403); }
