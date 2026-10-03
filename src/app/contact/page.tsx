import type { Metadata } from "next";
import { PublicLayout } from "@/components/marketing/marketing";
import { StructuredData, organizationSchema } from "@/components/marketing/structured-data";
import { BuyerCta, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

const email = "support@admitflow.incfrog.ai";

export const metadata: Metadata = publicPageMetadata(publicPage("/contact"));

export default function ContactPage() {
  return (
    <PublicLayout pathname="/contact">
      <div className="buyer-page">
        <StructuredData data={organizationSchema()} />
        <BuyerHeader
          pathname="/contact"
          eyebrow="Contact"
          title="Start with your admissions follow-up workflow."
          lead="Tell us where enquiries lose momentum. We will use your workflow and setup requirements to discuss whether a scoped AdmitFlow pilot fits your team."
          crumbs={[{ label: "Contact" }]}
        />
        <BuyerSection eyebrow="Pilot fit" title="One team. One enquiry group. Clear outcomes.">
          <p>A useful starting point is a coaching team with existing enquiries, named counsellors and a follow-up process it wants to improve. Review the current product before importing any student information.</p>
          <ol>
            <li><strong>Map the handoffs.</strong> Explain how enquiries arrive, who owns the next action and where follow-ups are missed.</li>
            <li><strong>Agree the scope.</strong> Define the enquiry group, team, duration, connected services, fees and support responsibilities before the pilot starts.</li>
            <li><strong>Measure separately.</strong> Review replies, counselling bookings, attendance and recorded admissions. A recorded admission alone does not prove additional revenue caused by the pilot.</li>
          </ol>
          <p>Use fictional records for the initial walkthrough. Live WhatsApp work requires the institute’s eligible account, contact permissions and any required approved templates.</p>
        </BuyerSection>
        <BuyerSection eyebrow="Email" title="Choose the right starting point">
          <h3>Pilot or product enquiry</h3>
          <p><a href={`mailto:${email}`} data-af-event="primary_cta_click" data-af-cta="pilot_email" data-af-placement="body">Email about a pilot</a>. It helps to include your institute name, the way enquiries arrive, approximate follow-up volume and the part of the admissions process you want to improve. Please do not send student records or provider credentials in the first email.</p>
          <h3>Workspace or support question</h3>
          <p><a href={`mailto:${email}`} data-af-event="primary_cta_click" data-af-cta="support_email" data-af-placement="body">Email support</a>. Include the workspace issue and steps to reproduce it, without passwords, access tokens or unnecessary student details.</p>
          <p className="buyer-note">Both links open your email app and address a message to <strong>{email}</strong>.</p>
        </BuyerSection>
        <BuyerCta title="Prefer to explore first?">Create a workspace and review the enquiry, follow-up and outcome workflow.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
