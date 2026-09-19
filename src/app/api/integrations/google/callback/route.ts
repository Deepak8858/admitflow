import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, resolveWorkspace } from "@/lib/auth";
import { appUrl } from "@/lib/config";
import { credentials, saveConnection } from "@/lib/connections";
import { loadWorkspace } from "@/lib/store";
import { assert } from "@/lib/errors";
import { googleConfiguration, verifyGoogleState, GOOGLE_SCOPES, GOOGLE_STATE_COOKIE, GOOGLE_STATE_PATH } from "../oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let outcome = "error";
  try {
    const context = await resolveWorkspace(request); requireAdmin(context);
    const verifier = verifyGoogleState(request.nextUrl.searchParams.get("state") || "", request.cookies.get(GOOGLE_STATE_COOKIE)?.value, context);
    if (request.nextUrl.searchParams.get("error") === "access_denied") outcome = "cancelled";
    else {
      assert(!request.nextUrl.searchParams.has("error"), "Google did not authorize the connection.", 400);
      const code = z.string().min(1).max(4000).parse(request.nextUrl.searchParams.get("code"));
      const config = googleConfiguration();
      const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: "authorization_code", code, code_verifier: verifier }), signal: AbortSignal.timeout(20000), cache: "no-store", redirect: "error" });
      assert(response.ok, "Google authorization could not be completed. Reconnect the calendar.", 502);
      const tokens = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), scope: z.string().optional() }).parse(await response.json());
      if (tokens.scope) assert(GOOGLE_SCOPES.filter(scope => scope.startsWith("https://www.googleapis.com/auth/calendar.")).every(scope => tokens.scope!.split(" ").includes(scope)), "Grant calendar and availability access to complete setup.", 400);
      const identityResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
      assert(identityResponse.ok, "Google account identity could not be verified.", 502);
      const identity = z.object({ sub: z.string().min(1).max(200), email: z.email().optional() }).parse(await identityResponse.json());
      let refreshToken = tokens.refresh_token;
      const workspace = await loadWorkspace(context.workspaceId);
      // Google may omit a new refresh token on reauthorization. Never reuse one from a different account.
      if (!refreshToken && workspace.connections?.some(item => item.service === "google" && item.externalId === identity.sub && item.status === "connected")) refreshToken = (await credentials(workspace, "google")).refreshToken;
      assert(refreshToken, "Google did not grant offline access. Revoke AdmitFlow in Google account permissions, then reconnect.", 409);
      const currentContext = await resolveWorkspace(request); requireAdmin(currentContext);
      assert(currentContext.workspaceId === context.workspaceId && currentContext.actor.id === context.actor.id, "Your institute session changed during Google setup.", 403);
      await saveConnection(context.workspaceId, "google", { refreshToken }, identity.sub, identity.email || "Google Calendar", { calendarId: "primary" });
      outcome = "connected";
    }
  } catch {
    // Never put provider tokens, authorization codes or raw provider errors in a redirect or log.
    outcome = "error";
  }
  const response = NextResponse.redirect(`${appUrl()}/integrations?google=${outcome}`);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.cookies.set(GOOGLE_STATE_COOKIE, "", { path: GOOGLE_STATE_PATH, httpOnly: true, sameSite: "lax", secure: appUrl().startsWith("https:"), maxAge: 0 });
  return response;
}
