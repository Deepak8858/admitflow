import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadWorkspace } from "@/lib/store";
import { connectionFor, credentials } from "@/lib/connections";
import { validSignature } from "@/lib/providers/meta";
import { paymentEventReference } from "@/lib/providers/payments";
import { acceptPaymentEvent } from "@/lib/db/payment-inbox";
import { readLimitedText } from "@/lib/http";
import { AppError, assert } from "@/lib/errors";
import { productionDatabase } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    const { workspaceId } = await params; z.uuid().parse(workspaceId);
    const raw = await readLimitedText(request, 500_000);
    assert(productionDatabase(), "Hosted payment delivery requires PostgreSQL.", 503);
    const workspace = await loadWorkspace(workspaceId);
    // Demo delivery has no business effect and must never open live credentials.
    if (workspace.demo) return NextResponse.json({ received: true, ignored: true });
    const signature = request.headers.get("x-razorpay-signature") || "";
    if (!/^[a-f0-9]{64}$/.test(signature)) return new NextResponse("Invalid signature", { status: 403 });
    const secret = await credentials(workspace, "razorpay");
    assert(secret.webhookSecret, "Payment webhook signing is not configured.", 503);
    if (!validSignature(raw, signature, secret.webhookSecret, "")) return new NextResponse("Invalid signature", { status: 403 });
    const reference = paymentEventReference(JSON.parse(raw));
    if (!reference) return NextResponse.json({ received: true, ignored: true });
    return NextResponse.json(await acceptPaymentEvent(workspaceId, reference, raw, connectionFor(workspace, "razorpay")!, secret.keyId));
  } catch (error) {
    if (error instanceof AppError && error.status === 413) return NextResponse.json({ error: "Webhook body exceeds the byte limit." }, { status: 413 });
    if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof AppError && error.status === 400) return NextResponse.json({ error: "Malformed payment event." }, { status: 400 });
    return NextResponse.json({ error: "Payment event could not be saved. Retry delivery." }, { status: 503, headers: { "Retry-After": "30" } });
  }
}
