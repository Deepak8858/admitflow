import { handleAuth } from "@workos-inc/authkit-nextjs";
import type { NextRequest } from "next/server";
import { appUrl } from "@/lib/config";

export async function GET(request: NextRequest) {
  return handleAuth({ returnPathname: "/onboarding", baseURL: appUrl() })(request);
}
