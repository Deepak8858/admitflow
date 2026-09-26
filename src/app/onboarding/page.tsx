import type { Metadata } from "next";
import { Onboarding } from "@/components/onboarding";
import { productionDatabase, workosConfigured } from "@/lib/config";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose your institute — AdmitFlow" };
export default function OnboardingPage() {
  const configured = productionDatabase() && workosConfigured();
  const content = <Onboarding configured={configured} />;
  return configured ? <AuthKitProvider>{content}</AuthKitProvider> : content;
}
