import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
import { appUrl } from "@/lib/config";
const publicBaseUrl = process.env.APP_BASE_URL?.startsWith("https://") ? appUrl() : null;
export const metadata: Metadata = { title: "Product — AdmitFlow", description: "Explore the enquiry, conversation and recovery workflow with interactive fictional examples.", robots: { index: true, follow: true }, ...(publicBaseUrl ? { alternates: { canonical: `${publicBaseUrl}/product` } } : {}) };
export default function Page() { return <MarketingPage page="product" />; }
