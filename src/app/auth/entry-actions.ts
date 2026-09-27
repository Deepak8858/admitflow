"use server";

import { getSignInUrl, getSignUpUrl } from "@workos-inc/authkit-nextjs";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { appUrl, productionDatabase, workosConfigured } from "@/lib/config";
import type { AuthEntryMode, AuthEntryState } from "@/lib/auth-entry";
import { safeErrorDiagnostic } from "@/lib/errors";

const emailAddress = z.string().trim().max(254).email();

async function startAuthentication(mode: AuthEntryMode, formData: FormData): Promise<AuthEntryState> {
  // Use the configured public origin, never a forwarded/container host or a submitted return URL.
  const origin = (await headers()).get("origin");
  if (origin !== new URL(appUrl()).origin) {
    return { error: "This request could not be verified. Refresh the page and try again." };
  }

  const submitted = formData.getAll("email");
  const parsed = submitted.length === 1 ? emailAddress.safeParse(submitted[0]) : undefined;
  if (!parsed?.success) {
    const email = typeof submitted[0] === "string" && submitted[0].length <= 254 ? submitted[0] : "";
    return { email, fieldError: "Enter a valid email address." };
  }
  const email = parsed.data;
  if (!productionDatabase() || !workosConfigured()) {
    return { email, error: "Account access is temporarily unavailable. Please try again later." };
  }

  let destination: string;
  try {
    const options = { loginHint: email, returnTo: "/onboarding", redirectUri: `${appUrl()}/callback` };
    // AuthKit creates the PKCE cookie here, within the server action's writable cookie context.
    destination = await (mode === "signup" ? getSignUpUrl(options) : getSignInUrl(options));
  } catch (error) {
    console.error("Account access could not start", safeErrorDiagnostic(error));
    return { email, error: "We couldn’t connect to secure sign-in. Please try again." };
  }
  // Next's redirect is control flow; do not catch it as an authentication failure.
  redirect(destination);
}

export async function startSignup(_previous: AuthEntryState, formData: FormData): Promise<AuthEntryState> {
  return startAuthentication("signup", formData);
}

export async function startSignin(_previous: AuthEntryState, formData: FormData): Promise<AuthEntryState> {
  return startAuthentication("login", formData);
}
