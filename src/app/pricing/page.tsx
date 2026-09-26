import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
import { appUrl } from "@/lib/config";
const publicBaseUrl = process.env.APP_BASE_URL?.startsWith("https://") ? appUrl() : null;
export const metadata: Metadata = { title: "Pricing availability — AdmitFlow", description: "Public pricing is being finalised. Explore AdmitFlow product capabilities and find existing workspace billing.", robots: { index: true, follow: true }, ...(publicBaseUrl ? { alternates: { canonical: `${publicBaseUrl}/pricing` } } : {}) };
export default function Page() { return <MarketingPage page="pricing" />; }
