import { MarketingPage } from "@/components/marketing/marketing";
import { StructuredData, organizationSchema, softwareSchema, websiteSchema } from "@/components/marketing/structured-data";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata = publicPageMetadata(publicPage("/"));

export default function Page() {
  return <>
    <StructuredData data={[organizationSchema(), websiteSchema(), softwareSchema()]} />
    <MarketingPage page="welcome" />
  </>;
}
