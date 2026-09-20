import type { NextRequest, NextFetchEvent } from "next/server";
import { NextResponse } from "next/server";
import { authkitMiddleware } from "@workos-inc/authkit-nextjs";

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!process.env.WORKOS_API_KEY || !process.env.WORKOS_CLIENT_ID || !process.env.DATABASE_URL) return NextResponse.next();
  return authkitMiddleware()(request, event);
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|api/webhooks|api/jobs|api/health).*)"] };
