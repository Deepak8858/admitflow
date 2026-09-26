import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
import { appUrl } from "@/lib/config";
const publicBaseUrl = process.env.APP_BASE_URL?.startsWith("https://") ? appUrl() : null;
export const metadata: Metadata = { title: "AdmitFlow — Good conversations. Great beginnings.", description: "Bring enquiries, counselling and thoughtful recovery into one workspace for your coaching team.", robots: { index: true, follow: true }, ...(publicBaseUrl ? { alternates: { canonical: `${publicBaseUrl}/` } } : {}) };
export default function Page() { return <MarketingPage page="welcome" />; }
