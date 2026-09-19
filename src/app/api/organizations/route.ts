import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hostedSession, workos } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { assert } from "@/lib/errors";
import { refreshSession } from "@workos-inc/authkit-nextjs";
export async function GET() {
  try {
    const session = await hostedSession();
    const memberships = await workos().userManagement.listOrganizationMemberships({ userId: session.user!.id, statuses: ["active"], limit: 100 });
    const organizations = await Promise.all(memberships.data.map(async membership => { const org = await workos().organizations.getOrganization(membership.organizationId); return { id: org.id, name: org.name, role: membership.role?.slug }; }));
    return NextResponse.json({ organizations, current: session.organizationId, name: session.user!.firstName });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const action = await readAction(request, 5000);
    const session = await hostedSession();
    if (action.type === "create") {
      const name = z.string().trim().min(2).max(100).parse(action.name);
      const org = await workos().organizations.createOrganization({ name });
      await workos().userManagement.createOrganizationMembership({ organizationId: org.id, userId: session.user!.id, roleSlug: "owner" });
      await refreshSession({ organizationId: org.id, ensureSignedIn: true });
      return NextResponse.json({ id: org.id });
    }
    const organizationId = z.string().startsWith("org_").parse(action.organizationId);
    const memberships = await workos().userManagement.listOrganizationMemberships({ userId: session.user!.id, organizationId, statuses: ["active"] });
    assert(memberships.data.length, "This institute is not available to your account.", 403);
    await refreshSession({ organizationId, ensureSignedIn: true });
    return NextResponse.json({ id: organizationId });
  } catch (error) { return apiError(error); }
}
