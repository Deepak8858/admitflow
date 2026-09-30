import { publicUrl, PUBLIC_ORIGIN } from "@/lib/seo";

export type StructuredDataValue = Record<string, unknown> | readonly Record<string, unknown>[];
export type BreadcrumbItem = { name: string; pathname: string };

export function serializeStructuredData(data: StructuredDataValue): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function StructuredData({ data }: { data: StructuredDataValue }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeStructuredData(data) }} />;
}

export function websiteSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${PUBLIC_ORIGIN}/#website`,
    name: "AdmitFlow",
    url: `${PUBLIC_ORIGIN}/`,
  };
}

export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${PUBLIC_ORIGIN}/#organization`,
    name: "AdmitFlow",
    url: `${PUBLIC_ORIGIN}/`,
    email: "support@admitflow.incfrog.ai",
  };
}

export function softwareSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${PUBLIC_ORIGIN}/product#software`,
    name: "AdmitFlow",
    url: publicUrl("/product"),
    description: "An admissions workspace for coaching institutes to organize enquiries, follow-ups, counselling and admissions recovery.",
    applicationCategory: "BusinessApplication",
  };
}

export function breadcrumbSchema(items: readonly BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: publicUrl(item.pathname),
    })),
  };
}
