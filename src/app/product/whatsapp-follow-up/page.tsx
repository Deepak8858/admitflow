import type { Metadata } from "next";
import Link from "next/link";
import { PublicLayout } from "@/components/marketing/marketing";
import { StructuredData, softwareSchema } from "@/components/marketing/structured-data";
import { BuyerCta, BuyerCard, BuyerCardGrid, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata(publicPage("/product/whatsapp-follow-up"));

export default function WhatsappFollowUpPage() {
  return (
    <PublicLayout pathname="/product/whatsapp-follow-up">
      <div className="buyer-page">
        <StructuredData data={softwareSchema()} />
        <BuyerHeader
          pathname="/product/whatsapp-follow-up"
          eyebrow="Product / WhatsApp follow-up"
          title="Follow up on WhatsApp with permission and a person in control."
          lead="AdmitFlow brings eligible admissions enquiries into a reviewed follow-up workflow. Teams can select an approved message template, see replies in context and hand a conversation to a counsellor."
          crumbs={[{ label: "Product", href: "/product" }, { label: "WhatsApp follow-up" }]}
        />
        <BuyerSection eyebrow="Eligibility" title="Which enquiries can receive outreach?">
          <p>AdmitFlow needs a recorded opt-in before an enquiry enters an outbound WhatsApp follow-up. Unknown or opted-out consent blocks sending. A lead marked as a minor also needs recorded guardian consent. A reply does not become blanket permission for later campaigns.</p>
          <p>The recovery queue looks for open enquiries without contact for at least seven days, then shows eligible leads for review. Staff can choose the audience and approved template before a campaign is created. Closed admissions stages and human-owned conversations are excluded; staff can explicitly enable AI again for a lead they want to return to recovery.</p>
          <div className="buyer-note"><p>Live sends require a connected WhatsApp Business account, provider permissions, a subscribed app and an approved template. Demo actions simulate the workflow and do not contact a lead. Provider acceptance is separate from delivered or read status.</p></div>
        </BuyerSection>
        <BuyerSection eyebrow="Steps" title="A practical follow-up sequence">
          <ol>
            <li><strong>Bring in the enquiry.</strong> Create a lead, review a mapped CSV import or use a connected Meta Lead Ads page. A new Lead Ads record does not automatically carry WhatsApp permission.</li>
            <li><strong>Check consent and ownership.</strong> Record the source of an opt-in, review guardian consent where relevant, and assign a counsellor.</li>
            <li><strong>Review a template and audience.</strong> Use an approved Meta template when initiating a conversation or messaging outside the customer-service window.</li>
            <li><strong>Handle the response.</strong> Within the WhatsApp reply window, a team may respond to an inbound message. Outside it, the sending path requires an approved template.</li>
            <li><strong>Stop when the context changes.</strong> A reply, booking, opt-out or counsellor takeover stops the automated sequence.</li>
          </ol>
        </BuyerSection>
        <BuyerSection eyebrow="Control" title="Choose how AI participates">
          <BuyerCardGrid>
            <BuyerCard title="Assisted">
              <p>Use AI help in a review-led workflow so staff decide what to send.</p>
            </BuyerCard>
            <BuyerCard title="Autonomous">
              <p>Allow eligible replies under the configured mode and safeguards. Monitor the conversation and take over when needed.</p>
            </BuyerCard>
            <BuyerCard title="Paused">
              <p>Pause automated AI replies while counsellors continue working the lead.</p>
            </BuyerCard>
            <BuyerCard title="Human takeover">
              <p>Mark a conversation as human-owned to stop automated follow-up and put a counsellor in charge.</p>
            </BuyerCard>
          </BuyerCardGrid>
          <p style={{ marginTop: 20 }}>The message-count limit is a count control, not a spend limit. Outcomes should be reviewed with the <Link href="/product/admissions-recovery">admissions recovery workflow</Link>, rather than inferred from send counts.</p>
        </BuyerSection>
        <BuyerSection eyebrow="More detail" title="Prepare your team before live sends">
          <p>Use the <Link href="/resources/coaching-admissions-follow-up-checklist">admissions follow-up checklist</Link> to check ownership, permission and stop conditions. For provider or data-handling questions, read the <Link href="/security">security scope</Link> or <Link href="/contact">email AdmitFlow</Link>.</p>
        </BuyerSection>
        <BuyerCta title="Review your follow-up workflow.">Explore lead eligibility, templates and counsellor control in an AdmitFlow workspace.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
