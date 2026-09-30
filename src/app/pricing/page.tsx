import { MarketingPage } from "@/components/marketing/marketing";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata = publicPageMetadata(publicPage("/pricing"));

export default function Page() { return <MarketingPage page="pricing" />; }
