import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveWorkspace } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { assert } from "@/lib/errors";
import { calendarBusy } from "@/lib/providers/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request);
    assert(context.actor.role !== "analyst", "Your role cannot book counselling sessions.", 403);
    const input = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await calendarBusy(context.workspaceId, input.from, input.to), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
