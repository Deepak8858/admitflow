import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicLayout } from "@/components/marketing/marketing";
import { BuyerCta, BuyerHeader } from "@/components/public-content/buyer-content";
import { ResourceArticle } from "@/components/public-content/resource-articles";
import { buyerResources, formatResourceDate, getBuyerResource } from "@/lib/buyer-resources";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return buyerResources.map(({ slug }) => ({ slug }));
}

type ResourcePageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: ResourcePageProps): Promise<Metadata> {
  const resource = getBuyerResource((await params).slug);
  if (!resource) notFound();
  return publicPageMetadata(publicPage(`/resources/${resource.slug}`));
}

export default async function ResourcePage({ params }: ResourcePageProps) {
  const resource = getBuyerResource((await params).slug);
  if (!resource) notFound();
  const related = buyerResources.filter(({ slug }) => slug !== resource.slug);

  return (
    <PublicLayout pathname={`/resources/${resource.slug}`}>
      <div className="buyer-page">
        <BuyerHeader
          pathname={`/resources/${resource.slug}`}
          eyebrow={`Resource / ${resource.audience}`}
          title={resource.title}
          lead={resource.description}
          crumbs={[{ label: "Resources", href: "/resources" }, { label: resource.title }]}
        />
        <div className="buyer-resource-meta public-container">
          <span>Published <time dateTime={resource.publishedOn}>{formatResourceDate(resource.publishedOn)}</time></span>
          <span>{resource.readingMinutes} min read</span>
        </div>
        <article className="buyer-measure public-container">
          <ResourceArticle slug={resource.slug} />
        </article>
        <section className="buyer-section public-container" aria-label="Related reading">
          <div className="buyer-section-heading"><p className="buyer-eyebrow">Keep reading</p><h2>Related resources</h2></div>
          <div className="buyer-section-body buyer-related">
            {related.map((item) => <Link key={item.slug} href={`/resources/${item.slug}`}>{item.title} <span aria-hidden="true">→</span></Link>)}
          </div>
        </section>
        <BuyerCta title="Put the guidance to work.">Explore AdmitFlow&apos;s enquiry, follow-up and outcome workflow with your own pilot questions.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
