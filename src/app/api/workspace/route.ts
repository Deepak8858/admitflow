import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createDemo, sessionWorkspace, loadWorkspace, mutateWorkspace } from "@/lib/store";
import { applyAction, findLead } from "@/lib/actions";
import { publicWorkspace, suggestReply, sendReply, processJobs, bookAppointment } from "@/lib/integrations";
import { cookieOptions } from "@/lib/http";
import { resolveWorkspace } from "@/lib/auth";
import { productionDatabase } from "@/lib/config";
import { apiError, readAction } from "@/lib/api";
import { authorizeRecordAction } from "@/lib/permissions";
import { AppError, assert } from "@/lib/errors";
import { receiveMessage } from "@/lib/providers/meta";
import { uid } from "@/lib/domain";
import { assertEnquiryEntitlement, prepareBillingEntitlements } from "@/lib/providers/billing";
import { actionCapability } from "@/lib/subscription-policy";
import { prepareSubscription, assertActionCapability } from "@/lib/subscription-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    if (!productionDatabase() && !sessionWorkspace(request.cookies.get("admitflow_session")?.value)) {
      const { workspace, token } = createDemo();
      const response = NextResponse.json(publicWorkspace(workspace), { headers: { "Cache-Control": "no-store" } });
      response.cookies.set("admitflow_session", token, cookieOptions(request)); return response;
    }
    const context = await resolveWorkspace(request);
    // Verification may fail closed for paid work, never for existing-data reads.
    try { await prepareSubscription(context.workspaceId); } catch { /* The safe projection reports unavailable/stale access. */ }
    return NextResponse.json(publicWorkspace(await loadWorkspace(context.workspaceId), context.actor), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const action = await readAction(request), context = await resolveWorkspace(request);
    const workspace = await loadWorkspace(context.workspaceId);
    authorizeRecordAction(workspace, context.actor, action);
    if (actionCapability(workspace, action)) await prepareSubscription(context.workspaceId);
    if (action.type === "lead.create" || action.type === "lead.import") await prepareBillingEntitlements(workspace);
    let result: unknown = {};
    if (action.type === "message.suggest") {
      const input = z.object({ leadId: z.uuid(), question: z.string().max(4000).optional() }).parse(action);
      result = await suggestReply(workspace, findLead(workspace, input.leadId), input.question, context.actor);
      const latest = await loadWorkspace(context.workspaceId);
      authorizeRecordAction(latest, context.actor, action);
      assertActionCapability(latest, action);
    } else if (action.type === "message.send") {
      const input = z.object({ leadId: z.uuid(), body: z.string().trim().min(1).max(4000), requestId: z.uuid(), fileId: z.uuid().optional() }).parse(action);
      await sendReply(context.workspaceId, input.leadId, input.body, input.requestId, { actor: context.actor, fileId: input.fileId });
    } else if (action.type === "appointment.create" || action.type === "appointment.reschedule") {
      result = (await bookAppointment(context.workspaceId, action, { actor: context.actor, snapshot: workspace })).result;
    } else if (action.type === "jobs.run") result = await processJobs(context.workspaceId);
    else if (action.type === "message.simulate") {
      assert(workspace.demo, "Message simulation is available only in demo workspaces.", 403);
      const input = z.object({ leadId: z.uuid(), body: z.string().min(1).max(4000), echo: z.boolean().optional() }).parse(action);
      await mutateWorkspace(context.workspaceId, current => {
        const lead = findLead(current, input.leadId);
        receiveMessage(current, { id: `demo-${uid()}`, from: lead.phone.replace("+", ""), body: input.body, echo: input.echo });
        current.jobs.filter(job => job.kind === "ai.reply" && job.status === "pending").forEach(job => { job.dueAt = new Date().toISOString(); });
      });
      result = await processJobs(context.workspaceId);
    } else {
      result = (await mutateWorkspace(context.workspaceId, current => {
        authorizeRecordAction(current, context.actor, action);
        assertActionCapability(current, action);
        const previousActor = current.actor;
        current.actor = context.actor;
        try {
          const previousCount = current.leads.length;
          const applied = applyAction(current, action);
          if (action.type === "lead.create" || action.type === "lead.import") assertEnquiryEntitlement(current, previousCount, action.type);
          return applied;
        }
        catch (error) { if (error instanceof z.ZodError || error instanceof AppError) throw error; throw new AppError((error as Error).message); }
        finally { current.actor = previousActor; }
      })).result;
    }
    return NextResponse.json({ workspace: publicWorkspace(await loadWorkspace(context.workspaceId), context.actor), result: result ?? {} });
  } catch (error) { return apiError(error); }
}
