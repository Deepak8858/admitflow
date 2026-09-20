import { getSignInUrl } from "@workos-inc/authkit-nextjs";
import { NextResponse } from "next/server";
import { workosConfigured, appUrl } from "@/lib/config";
export async function GET() {
  if (!workosConfigured()) return NextResponse.redirect(`${appUrl()}/settings?setup=workos`);
  return NextResponse.redirect(await getSignInUrl());
}
