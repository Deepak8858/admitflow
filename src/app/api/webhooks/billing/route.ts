import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { validSignature } from "@/lib/providers/meta";
import { processBillingWebhook } from "@/lib/providers/billing";
import { AppError } from "@/lib/errors";
import { readLimitedText } from "@/lib/http";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = process.env.BILLING_RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Platform billing webhook signing is not configured." }, { status: 503 });
  let raw: string;
  try { raw = await readLimitedText(request, 1_000_000); }
  catch (error) { return apiError(error); }
  const signature = request.headers.get("x-razorpay-signature") || "";
  if (!/^[a-f0-9]{64}$/.test(signature) || !validSignature(raw, signature, secret, "")) return new NextResponse("Invalid signature", { status: 403 });
  const headerId = request.headers.get("x-razorpay-event-id") || "";
  // The event header is not covered by Razorpay's body signature. Bind it to the signed body as well.
  const eventId = `${/^[A-Za-z0-9_.:-]{1,200}$/.test(headerId) ? headerId : "body"}:${createHash("sha256").update(raw).digest("hex")}`;
  try { return NextResponse.json({ received: true, ...await processBillingWebhook(JSON.parse(raw), eventId) }); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof AppError && error.status === 400) return NextResponse.json({ error: "Malformed billing event." }, { status: 400 });
    if (error instanceof AppError && error.status === 403) return NextResponse.json({ error: "Billing event does not match this subscription account." }, { status: 403 });
    return NextResponse.json({ error: "Billing reconciliation failed. Retry delivery." }, { status: 503, headers: { "Retry-After": "30" } });
  }
}
