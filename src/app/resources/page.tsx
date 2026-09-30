import type { Metadata } from "next";
import Link from "next/link";
import { PublicLayout } from "@/components/marketing/marketing";
import { BuyerCta, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { buyerResources } from "@/lib/buyer-resources";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata(publicPage("/resources"));

export default function ResourcesPage() {
  return (
    <PublicLayout pathname="/resources">
      <div className="buyer-page">
        <BuyerHeader
          pathname="/resources"
          eyebrow="Resources"
          title="Practical guides for a clearer admissions process."
          lead="Use these resources to audit follow-up work, compare software against your requirements and measure a pilot without confusing activity with impact."
          crumbs={[{ label: "Resources" }]}
        />
        <BuyerSection eyebrow="Start where you are" title="Three decisions, three tools">
          <div className="buyer-card-grid">
            {buyerResources.map((resource) => (
              <article className="buyer-card" key={resource.slug}>
                <p className="buyer-eyebrow">{resource.audience}</p>
                <h3><Link href={`/resources/${resource.slug}`}>{resource.title}</Link></h3>
                <p>{resource.summary}</p>
                <p className="buyer-resource-meta"><span>{resource.readingMinutes} min read</span><span>29 September 2026</span></p>
                <Link className="buyer-text-link" href={`/resources/${resource.slug}`}>Read resource <span aria-hidden="true">→</span></Link>
              </article>
            ))}
          </div>
        </BuyerSection>
        <BuyerSection eyebrow="Use with the product" title="Connect the questions to a workflow">
          <p>The <Link href="/product/whatsapp-follow-up">WhatsApp follow-up page</Link> explains the consent, template and reply requirements behind outreach. The <Link href="/product/admissions-recovery">admissions recovery page</Link> shows how the queue, staff review, bookings and recorded outcomes fit together.</p>
          <p>These guides are operating aids, not a claim that a particular result will follow. Set your own baseline and verify that your provider and data setup are ready before live messaging.</p>
        </BuyerSection>
        <BuyerCta title="Turn a checklist into a pilot.">Explore the workspace, then choose a small cohort and a measurable follow-up gap.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
