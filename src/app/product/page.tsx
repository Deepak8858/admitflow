import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
export const metadata: Metadata = { title: "Product — AdmitFlow", description: "Explore the enquiry, conversation and recovery workflow with interactive fictional examples.", robots: { index: true, follow: true } };
export default function Page() { return <MarketingPage page="product" />; }
