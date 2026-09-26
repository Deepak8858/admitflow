import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
import { appUrl } from "@/lib/config";

const publicBaseUrl = process.env.APP_BASE_URL?.startsWith("https://") ? appUrl() : null;
export const metadata: Metadata = {
  title: "Getting started — AdmitFlow",
  description: "A short guide to bringing enquiries, institute knowledge, WhatsApp follow-up, counselling and receipt references into one admissions workflow.",
  robots: { index: true, follow: true },
  ...(publicBaseUrl ? { alternates: { canonical: `${publicBaseUrl}/help` } } : {}),
};

export default function Page() { return <MarketingPage page="help" />; }
