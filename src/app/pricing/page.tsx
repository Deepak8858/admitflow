import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
export const metadata: Metadata = { title: "Pricing availability — AdmitFlow", description: "Public pricing is being finalised. Explore AdmitFlow product capabilities and find existing workspace billing.", robots: { index: true, follow: true } };
export default function Page() { return <MarketingPage page="pricing" />; }
