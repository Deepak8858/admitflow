import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, resolveWorkspace } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { assert } from "@/lib/errors";
import { loadWorkspace } from "@/lib/store";
import { billingOverview, cancelBillingSubscription, createBillingCheckout, readBillingEntitlements } from "@/lib/providers/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request); requireAdmin(context);
    const workspace = await loadWorkspace(context.workspaceId);
    const result = request.nextUrl.searchParams.get("type") === "entitlements" ? { entitlements: await readBillingEntitlements(workspace) } : await billingOverview(workspace);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const raw = await readAction(request, 4000), context = await resolveWorkspace(request); requireAdmin(context);
    assert(context.actor.backend === "workos" && !(await loadWorkspace(context.workspaceId)).demo, "Demo and local preview workspaces do not purchase subscriptions.", 409);
    const action = z.discriminatedUnion("type", [z.object({ type: z.literal("subscribe"), planId: z.string().min(1).max(50), requestId: z.uuid() }).strict(), z.object({ type: z.literal("cancel") }).strict()]).parse(raw);
    const result = action.type === "subscribe" ? await createBillingCheckout(context.workspaceId, action.planId, action.requestId) : await cancelBillingSubscription(context.workspaceId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
