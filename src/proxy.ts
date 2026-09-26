import type { NextRequest, NextFetchEvent } from "next/server";
import { NextResponse } from "next/server";
import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // Marketing and recovery pages are available even when an old session cannot refresh.
  if (["/", "/welcome", "/product", "/pricing", "/help", "/signup", "/login", "/auth/error"].includes(request.nextUrl.pathname)) return NextResponse.next();
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID || !process.env.DATABASE_URL) return NextResponse.next();
  return authkitMiddleware()(request, event);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|media/|api/webhooks|api/jobs|api/health).*)"] };
