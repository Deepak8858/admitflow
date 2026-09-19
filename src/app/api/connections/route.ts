import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveWorkspace, requireAdmin } from "@/lib/auth";
import { readAction, apiError } from "@/lib/api";
import { saveConnection, validateConnectionCredentials, verifyProviderCredentials } from "@/lib/connections";
import { loadWorkspace, mutateWorkspace } from "@/lib/store";
import { assert } from "@/lib/errors";
import { graph, templates } from "@/lib/providers/meta";
import { publicWorkspace } from "@/lib/integrations";
import { createPaymentLink } from "@/lib/providers/payments";
import { appUrl, metaVersion } from "@/lib/config";
import { isoNow } from "@/lib/domain";
import { assertActor } from "@/lib/permissions";
import { readLimitedText } from "@/lib/http";
import { registerMetaLeadPage } from "@/lib/providers/meta-leads";

const serviceSchema = z.enum(["openai", "elevenlabs", "google", "razorpay", "whatsapp", "meta_leads"]);

export async function GET(request: NextRequest) {
  try {
    const context = await resolveWorkspace(request); requireAdmin(context);
    const workspace = await loadWorkspace(context.workspaceId);
    assertActor(workspace, context.actor);
    if (request.nextUrl.searchParams.get("type") === "templates") return NextResponse.json({ templates: workspace.demo ? [] : await templates(workspace) });
    return NextResponse.json({ connections: publicWorkspace(workspace, context.actor).connections });
  } catch (error) { return apiError(error); }
}
export async function POST(request: NextRequest) {
  try {
    const action = await readAction(request, 16000), context = await resolveWorkspace(request); requireAdmin(context);
    const workspace = await loadWorkspace(context.workspaceId);
    assertActor(workspace, context.actor);
    assert(!workspace.demo, "Create an institute workspace to connect live services.", 409);
    if (action.type === "disconnect") {
      const service = serviceSchema.parse(action.service);
      await mutateWorkspace(context.workspaceId, current => { current.connections = current.connections!.filter(item => item.service !== service); });
    } else if (action.type === "payment.link") {
      const input = z.object({ leadId: z.uuid(), amount: z.number().positive().max(10000000) }).parse(action);
      return NextResponse.json(await createPaymentLink(workspace, input.leadId, input.amount));
    } else if (action.type === "whatsapp.exchange") {
      const input = z.object({ code: z.string().min(1).max(3000), wabaId: z.string().regex(/^\d{1,80}$/), phoneNumberId: z.string().regex(/^\d{1,80}$/), coexistence: z.boolean() }).parse(action);
      assert(process.env.META_APP_SECRET && process.env.NEXT_PUBLIC_META_APP_ID, "Configure the Meta application first.", 503);
      const response = await fetch(`https://graph.facebook.com/${metaVersion()}/oauth/access_token`, { method: "POST", redirect: "error", body: new URLSearchParams({ client_id: process.env.NEXT_PUBLIC_META_APP_ID!, client_secret: process.env.META_APP_SECRET!, code: input.code }), signal: AbortSignal.timeout(20000) });
      const token = JSON.parse(await readLimitedText(response, 32000)); assert(response.ok && typeof token.access_token === "string", "Meta authorization failed. Restart connection setup.");
      const numbers = await graph<{ data: { id: string; display_phone_number: string; verified_name: string }[] }>(`${input.wabaId}/phone_numbers`, token.access_token);
      const number = numbers.data.find(item => item.id === input.phoneNumberId); assert(number, "The phone number does not belong to this authorized WhatsApp account.");
      const subscription = await graph<{ success?: boolean }>(`${input.wabaId}/subscribed_apps`, token.access_token, {});
      assert(subscription.success, "Meta did not confirm the WhatsApp webhook subscription.", 502);
      await saveConnection(context.workspaceId, "whatsapp", { accessToken: token.access_token }, number.id, number.display_phone_number, { wabaId: input.wabaId, name: number.verified_name, coexistence: input.coexistence ? "requested" : "standard", readiness: "credentials_verified", verifiedAt: isoNow() });
    } else if (action.type === "template.default") {
      const input = z.object({ name: z.string().max(100), language: z.string().max(20) }).parse(action);
      assert((await templates(workspace)).some(item => item.name === input.name && item.language === input.language && item.status === "APPROVED"), "Choose an approved template.");
      await mutateWorkspace(context.workspaceId, current => { const connection = current.connections!.find(item => item.service === "whatsapp")!; connection.metadata.templateName = input.name; connection.metadata.templateLanguage = input.language; });
    } else {
      const input = z.object({ service: z.enum(["openai", "elevenlabs", "razorpay", "whatsapp", "meta_leads"]), secret: z.record(z.string(), z.string().max(5000)), externalId: z.string().max(100).optional(), label: z.string().max(100).optional(), metadata: z.record(z.string(), z.string().max(200)).optional() }).parse(action);
      const externalId = input.externalId || context.workspaceId;
      validateConnectionCredentials(input.service, input.secret, externalId, input.metadata);
      if (input.service === "whatsapp") {
        assert(input.externalId && input.metadata?.wabaId, "Enter the WhatsApp phone-number ID and Business Account ID.");
        const result = await graph<{ data: { id: string }[] }>(`${input.metadata.wabaId}/phone_numbers`, input.secret.accessToken);
        assert(result.data.some(item => item.id === input.externalId), "This token cannot access that WhatsApp number.");
        const subscription = await graph<{ success?: boolean }>(`${input.metadata.wabaId}/subscribed_apps`, input.secret.accessToken, {});
        assert(subscription.success, "Meta did not confirm the WhatsApp webhook subscription.", 502);
        await saveConnection(context.workspaceId, input.service, input.secret, externalId, input.label || input.service, { wabaId: input.metadata.wabaId, coexistence: input.metadata.coexistence === "requested" ? "requested" : "standard", readiness: "credentials_verified", verifiedAt: isoNow() });
      } else if (input.service === "meta_leads") {
        await registerMetaLeadPage(context.workspaceId, { pageId: externalId, accessToken: input.secret.accessToken });
      } else {
        const verified = await verifyProviderCredentials(workspace, input.service, input.secret);
        await saveConnection(context.workspaceId, input.service, input.secret, externalId, input.label || input.service, verified);
      }
    }
    const webhookPath = action.service === "meta_leads" ? "/api/webhooks/meta-leads" : action.service === "razorpay" ? `/api/webhooks/razorpay/${context.workspaceId}` : "/api/webhooks/whatsapp";
    return NextResponse.json({ workspace: publicWorkspace(await loadWorkspace(context.workspaceId), context.actor), webhookUrl: `${appUrl()}${webhookPath}` });
  } catch (error) { return apiError(error); }
}
