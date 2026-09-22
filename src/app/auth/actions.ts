"use server";

import { headers } from "next/headers";
import { signOut } from "@workos-inc/authkit-nextjs";
import { appUrl, productionDatabase, workosConfigured } from "@/lib/config";

export async function signOutAction() {
  if (!productionDatabase() || !workosConfigured()) throw new Error("Hosted sign-out is not configured.");
  const returnTo = `${appUrl()}/onboarding`;
  const origin = (await headers()).get("origin");
  // Require the browser's canonical Origin, even when Next's proxy host matches.
  if (!origin || origin !== new URL(returnTo).origin) throw new Error("Sign-out requires a same-origin request.");
  // AuthKit clears its cookies and throws Next's redirect; do not catch it.
  await signOut({ returnTo });
}
