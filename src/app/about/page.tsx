import type { Metadata } from "next";
import Link from "next/link";
import { PublicLayout } from "@/components/marketing/marketing";
import { StructuredData, organizationSchema } from "@/components/marketing/structured-data";
import { BuyerCta, BuyerCard, BuyerCardGrid, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata(publicPage("/about"));

export default function AboutPage() {
  return (
    <PublicLayout pathname="/about">
      <div className="buyer-page">
        <StructuredData data={organizationSchema()} />
        <BuyerHeader
          pathname="/about"
          eyebrow="About AdmitFlow"
          title="Make every admissions enquiry easier to follow through."
          lead="AdmitFlow is an admissions workspace for coaching institutes. It brings enquiries, counsellor ownership, follow-up and recorded outcomes into one workflow so teams can see what needs attention."
          crumbs={[{ label: "About" }]}
          note="AdmitFlow is being prepared for pilot use. This page describes the product and its current scope, not a record of customer results."
        />
        <BuyerSection eyebrow="Purpose" title="Why AdmitFlow exists">
          <p>Admissions work often spans incoming leads, calls, WhatsApp conversations, counselling appointments and payment records. When those steps sit apart, a team can lose the context needed to follow up responsibly. AdmitFlow is designed to make the next action and its owner visible.</p>
          <p>The product combines a fixed admissions pipeline with lead notes and activity, follow-up queues, conversation controls and outcome records. It helps staff coordinate; it does not decide whether a student should enrol.</p>
        </BuyerSection>
        <BuyerSection eyebrow="The workflow" title="What a team can do">
          <BuyerCardGrid>
            <BuyerCard title="Organise enquiries">
              <p>Enter leads manually, review a mapped CSV import, or connect a supported Meta Lead Ads page. Each enquiry can have a stage, owner, source and consent state.</p>
            </BuyerCard>
            <BuyerCard title="Work the next follow-up">
              <p>Review stale, eligible enquiries before sending a WhatsApp template. Reply handling can be assisted, autonomous or paused, with a counsellor able to take over.</p>
            </BuyerCard>
            <BuyerCard title="Connect counselling">
              <p>Track a booking in the admissions record. The optional Google Calendar connection sends AdmitFlow bookings to one institute calendar; calendar availability is advisory.</p>
            </BuyerCard>
            <BuyerCard title="Read outcomes carefully">
              <p>Record admission stages, receipts and refunds against leads. These records support a pilot review, but a receipt alone does not establish that follow-up caused the admission.</p>
            </BuyerCard>
          </BuyerCardGrid>
        </BuyerSection>
        <BuyerSection eyebrow="Current stage" title="Built for a measured pilot">
          <p>AdmitFlow is at a pilot preparation stage. A useful first rollout starts with a defined set of enquiries, clear consent records, a counsellor owner and a baseline to compare follow-up activity and outcomes. Live WhatsApp use also needs an eligible connected business account and approved templates.</p>
          <p>For the operational details, read the <Link href="/product/admissions-recovery">admissions recovery workflow</Link>, the <Link href="/product/whatsapp-follow-up">WhatsApp follow-up requirements</Link> and the <Link href="/security">security scope</Link>.</p>
        </BuyerSection>
        <BuyerCta title="See if the workflow fits your team.">Create a workspace to explore AdmitFlow, or <Link href="/contact">email us about a pilot</Link> with your intake and follow-up questions.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
