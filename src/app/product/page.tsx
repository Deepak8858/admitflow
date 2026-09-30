import { MarketingPage } from "@/components/marketing/marketing";
import { StructuredData, softwareSchema } from "@/components/marketing/structured-data";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata = publicPageMetadata(publicPage("/product"));

export default function Page() {
  return <>
    <StructuredData data={softwareSchema()} />
    <MarketingPage page="product" />
  </>;
}
