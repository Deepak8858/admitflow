import { NextRequest, NextResponse } from "next/server";
import { processMetaPayload, validSignature } from "@/lib/providers/meta";
import { constantTimeEqual, readLimitedText } from "@/lib/http";
import { apiError } from "@/lib/api";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN || "", provided = request.nextUrl.searchParams.get("hub.verify_token") || "";
  if (expected && constantTimeEqual(expected, provided) && request.nextUrl.searchParams.get("hub.mode") === "subscribe") return new NextResponse(request.nextUrl.searchParams.get("hub.challenge"));
  return new NextResponse("Verification failed", { status: 403 });
}
export async function POST(request: NextRequest) {
  try {
    const raw = await readLimitedText(request, 2_000_000);
    if (!validSignature(raw, request.headers.get("x-hub-signature-256") || "", process.env.META_APP_SECRET)) return new NextResponse("Invalid signature", { status: 403 });
    await processMetaPayload(JSON.parse(raw), true); return NextResponse.json({ received: true });
  } catch (error) { return apiError(error); }
}
