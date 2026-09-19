import { NextRequest, NextResponse } from "next/server";
import { constantTimeEqual } from "@/lib/http";
import { dispatchOutbox, workQueue } from "@/lib/db/outbox";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  const provided = request.headers.get("authorization") || "";
  if (!expected || !constantTimeEqual(expected, provided)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const queue = workQueue();
    try { return NextResponse.json(await dispatchOutbox(queue)); }
    finally { await queue.close(); }
  } catch (error) { return apiError(error); }
}
