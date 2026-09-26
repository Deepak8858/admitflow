import type { Metadata } from "next";
import { AccountEntry } from "@/components/account-entry";
import { productionDatabase, workosConfigured } from "@/lib/config";
import { startSignin } from "@/app/auth/entry-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in — AdmitFlow", robots: { index: false, follow: false } };

export default function LoginPage() {
  const hosted = productionDatabase();
  return <AccountEntry mode="login" configured={hosted && workosConfigured()} localPreview={!hosted} action={startSignin} />;
}
