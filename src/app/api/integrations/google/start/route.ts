import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, resolveWorkspace } from "@/lib/auth";
import { apiError } from "@/lib/api";
import { loadWorkspace } from "@/lib/store";
import { sameOrigin } from "@/lib/http";
import { assert } from "@/lib/errors";
import { createGoogleState, googleConfiguration, GOOGLE_SCOPES, GOOGLE_STATE_COOKIE, GOOGLE_STATE_PATH, GOOGLE_STATE_SECONDS } from "../oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    assert(sameOrigin(request), "Start Google setup from your institute's Integrations page.", 403);
    const context = await resolveWorkspace(request); requireAdmin(context);
    const workspace = await loadWorkspace(context.workspaceId);
    assert(!workspace.demo, "Demo workspaces cannot connect a live calendar.", 409);
    assert(!workspace.connections?.some(item => item.service === "google" && item.metadata.googleRevocation), "Finish disconnecting Google Calendar before reconnecting.", 409);
    const config = googleConfiguration(), proof = createGoogleState(context);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state: proof.state, code_challenge: proof.challenge, code_challenge_method: "S256" }).toString();
    const response = NextResponse.redirect(url);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(GOOGLE_STATE_COOKIE, proof.cookie, { httpOnly: true, secure: new URL(config.redirectUri).protocol === "https:", sameSite: "lax", path: GOOGLE_STATE_PATH, maxAge: GOOGLE_STATE_SECONDS });
    return response;
  } catch (error) { return apiError(error); }
}
