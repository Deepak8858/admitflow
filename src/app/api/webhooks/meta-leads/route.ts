import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validSignature } from "@/lib/providers/meta";
import { processMetaLeadPayload } from "@/lib/providers/meta-leads";
import { readLimitedText } from "@/lib/http";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const expected = Buffer.from(process.env.META_LEADS_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN || "");
  const supplied = Buffer.from(request.nextUrl.searchParams.get("hub.verify_token") || "");
  if (expected.length && expected.length === supplied.length && timingSafeEqual(expected, supplied) && request.nextUrl.searchParams.get("hub.mode") === "subscribe") return new NextResponse(request.nextUrl.searchParams.get("hub.challenge") || "", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(request: NextRequest) {
  if (!process.env.META_APP_SECRET) return NextResponse.json({ error: "Meta webhook signing is not configured." }, { status: 503 });
  let raw: string;
  try { raw = await readLimitedText(request, 1_000_000); }
  catch (error) { return apiError(error); }
  const supplied = request.headers.get("x-hub-signature-256") || "";
  if (!/^sha256=[a-f0-9]{64}$/.test(supplied) || !validSignature(raw, supplied, process.env.META_APP_SECRET)) return new NextResponse("Invalid signature", { status: 403 });
  try {
    const result = await processMetaLeadPayload(JSON.parse(raw));
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return NextResponse.json({ error: "Malformed Meta webhook." }, { status: 400 });
    return NextResponse.json({ error: "Enquiry processing failed. Retry delivery." }, { status: 503, headers: { "Retry-After": "30" } });
  }
}
