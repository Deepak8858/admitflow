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
          title="Talk to AdmitFlow about your admissions workflow."
          lead="Email us about a pilot, product or workspace question. Tell us enough about your workflow to make a useful reply possible."
          crumbs={[{ label: "Contact" }]}
        />
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
