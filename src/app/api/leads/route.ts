import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveWorkspace } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { productionDatabase } from "@/lib/config";
import { loadWorkspace } from "@/lib/store";
import { scopeWorkspace } from "@/lib/permissions";
import { queryPostgresLeads, type LeadPage } from "@/lib/db/repository";
import { STAGES, LEAD_VIEWS, LEAD_SORTS, leadMatchesView, sortLeads } from "@/lib/domain";

import { MAX_LEAD_PAGE, MAX_LEAD_PAGE_SIZE, hasMoreLeadPages } from "@/lib/lead-pagination";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const querySchema = z.object({ q: z.string().trim().max(100).optional(), course: z.string().max(100).optional(), stage: z.enum(STAGES).optional(), ownerId: z.string().max(200).optional(), view: z.enum(LEAD_VIEWS).default("all"), sort: z.enum(LEAD_SORTS).default("newest"), page: z.coerce.number().int().min(1).max(MAX_LEAD_PAGE).default(1), pageSize: z.coerce.number().int().min(1).max(MAX_LEAD_PAGE_SIZE).default(50) });
export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request);
    const query = querySchema.parse(Object.fromEntries([...request.nextUrl.searchParams].filter(([, value]) => value !== ""))), now = Date.now();
    let result: LeadPage;
    if (productionDatabase()) result = await queryPostgresLeads(context.workspaceId, context.actor, query, now);
    else {
      const workspace = scopeWorkspace(await loadWorkspace(context.workspaceId), context.actor);
      const ownerId = query.ownerId ? workspace.members?.find(member => member.id === query.ownerId || member.workosId === query.ownerId)?.id || query.ownerId : undefined;
      const leads = sortLeads(workspace.leads.filter(lead => (!query.q || `${lead.name}\n${lead.phone}\n${lead.email}`.toLowerCase().includes(query.q.toLowerCase())) && (!query.course || lead.course === query.course) && (!query.stage || lead.stage === query.stage) && (!ownerId || (ownerId === "unassigned" ? !lead.ownerId : lead.ownerId === ownerId)) && leadMatchesView(lead, query.view, now)), query.sort, now);
      result = { leads: leads.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), page: query.page, pageSize: query.pageSize, total: leads.length, hasMore: hasMoreLeadPages(leads.length, query.page, query.pageSize) };
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}
