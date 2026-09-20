import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
// ECS uses this for liveness. Dependency outages are reported separately by /api/ready.
export async function GET() { return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } }); }
