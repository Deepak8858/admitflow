import Link from "next/link";
import type { BuyerResourceSlug } from "@/lib/buyer-resources";

export function ResourceArticle({ slug }: { slug: BuyerResourceSlug }) {
  switch (slug) {
    case "coaching-admissions-follow-up-checklist":
      return <FollowUpChecklist />;
    case "how-to-evaluate-an-admissions-crm":
      return <CrmEvaluation />;
    case "measuring-admissions-recovery-pilot":
      return <PilotMeasurement />;
  }
}

function FollowUpChecklist() {
  return (
    <>
      <p>A follow-up process is useful only if a counsellor can tell who owns each enquiry, whether contact is permitted and when to stop. Run this checklist on a small sample of real workflows before increasing volume. Keep the evidence in your own lead records rather than treating a message send as the end of the task.</p>

      <h2>1. Check what enters the queue</h2>
      <ul>
        <li><strong>Record the source.</strong> Can staff tell whether an enquiry was created manually, reviewed from a CSV or received from a connected lead form?</li>
        <li><strong>Check required details.</strong> Do name and phone number pass review? Are duplicate phone entries identified before import?</li>
        <li><strong>Do not assume consent.</strong> Is WhatsApp opt-in recorded with its source? A lead-form checkbox or a prior enquiry does not automatically establish permission for WhatsApp follow-up.</li>
        <li><strong>Identify minors.</strong> Is guardian consent recorded for an enquiry marked as a minor before outreach?</li>
        <li><strong>Assign one owner.</strong> Can a counsellor see which enquiry they are responsible for and its last meaningful contact?</li>
      </ul>
      <p>In AdmitFlow, a mapped CSV import supports up to 1,000 rows at a time, and the lead workflow has source, consent and owner fields. A connected Meta Lead Ads record begins with unknown WhatsApp permission unless the team establishes it separately.</p>

      <h2>2. Decide which lead needs a next action</h2>
      <p>Use a dated rule instead of a vague “old leads” list. AdmitFlow marks an open lead stale after at least seven days since its last contact, or since creation when no contact exists. A stale lead is a review candidate, not an automatic send instruction.</p>
      <div className="buyer-table-scroll" tabIndex={0} role="region" aria-labelledby="follow-up-table-caption">
        <table className="buyer-table">
          <caption id="follow-up-table-caption">Manager review before a follow-up</caption>
          <thead><tr><th>Check</th><th>Decision to record</th></tr></thead>
          <tbody>
            <tr><td>Stage and latest activity</td><td>Is the lead still open? What has the team already promised?</td></tr>
            <tr><td>Consent and guardian status</td><td>Is this channel permitted for this person?</td></tr>
            <tr><td>Ownership</td><td>Who will handle a reply or exception today?</td></tr>
            <tr><td>Message purpose</td><td>Is the approved template relevant to the enquiry?</td></tr>
            <tr><td>Exit condition</td><td>What ends the sequence, and who checks it?</td></tr>
          </tbody>
        </table>
      </div>

      <h2>3. Review the send and the response</h2>
      <ul>
        <li>Confirm the live WhatsApp Business connection and the approved Meta template before an outbound campaign. A demo action does not send a live message.</li>
        <li>Check the selected audience and template together. A template approval does not mean every lead is eligible.</li>
        <li>Route a reply to a named counsellor. Use AI in assisted, autonomous or paused mode according to the team&apos;s review policy, and allow human takeover.</li>
        <li>Stop automation on a reply, booking, opt-out or counsellor takeover. Recheck eligibility when consent or lead status changes.</li>
        <li>Keep provider acceptance, delivery, read and reply distinct. A sent count is not a conversation count.</li>
      </ul>
      <div className="buyer-note"><p><strong>Operating limit:</strong> WhatsApp customer-service replies and outbound templates have different rules. Outside the reply window, AdmitFlow&apos;s sending path requires an approved template. Read the <Link href="/product/whatsapp-follow-up">WhatsApp follow-up workflow</Link> before live outreach.</p></div>

      <h2>4. Review a weekly sample</h2>
      <p>Pick ten enquiries across new, stale, replied and closed stages. For each, check that source, consent, owner, next action and stop reason agree with what actually happened. Count missing records as process gaps. Then review bookings, admitted stages, receipts and refunds separately. Use the <Link href="/resources/measuring-admissions-recovery-pilot">pilot scorecard</Link> to compare periods without treating recorded revenue as causal recovery.</p>
    </>
  );
}

function CrmEvaluation() {
  return (
    <>
      <p>Choose an admissions CRM against the work your team has to perform, not only its feature list. Write down your current intake sources and follow-up rules, then ask every vendor to demonstrate the same enquiry from arrival through counsellor action and outcome review. Mark a requirement <strong>must have</strong>, <strong>useful</strong> or <strong>out of scope</strong> before the demonstration.</p>

      <h2>Use one test enquiry across the whole demo</h2>
      <p>Create a sample enquiry with a valid phone number, an owner, a source and unknown WhatsApp permission. Ask the vendor to show what happens when the lead becomes stale, opts out, replies, books a counselling session and reaches an admission outcome. Do not use a real student record for a sales demo.</p>

      <div className="buyer-table-scroll" tabIndex={0} role="region" aria-labelledby="crm-table-caption">
        <table className="buyer-table">
          <caption id="crm-table-caption">Admissions CRM requirements matrix</caption>
          <thead><tr><th>Requirement</th><th>Proof to request</th><th>AdmitFlow scope to compare</th></tr></thead>
          <tbody>
            <tr><td>Intake and deduplication</td><td>Import a small file with a duplicate and one invalid row. Show the preview and error path.</td><td>Manual leads, mapped CSV review up to 1,000 rows, duplicate-phone skips and connected Meta Lead Ads page intake.</td></tr>
            <tr><td>Permission record</td><td>Show the channel-specific opt-in source and the effect of unknown, opted-out and minor status.</td><td>WhatsApp eligibility blocks unknown/opted-out consent and marked minors without guardian consent.</td></tr>
            <tr><td>Ownership and stages</td><td>Assign a counsellor and move the sample through each usable stage.</td><td>Owner assignment and eight fixed stages: New, Contacted, Qualified, Counselling, Demo, Negotiation, Admitted, Lost.</td></tr>
            <tr><td>Follow-up review</td><td>Show the stale rule, selected audience, template and how a manager cancels an inappropriate send.</td><td>Seven-day stale rule and audience/template review before a campaign. Human-owned leads stay out until staff explicitly enables AI again.</td></tr>
            <tr><td>Replies and takeover</td><td>Trigger a reply, opt-out and staff takeover. Show the audit trail and stop behaviour.</td><td>Assisted, autonomous and paused AI modes; automation stops on reply, booking, opt-out or human takeover.</td></tr>
            <tr><td>Calendar connection</td><td>Ask which direction sync works, which calendar is used and what happens on a failed sync.</td><td>Optional one-way booking sync to one Google institute calendar; availability is advisory.</td></tr>
            <tr><td>Money and outcomes</td><td>Add a receipt and refund. Ask which numbers are recorded and which are estimates.</td><td>Lead-linked receipts and separate refunds; records do not establish incremental revenue.</td></tr>
            <tr><td>Staff and data scope</td><td>Show permissions using two institutes and distinct roles, including a counsellor account.</td><td>Organisation membership checks, role permissions and tenant-aware database controls described on the <Link href="/security">security page</Link>.</td></tr>
          </tbody>
        </table>
      </div>

      <h2>Score evidence, not a polished click path</h2>
      <ol>
        <li><strong>Choose five must-haves.</strong> A product that fails one critical permission or intake rule should not pass because it has many optional features.</li>
        <li><strong>Test the exception.</strong> Ask the operator to show an opted-out lead, a duplicate import, an unavailable provider and a counsellor takeover.</li>
        <li><strong>Ask for production scope.</strong> Separate what the demo simulates, what the application implements and what your provider account has enabled.</li>
        <li><strong>Record open questions.</strong> Note required integrations, costs and contractual terms that have not been established. Request written answers before a live pilot.</li>
      </ol>
      <p>AdmitFlow&apos;s <Link href="/product/admissions-recovery">recovery workflow</Link> and <Link href="/product/whatsapp-follow-up">WhatsApp operating requirements</Link> explain its current fit. The comparison above is a decision aid; it does not say that AdmitFlow or another CRM meets every institute&apos;s needs.</p>
    </>
  );
}

function PilotMeasurement() {
  return (
    <>
      <p>An admissions recovery pilot needs a defined cohort, a follow-up process and a record of what changed. Decide the time window and outcome rules before the first send. Then report contact activity, admissions outcomes and money events as separate measures.</p>

      <h2>Write a one-page pilot definition</h2>
      <ul>
        <li><strong>Population:</strong> open enquiries that have not had contact for at least seven days, with their source and counsellor owner recorded.</li>
        <li><strong>Eligibility:</strong> documented WhatsApp opt-in, any required guardian consent, an open stage and no human takeover or opt-out.</li>
        <li><strong>Intervention:</strong> a manager-reviewed audience and approved template, a named counsellor for replies, and a clear stop rule.</li>
        <li><strong>Window:</strong> a fixed intake period and a fixed outcome observation period. Keep both the same when comparing groups.</li>
        <li><strong>Outcomes:</strong> delivered messages, replies, bookings, admitted stages, receipts and refunds. Reconcile admission and payment records with the institute&apos;s system of record.</li>
      </ul>
      <p>For a stronger comparison, allocate eligible leads to follow-up and holdout groups using a rule set before outreach, with a plan for fairness and consent. If a holdout is inappropriate, use a prior period with the same source mix and acknowledge the limitations.</p>

      <h2>Fictional worked example</h2>
      <p><strong>Every number in this example is fictional.</strong> Suppose one institute reviews 300 stale, open enquiries over four weeks. Of these, 210 meet its documented follow-up eligibility rules. The institute places 120 eligible leads in a reviewed WhatsApp follow-up group and 90 in a comparison group. The groups were chosen by staff, not randomized, so their outcomes are observational.</p>
      <div className="buyer-table-scroll" tabIndex={0} role="region" aria-labelledby="pilot-table-caption">
        <table className="buyer-table">
          <caption id="pilot-table-caption">Fictional four-week pilot scorecard</caption>
          <thead><tr><th>Measure</th><th>Follow-up group</th><th>Comparison group</th><th>Reading</th></tr></thead>
          <tbody>
            <tr><td>Eligible leads</td><td>120</td><td>90</td><td>Different group sizes; use rates for a basic comparison.</td></tr>
            <tr><td>Provider-delivered messages</td><td>96 of 120 sent (80%)</td><td>Not sent</td><td>Acceptance or send attempt alone would be a different measure.</td></tr>
            <tr><td>Replies</td><td>24 of 96 delivered (25%)</td><td>Not applicable</td><td>A reply is an engagement event, not an admission.</td></tr>
            <tr><td>Counselling bookings</td><td>12 recorded</td><td>Not tracked in this example</td><td>Booking needs a distinct record and may be cancelled.</td></tr>
            <tr><td>Admitted leads</td><td>5 of 120 (4.2%)</td><td>3 of 90 (3.3%)</td><td>Observed difference about 0.8 percentage points; not a causal estimate.</td></tr>
            <tr><td>Receipts / refunds</td><td>₹125,000 / ₹10,000</td><td>Not collected in this example</td><td>₹115,000 net recorded for this group, not incremental revenue.</td></tr>
          </tbody>
        </table>
      </div>
      <p>The five admitted leads need not be the same people who replied or booked; do not present these rows as a single conversion funnel unless individual records prove the path. The comparison group has no matching payment data here. Source quality, seasonality, counsellor capacity and the staff selection rule may explain the small observed admission-rate difference.</p>

      <h2>Review the result without overclaiming</h2>
      <ol>
        <li>Reconcile the 300 starting leads, 210 eligible records and each exclusion reason. A shrinking denominator can make every later rate look stronger.</li>
        <li>Check provider status separately from reply and booking activity. Investigate messages that were accepted but not delivered.</li>
        <li>Audit a sample of admitted stages against actual enrolment and match receipt references and refunds to the correct leads.</li>
        <li>Compare admission rates only with a clearly defined denominator and similar observation windows. State how groups were assigned.</li>
        <li>Decide whether to continue the pilot based on the process gaps and verified outcomes as well as the headline rate.</li>
      </ol>
      <div className="buyer-note"><p>AdmitFlow stores lead-linked receipts and separate refunds and can associate a campaign with a revenue event. Those are records of activity and money. The product does not establish that its follow-up caused an admission or calculate a defensible incremental return from this example.</p></div>
      <p>Use the <Link href="/resources/coaching-admissions-follow-up-checklist">follow-up checklist</Link> to audit the operating steps and the <Link href="/product/admissions-recovery">recovery workflow</Link> to see which records AdmitFlow supports.</p>
    </>
  );
}
