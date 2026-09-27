import type { Metadata } from "next";
import { AccountEntry } from "@/components/account-entry";
import { productionDatabase, workosConfigured } from "@/lib/config";
import { startSignup } from "@/app/auth/entry-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create your account — AdmitFlow", robots: { index: false, follow: false } };

export default function SignupPage() {
  const hosted = productionDatabase();
  return <AccountEntry mode="signup" configured={hosted && workosConfigured()} localPreview={!hosted} action={startSignup} />;
}
