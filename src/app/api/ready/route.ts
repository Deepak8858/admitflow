import { NextResponse } from "next/server";
import { readiness } from "@/lib/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const result = await readiness();
  return NextResponse.json(result, { status: result.status === "ready" ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
