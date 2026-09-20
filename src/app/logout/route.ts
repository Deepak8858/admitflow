import { NextRequest, NextResponse } from "next/server";
import { signOut } from "@workos-inc/authkit-nextjs";
import { appUrl, productionDatabase, workosConfigured } from "@/lib/config";
import { endSession } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (productionDatabase() && workosConfigured()) {
    // AuthKit clears its cookies and throws Next's redirect to the WorkOS end-session URL.
    // It must not be caught and converted into an API error or returned as JSON.
    await signOut({ returnTo: `${appUrl()}/onboarding` });
  }
  const token = request.cookies.get("admitflow_session")?.value;
  if (token) endSession(token);
  const response = NextResponse.redirect(`${appUrl()}/settings`);
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set("admitflow_session", "", { path: "/", httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", maxAge: 0 });
  return response;
}
