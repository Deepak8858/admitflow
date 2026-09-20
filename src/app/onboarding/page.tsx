import type { Metadata } from "next";
import { Onboarding } from "@/components/onboarding";
import { productionDatabase, workosConfigured } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Choose your institute — AdmitFlow" };
export default function OnboardingPage() {
  return <Onboarding configured={productionDatabase() && workosConfigured()} />;
}
