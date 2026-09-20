import type { Metadata } from "next";
import { MarketingPage } from "@/components/marketing/marketing";
export const metadata: Metadata = { title: "AdmitFlow — Good conversations. Great beginnings.", description: "Bring enquiries, counselling and thoughtful recovery into one workspace for your coaching team.", robots: { index: true, follow: true } };
export default function Page() { return <MarketingPage page="welcome" />; }
