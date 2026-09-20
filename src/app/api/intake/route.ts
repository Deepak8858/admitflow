import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveWorkspace } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { assert } from "@/lib/errors";
import { assertPermission } from "@/lib/permissions";
import { productionDatabase } from "@/lib/config";
import { importIntake, intakeSummary } from "@/lib/db/intake";
import { loadWorkspace } from "@/lib/store";
import { publicWorkspace } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function context(request: NextRequest) {
  const context = await resolveWorkspace(request);
  assertPermission(context.actor.role, "intake.import");
  assert(productionDatabase(), "Deferred intake is available for hosted institutes.", 409);
  return context;
}
export async function GET(request: NextRequest) {
  try {
    const { workspaceId, actor } = await context(request);
    return NextResponse.json(await intakeSummary(workspaceId, actor), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const input = z.object({ type: z.literal("import"), after: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().parse(await readAction(request, 2048));
    const { workspaceId, actor } = await context(request);
    const { result } = await importIntake(workspaceId, actor, input.after);
    // Reload derived pending-contact flags after the receipt/aggregate transaction commits.
    return NextResponse.json({ result, summary: await intakeSummary(workspaceId, actor), workspace: publicWorkspace(await loadWorkspace(workspaceId), actor) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
