import type { NextRequest, NextFetchEvent } from "next/server";
import { NextResponse } from "next/server";
import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { isPublicRoute } from "@/lib/public-routes";
import { workspacePage } from "@/lib/workspace-routes";

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  const pathname = request.nextUrl.pathname;
  // Check the bounded published path first, so stale session cookies cannot
  // turn public pages or crawler assets into hosted sign-in responses.
  if (isPublicRoute(pathname)) return NextResponse.next();
  // Let Next serve a real 404 for unknown page paths. The catch-all workspace
  // layout accepts only the explicit workspace route names as well.
  if (
    pathname !== "/api" &&
    !pathname.startsWith("/api/") &&
    pathname !== "/callback" &&
    pathname !== "/onboarding" &&
    !workspacePage(pathname.slice(1).split("/"))
  ) return NextResponse.next();
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID || !process.env.DATABASE_URL) return NextResponse.next();
  return authkitMiddleware()(request, event);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|media/|api/webhooks|api/jobs|api/health).*)"] };
