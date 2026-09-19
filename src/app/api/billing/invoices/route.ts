import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, resolveWorkspace } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { loadWorkspace } from "@/lib/store";
import { listBillingInvoices } from "@/lib/providers/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request); requireAdmin(context);
    const query = z.object({ page: z.coerce.number().int().min(1).max(10000).default(1) }).strict().parse(Object.fromEntries(request.nextUrl.searchParams));
    return NextResponse.json(await listBillingInvoices(await loadWorkspace(context.workspaceId), query.page), { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return apiError(error); }
}
