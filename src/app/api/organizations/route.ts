import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hostedSession, workos } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { assert } from "@/lib/errors";
import { refreshSession } from "@workos-inc/authkit-nextjs";
import { acknowledgeProvisioning, continueProvisioning, pendingProvisioningStatus, provisioningStatus, readyProvisioning, startProvisioning } from "@/lib/provisioning";
import { enforceMutationRateLimit } from "@/lib/mutation-rate-limit";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const actorFor = (userId: string) => ({ actorId: userId, clientId: z.string().min(1).parse(process.env.WORKOS_CLIENT_ID) });
export async function GET() {
  try {
    const session = await hostedSession(), provider = workos(), actor = actorFor(session.user!.id);
    const memberships = await (await provider.userManagement.listOrganizationMemberships({ userId: actor.actorId, statuses: ["active"], limit: 100 })).autoPagination();
    const organizations = [];
    // Bound provider concurrency while retaining the complete list, not just the first page.
    const seen = new Set<string>();
    for (const membership of memberships) {
      if (membership.userId !== actor.actorId || membership.status !== "active" || seen.has(membership.organizationId)) continue;
      const org = await provider.organizations.getOrganization(membership.organizationId);
      assert(org.id === membership.organizationId, "Institute identity could not be verified.", 503);
      organizations.push({ id: org.id, name: org.name, role: membership.role?.slug }); seen.add(org.id);
    }
    return json({ organizations, current: session.organizationId, name: session.user!.firstName, scope: `${actor.clientId}:${actor.actorId}`, provisioning: await pendingProvisioningStatus(actor, provider) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const action = await readAction(request, 5000);
    const session = await hostedSession(), provider = workos(), actor = actorFor(session.user!.id);
    await enforceMutationRateLimit(request, { kind: "organizations", actorId: actor.actorId, create: action.type === "create" });
    if (action.type === "create") {
      const status = await startProvisioning(actor, z.uuid().parse(action.requestId), z.string().parse(action.name), provider);
      return json({ provisioning: status }, status.state === "ready" ? 200 : 202);
    }
    if (action.type === "continue") {
      const status = await continueProvisioning(actor, z.uuid().parse(action.id), provider);
      return json({ provisioning: status }, status.state === "ready" ? 200 : 202);
    }
    if (action.type === "acknowledge") return json({ provisioning: await acknowledgeProvisioning(actor, z.uuid().parse(action.id), provider) });
    if (action.type === "open") {
      const operation = await readyProvisioning(actor, z.uuid().parse(action.id), provider);
      try { await refreshSession({ organizationId: operation.organizationId!, ensureSignedIn: true }); }
      catch { return json({ error: "Your institute is ready, but sign-in could not be updated. Retry Open institute or sign in again; do not create a replacement.", code: "PROVISIONING_SESSION_INCOMPLETE", provisioning: provisioningStatus(operation) }, 503); }
      return json({ id: operation.organizationId });
    }
    assert(action.type === undefined || action.type === "switch", "Unknown institute action.");
    const organizationId = z.string().regex(/^org_[A-Za-z0-9_]+$/).parse(action.organizationId);
    const memberships = await (await provider.userManagement.listOrganizationMemberships({ userId: actor.actorId, organizationId, statuses: ["active"] })).autoPagination();
    assert(memberships.some(member => member.userId === actor.actorId && member.organizationId === organizationId && member.status === "active"), "This institute is not available to your account.", 403);
    try { await refreshSession({ organizationId, ensureSignedIn: true }); }
    catch { return json({ error: "Sign-in could not be updated. Retry opening your institute or sign in again." }, 503); }
    return json({ id: organizationId });
  } catch (error) { return apiError(error); }
}
