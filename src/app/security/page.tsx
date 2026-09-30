import type { Metadata } from "next";
import Link from "next/link";
import { PublicLayout } from "@/components/marketing/marketing";
import { BuyerCta, BuyerHeader, BuyerSection } from "@/components/public-content/buyer-content";
import { publicPage } from "@/lib/public-content";
import { publicPageMetadata } from "@/lib/seo";

export const metadata: Metadata = publicPageMetadata(publicPage("/security"));

export default function SecurityPage() {
  return (
    <PublicLayout pathname="/security">
      <div className="buyer-page">
        <BuyerHeader
          pathname="/security"
          eyebrow="Security"
          title="Controls for admissions data, with a clear scope."
          lead="AdmitFlow handles lead and conversation information for institute teams. Its source includes organisation-scoped access checks, database tenant controls, private file storage and protected connection credentials."
          crumbs={[{ label: "Security" }]}
          note="These controls describe current implementation and the scope of checks completed so far. They are not a certification or a promise that every production integration has been independently verified."
        />
        <BuyerSection eyebrow="Access" title="Staff access follows the organisation and role">
          <p>Hosted staff sign-in uses WorkOS organisation membership. The application checks the active organisation before staff actions and applies owner, admin, counsellor and analyst permissions. Counsellor access is tied to assigned work; analyst views use a restricted projection rather than unrestricted operational actions.</p>
          <p>The PostgreSQL schema also uses row-level security and tenant-linked relationships. A read-only production check in the 27 September review verified that the sampled runtime connection used a non-superuser role with row security active for the organisations table. That check did not test every table or integration path.</p>
        </BuyerSection>
        <BuyerSection eyebrow="Connections and files" title="Keep provider access separate from lead records">
          <ul>
            <li>Connected-service secrets are encrypted in the application&apos;s provider-token storage path; the documented configuration supports a KMS context or an AES-GCM fallback.</li>
            <li>Uploaded objects are stored in private R2 storage and accessed through short-lived signed links. Staff permission checks govern the application path to those files.</li>
            <li>Meta Lead Ads and WhatsApp connections require their own provider setup and permissions. A configured connection is a prerequisite for live messaging, not proof that a message was delivered.</li>
          </ul>
        </BuyerSection>
        <BuyerSection eyebrow="Messaging safeguards" title="Consent and human control remain part of the workflow">
          <p>The application blocks outreach to an opted-out or unknown-consent lead, and requires guardian consent for a marked minor. Outside WhatsApp&apos;s customer-service reply window, the sending path requires an approved template. Replies and campaign sequences can stop when a person replies, books, opts out or a counsellor takes over.</p>
          <p>AI replies have autonomous, assisted and paused modes. The configured message-count guard limits a sequence by count; it is not a currency or model-spend cap. Staff should review the chosen mode and template before a live pilot. See the <Link href="/product/whatsapp-follow-up">WhatsApp follow-up guide</Link> for the operating requirements.</p>
        </BuyerSection>
        <BuyerSection eyebrow="Verification boundary" title="What is still being checked">
          <p>Checks so far include local tests for major access and provider paths and a limited production database-role check. Live provider compatibility, a full production access sweep, backup restoration and a complete data retention and erasure policy are not established by those checks.</p>
          <p>AdmitFlow does not claim a security certification here. For a specific data-handling or pilot question, <Link href="/contact">email AdmitFlow support</Link> with the workflow you plan to use.</p>
        </BuyerSection>
        <BuyerCta title="Plan the controls for your pilot.">Start with a defined team, assigned counsellors, consent records and a supported provider connection.</BuyerCta>
      </div>
    </PublicLayout>
  );
}
