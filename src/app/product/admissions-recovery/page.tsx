import type { Metadata } from "next";
import Link from "next/link";
import { PublicLayout } from "@/components/marketing/marketing";
import { StructuredData, softwareSchema } from "@/components/marketing/structured-data";
import { BuyerCta, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata(publicPage("/product/admissions-recovery"));

export default function AdmissionsRecoveryPage() {
  return (
    <PublicLayout pathname="/product/admissions-recovery">
      <div className="buyer-page">
        <StructuredData data={softwareSchema()} />
        <BuyerHeader
          pathname="/product/admissions-recovery"
          eyebrow="Product / Admissions recovery"
          title="Bring missed enquiries back into a managed admissions workflow."
          lead="AdmitFlow helps coaching teams find open leads that have gone without contact, review which ones are eligible to follow up, and connect staff activity to recorded admissions outcomes."
          crumbs={[{ label: "Product", href: "/product" }, { label: "Admissions recovery" }]}
        />
        <BuyerSection eyebrow="The queue" title="Start with a specific follow-up gap">
          <p>An open lead becomes stale in AdmitFlow when at least seven days have passed since the last contact, or since creation if there has been no contact. The recovery workflow filters that queue for eligible leads and leaves the audience and message template for staff review. Opted-out, unknown-consent, marked-minor-without-guardian-consent, closed-stage and human-owned cases are excluded. Staff can explicitly enable AI to return a human-owned conversation to recovery when appropriate.</p>
          <p>The eight fixed stages are New, Contacted, Qualified, Counselling, Demo, Negotiation, Admitted and Lost. A team can use notes, ownership and activity alongside the stages rather than treating a stage as proof of a payment or an outcome.</p>
        </BuyerSection>
        <BuyerSection eyebrow="From intake to outcome" title="What a pilot can actually track">
          <ol>
            <li><strong>Establish the starting list.</strong> Create enquiries manually, review a mapped CSV import of up to 1,000 rows at a time, or connect a supported Meta Lead Ads page. Imported names and phone numbers are required; duplicate phone entries are skipped. New Lead Ads records begin with unknown WhatsApp permission unless it is separately established.</li>
            <li><strong>Assign and review.</strong> Check source, consent, last contact and counsellor ownership. Decide which eligible records should receive a follow-up.</li>
            <li><strong>Run a controlled follow-up.</strong> Choose an approved template for WhatsApp outreach and stop automation after a reply, booking, opt-out or takeover. <Link href="/product/whatsapp-follow-up">See WhatsApp requirements</Link>.</li>
            <li><strong>Log counselling and admission work.</strong> Track conversations and bookings. Optional Google Calendar syncing sends AdmitFlow bookings to one institute calendar; it does not read availability back as a guaranteed free slot.</li>
            <li><strong>Record outcomes.</strong> Log admission status, receipts and refunds against the lead, with the reference and campaign association where available.</li>
          </ol>
        </BuyerSection>
        <BuyerSection eyebrow="Measurement" title="Separate activity, outcomes and attribution">
          <div className="buyer-table-scroll" tabIndex={0} role="region" aria-labelledby="admissions-measures-caption"><table className="buyer-table">
            <caption id="admissions-measures-caption">What each admissions measure means</caption>
            <thead><tr><th>Measure</th><th>What AdmitFlow records</th><th>How to read it</th></tr></thead>
            <tbody>
              <tr><td>Follow-up activity</td><td>Outreach, replies, ownership and bookings</td><td>Evidence that steps were taken, not evidence that they caused enrolment.</td></tr>
              <tr><td>Admissions outcome</td><td>A lead at Admitted or Lost</td><td>A pipeline state that staff should reconcile against real records.</td></tr>
              <tr><td>Money recorded</td><td>Receipts and separate refunds linked to a lead</td><td>Recorded cash events, not a calculated incremental return.</td></tr>
            </tbody>
          </table></div>
          <p>For a credible pilot, decide the cohort and baseline in advance, check source completeness and compare like periods. The <Link href="/resources/measuring-admissions-recovery-pilot">pilot measurement resource</Link> gives a worked example with clearly fictional numbers.</p>
        </BuyerSection>
        <BuyerCta title="Define a small recovery pilot.">Start with a lead cohort, named counsellors, consent records and a baseline you can audit.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
