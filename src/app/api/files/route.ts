import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveWorkspace } from "@/lib/auth";
import { apiError, readAction } from "@/lib/api";
import { beginUpload, finishUpload, downloadUrl } from "@/lib/files";
import { assert } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request), id = z.uuid().parse(request.nextUrl.searchParams.get("id"));
    const response = NextResponse.redirect(await downloadUrl(context.workspaceId, id, context.actor));
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const action = await readAction(request, 5000), context = await resolveWorkspace(request);
    if (action.type === "finish") return NextResponse.json((await finishUpload(context.workspaceId, z.uuid().parse(action.id), context.actor)).result);
    assert(action.type === undefined || action.type === "begin" || action.type === "upload", "Unsupported file action.");
    const input = z.object({ name: z.string().min(1).max(160), mime: z.string(), size: z.number().int(), purpose: z.enum(["knowledge", "attachment", "receipt", "import"]), leadId: z.uuid().optional() }).parse(action);
    return NextResponse.json(await beginUpload(context.workspaceId, input, context.actor));
  } catch (error) { return apiError(error); }
}
