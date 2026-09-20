import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { resolveWorkspace, workos } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { productionDatabase } from "@/lib/config";
import { tenantTransaction } from "@/lib/db/repository";
import { organizations } from "@/lib/db/schema";
import { loadWorkspace, sessionWorkspace } from "@/lib/store";
import { AppError, assert } from "@/lib/errors";
import { workspaceEventStream } from "./stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request);
    const readRevision = async () => {
      if (!productionDatabase()) return (await loadWorkspace(context.workspaceId)).revision || 0;
      return tenantTransaction(context.workspaceId, async tx => {
        const [row] = await tx.select({ revision: organizations.revision }).from(organizations).where(eq(organizations.id, context.workspaceId));
        assert(row, "Institute no longer available.", 403);
        return row.revision;
      });
    };
    const validateMembership = async () => {
      if (context.actor.backend === "local") return sessionWorkspace(request.cookies.get("admitflow_session")?.value) === context.workspaceId;
      if (!context.workosOrganizationId) return false;
      // Do not reuse withAuth's request cache: WorkOS is checked again during the stream.
      const memberships = await workos().userManagement.listOrganizationMemberships({ userId: context.actor.id, organizationId: context.workosOrganizationId, statuses: ["active"] });
      return memberships.data.some(member => member.userId === context.actor.id && member.organizationId === context.workosOrganizationId && member.status === "active" && member.role.slug === context.actor.role);
    };
    const initialRevision = await readRevision();
    return new Response(workspaceEventStream({ workspaceId: context.workspaceId, signal: request.signal, initialRevision, readRevision, validateMembership }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-store, no-transform", "X-Accel-Buffering": "no", "Vary": "Cookie" } });
  } catch (error) {
    if (error instanceof AppError && [401, 403, 409].includes(error.status)) return new Response('event: revoked\ndata: {"reason":"session_unavailable"}\n\n', { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-store", "X-Accel-Buffering": "no" } });
    return apiError(error);
  }
}
