import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Check,
  Inbox,
  Layers3,
  MessageCircle,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Illustration } from "../illustration";
import { SampleAudio } from "../sample-audio";
import { ProductPreview } from "./product-preview";

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <div className="public-section-heading">
      <div className="public-eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function PreviewCaption({ product = false }: { product?: boolean }) {
  return (
    <div className="preview-caption">
      <span><ShieldCheck size={14} aria-hidden="true" />Fictional interactive example · nothing is sent</span>
      {!product && (
        <Link href="/product" data-public-action="product-walkthrough">
          Explore the full workflow <ArrowRight size={15} aria-hidden="true" />
        </Link>
      )}
    </div>
  );
}

function ClosingCTA({ eyebrow = "EVERY ENQUIRY IS A BEGINNING" }: { eyebrow?: string }) {
  return (
    <section className="closing-cta public-container">
      <div>
        <div className="public-eyebrow">{eyebrow}</div>
        <h2>Make the next<br />conversation count.</h2>
        <p>See how a connected admissions workspace fits your coaching team.</p>
        <div className="closing-actions">
          <Link href="/signup" className="button primary public-cta" data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="body">
            Create account <ArrowUpRight size={18} aria-hidden="true" />
          </Link>
          <Link href="/contact" className="text-link" data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="body">
            Discuss a pilot <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </div>
      <Illustration name="next-chapter-campus" />
    </section>
  );
}

const workflow = [
  {
    number: "01",
    title: "Capture the enquiry",
    body: "Bring a new enquiry into the institute workspace by entering it or importing a CSV. Record the course, source and contact preference.",
    href: "/product#enquiries",
  },
  {
    number: "02",
    title: "Give someone ownership",
    body: "Assign a counsellor, keep the conversation in one inbox and choose the next follow-up with the student’s context in view.",
    href: "/product#conversations",
  },
  {
    number: "03",
    title: "Book counselling",
    body: "Arrange a session from the enquiry record. A connected institute calendar can receive AdmitFlow’s booking updates.",
    href: "/product#counselling",
  },
  {
    number: "04",
    title: "Record the outcome",
    body: "Mark an admission with an amount received and a receipt reference. Keep any later refund separate in reporting.",
    href: "/product#outcomes",
  },
] as const;

function Workflow() {
  return (
    <section className="public-section public-container public-workflow" id="workflow">
      <SectionHeading
        eyebrow="FROM FIRST ENQUIRY TO ADMISSION"
        title="A clear next step for every conversation."
        body="AdmitFlow connects the handoffs that coaching admissions teams handle each day. Your team keeps the decision at each stage."
      />
      <ol className="workflow-cards">
        {workflow.map((item) => (
          <li key={item.number}>
            <span>{item.number}</span>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            <Link href={item.href}>
              See how it works <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FeatureBento() {
  return (
    <section className="public-section public-container">
      <SectionHeading
        eyebrow="EVERYTHING HAS A PLACE"
        title="Less chasing. More connecting."
        body="The enquiry, the conversation and the outcome stay together, so the next counsellor can pick up with context."
      />
      <div className="feature-bento">
        <article className="feature-tile feature-knowledge">
          <div className="feature-copy">
            <span className="feature-icon"><BookOpen size={20} aria-hidden="true" /></span>
            <h3>Your knowledge.<br />Ready for the next question.</h3>
            <p>Add approved course, fee and policy information to give the assistant institute-specific context.</p>
            <Link href="/product#knowledge">
              Explore the knowledge base <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
          <Illustration name="knowledge-observatory" />
        </article>
        <article className="feature-tile feature-conversations">
          <span className="feature-icon"><Inbox size={20} aria-hidden="true" /></span>
          <h3>One inbox.<br />The whole conversation.</h3>
          <p>Review a suggested reply, see who owns the next step or have a counsellor take over.</p>
          <div className="bento-conversation">
            <span>FICTIONAL CONVERSATION</span>
            <p>Can someone help me compare the course options?</p>
            <div>
              <span className="preview-avatar tone-1">NC</span>
              <strong>Your counsellor has it from here.</strong>
              <Check size={16} aria-hidden="true" />
            </div>
          </div>
          <Link href="/product#conversations">
            See conversation handling <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </article>
        <article className="feature-tile feature-outcomes">
          <span className="feature-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
          <h3>Numbers with<br />a story behind them.</h3>
          <p>Keep recorded collections, refunds and net revenue distinct, linked back to an enquiry.</p>
          <div className="outcome-equation">
            <span>Collections</span><b>−</b><span>Refunds</span><b>=</b><strong>Net revenue</strong>
          </div>
          <Link href="/product#outcomes">
            Explore outcome records <ArrowUpRight size={16} aria-hidden="true" />
          </Link>
        </article>
        <article className="feature-tile feature-team">
          <Illustration name="next-chapter-campus" />
          <div className="feature-copy">
            <span className="feature-icon"><UsersRound size={20} aria-hidden="true" /></span>
            <h3>Your team.<br />On the same page.</h3>
            <p>Give an enquiry an owner, plan counselling and see what still needs a follow-up.</p>
            <Link href="/product/admissions-recovery">
              See follow-up and recovery <ArrowUpRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </article>
      </div>
    </section>
  );
}

function HomeAnswers() {
  return (
    <section className="public-section public-container public-answer-section" aria-labelledby="home-questions">
      <div className="public-answer-heading">
        <div className="public-eyebrow">BEFORE YOU BEGIN</div>
        <h2 id="home-questions">Questions coaching teams ask.</h2>
        <p>The answers that matter before you connect an admissions process.</p>
      </div>
      <div className="public-answer-grid">
        <article>
          <h3>Who is AdmitFlow for?</h3>
          <p>It is designed for coaching institute teams in India managing student enquiries, counsellor handoffs and admissions follow-ups. A team can evaluate whether the current workflow fits its process.</p>
        </article>
        <article>
          <h3>Does it replace counsellors?</h3>
          <p>No. Counsellors can own a conversation, review AI suggested replies in assisted mode or take over when the assistant is active. The institute chooses the assistant mode.</p>
        </article>
        <article>
          <h3>Can it follow up on WhatsApp?</h3>
          <p>Yes, after the institute connects an eligible WhatsApp Business account and records contact permission. Follow-ups outside the reply window use approved templates and delivery is tracked separately from provider acceptance.</p>
          <Link href="/product/whatsapp-follow-up">Read the setup details <ArrowRight size={14} aria-hidden="true" /></Link>
        </article>
        <article>
          <h3>How much does it cost?</h3>
          <p>Pricing is still being finalized. <Link href="/pricing">See the current pricing status</Link> or <Link href="/contact" data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="body">discuss a pilot scope</Link> with AdmitFlow.</p>
        </article>
      </div>
      <Link className="text-link" href="/help">More setup and buying answers <ArrowRight size={16} aria-hidden="true" /></Link>
    </section>
  );
}

export function WelcomePage() {
  return (
    <>
      <section className="public-hero" aria-labelledby="hero-title">
        <div className="hero-background" aria-hidden="true">
          <Illustration name="admissions-mountain-hero" eager decorative sizes="100vw" />
        </div>
        <div className="hero-copy public-container">
          <div className="public-eyebrow"><span className="eyebrow-dot" />BUILT FOR COACHING TEAMS IN INDIA</div>
          <h1 id="hero-title">Admissions CRM for coaching institutes.</h1>
          <p>Give every enquiry an owner and a next step. Bring WhatsApp follow-ups, counselling and recorded outcomes into one workspace, with your admissions team in control.</p>
          <div className="hero-actions">
            <Link className="button primary public-cta" href="/contact" data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="hero">
              Discuss a pilot <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
            <Link className="button secondary public-cta" href="/product" data-public-action="product-walkthrough">
              Explore the product <ArrowRight size={17} aria-hidden="true" />
            </Link>
          </div>
          <Link href="/signup" className="hero-pilot" data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="hero">
            Create account <ArrowRight size={15} aria-hidden="true" />
          </Link>
          <div className="hero-assurance">
            <ShieldCheck size={15} aria-hidden="true" />
            Clear ownership. Contact preferences. A record of the outcome.
          </div>
        </div>
        <div className="hero-product public-container" id="workbench">
          <ProductPreview />
          <noscript><p className="preview-noscript">The example needs JavaScript to switch steps. The workflow and answers below remain available.</p></noscript>
          <PreviewCaption />
        </div>
      </section>
      <div className="capability-strip public-container">
        <span>ONE CONNECTED WORKSPACE</span>
        <span><UsersRound size={18} aria-hidden="true" />Enquiries</span>
        <span><MessageCircle size={18} aria-hidden="true" />Conversations</span>
        <span><CalendarDays size={18} aria-hidden="true" />Counselling</span>
        <span><Layers3 size={18} aria-hidden="true" />Recovery</span>
      </div>
      <Workflow />
      <FeatureBento />
      <section className="public-section public-container voice-section">
        <div>
          <div className="public-eyebrow">THOUGHTFUL BY DESIGN</div>
          <h2>Human context.<br />A little extra help.</h2>
          <p>Add approved institute knowledge, choose how the assistant participates and let a counsellor take over a conversation. AI assistance depends on your settings and connected services.</p>
          <Link href="/product#assistant" className="text-link">
            Explore the controls <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
        <SampleAudio slug="walkthrough" />
      </section>
      <section className="public-section public-container public-fit">
        <div>
          <div className="public-eyebrow">FIND THE RIGHT FIT</div>
          <h2>For a team that follows through.</h2>
        </div>
        <div>
          <p>AdmitFlow currently fits an institute that wants shared enquiry records, named counsellor ownership, WhatsApp follow-up and counselling in one workspace. Setup involves importing or entering enquiries, connecting services where needed and recording permission to message students.</p>
          <p>If you need custom pipeline stages, two-way Google Calendar updates or a guaranteed integration with an existing campus system, compare those requirements with the current product before rollout.</p>
          <Link href="/product" className="text-link">
            Review the current capabilities <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </section>
      <HomeAnswers />
      <ClosingCTA />
    </>
  );
}

const stageNames = ["New", "Contacted", "Qualified", "Counselling", "Demo", "Negotiation", "Admitted", "Lost"];

function Capability({
  id,
  eyebrow,
  title,
  body,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <section className="public-section public-container product-capability" id={id}>
      <div>
        <div className="public-eyebrow">{eyebrow}</div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <div className="product-capability-detail">{children}</div>
    </section>
  );
}

export function ProductPage() {
  return (
    <>
      <section className="public-container product-intro">
        <div className="public-eyebrow">ADMISSIONS CRM FOR COACHING TEAMS</div>
        <h1>The enquiry-to-admission workflow,<br /><em>in one place.</em></h1>
        <p>See how AdmitFlow organizes enquiries, conversations, counselling and recorded outcomes. The example below uses fictional data.</p>
      </section>
      <section className="public-container product-demo" aria-label="Fictional interactive product preview">
        <ProductPreview />
        <noscript><p className="preview-noscript">The example needs JavaScript to switch steps. All capability details below are available.</p></noscript>
        <PreviewCaption product />
      </section>
      <Capability
        id="enquiries"
        eyebrow="01 / ENQUIRY INTAKE"
        title="Start with a shared record."
        body="A team member can add an enquiry or an administrator can preview and import a CSV. The record holds the course, source, counsellor, next action and contact preference. The import checks rows and skips duplicate phone numbers."
      >
        <h3>A pipeline with clear stages</h3>
        <ol className="stage-list">{stageNames.map((stage) => <li key={stage}>{stage}</li>)}</ol>
        <p>These are the current built-in stages. The product does not yet offer an arbitrary custom stage builder.</p>
        <Link href="/help#enquiries">See the intake steps <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </Capability>
      <Capability
        id="conversations"
        eyebrow="02 / CONVERSATIONS"
        title="Context and ownership stay together."
        body="The shared inbox shows the student conversation beside the enquiry record. A counsellor can send a reply, add a private note or take over from the assistant. Assisted mode prepares replies for team review; autonomous and paused modes are also available."
      >
        <h3>Before a WhatsApp reply</h3>
        <ul className="public-checks">
          <li><Check size={18} aria-hidden="true" />Connect the institute’s WhatsApp Business account.</li>
          <li><Check size={18} aria-hidden="true" />Record the student’s contact permission and guardian consent where needed.</li>
          <li><Check size={18} aria-hidden="true" />Use an approved template when the 24-hour reply window has closed.</li>
        </ul>
        <p>Provider acceptance and confirmed delivery are different statuses.</p>
        <Link href="/product/whatsapp-follow-up">How WhatsApp follow-up works <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </Capability>
      <Capability
        id="recovery"
        eyebrow="03 / FOLLOW-UP AND RECOVERY"
        title="A next step for quieter enquiries."
        body="Teams can review inactive open enquiries, choose an eligible audience and launch an approved-template follow-up. A configured sequence schedules later messages and stops when the student replies, books counselling, opts out or a counsellor takes over."
      >
        <h3>Eligibility comes first</h3>
        <p>The current recovery rule identifies open enquiries with seven or more days since contact. WhatsApp opt-in and other messaging checks still apply before sending. The team can see queued, accepted and delivered states separately.</p>
        <Link href="/product/admissions-recovery">Explore admissions recovery <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </Capability>
      <Capability
        id="counselling"
        eyebrow="04 / COUNSELLING"
        title="Book the conversation that moves it forward."
        body="A counsellor can book, reschedule and mark the outcome of a session from the enquiry. AdmitFlow checks its own appointments for conflicts. A connected institute Google Calendar can receive new, changed and cancelled sessions."
      >
        <h3>Calendar direction and availability</h3>
        <p>Updates flow from AdmitFlow to one connected Google calendar. Changes made in Google are not imported. Google availability checks are advisory until the booking is saved, and a failed sync needs attention.</p>
        <Link href="/help#counselling">Read the counselling steps <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </Capability>
      <Capability
        id="outcomes"
        eyebrow="05 / RECORDED OUTCOMES"
        title="Know what was recorded."
        body="An authorized team member can mark an admission by recording an amount received with a receipt or transaction reference. Refunds are entered separately, and reports distinguish collections from net revenue."
      >
        <h3>What the record means</h3>
        <p>A manual admission record does not charge the student or verify a bank transaction. A connected payment provider is a separate setup step. Recovery reporting links recorded outcomes to the relevant campaign without proving the campaign caused the admission.</p>
        <Link href="/help#receipts">How to record an outcome <ArrowUpRight size={15} aria-hidden="true" /></Link>
      </Capability>
      <section className="public-section public-container product-story" id="knowledge">
        <Illustration name="knowledge-observatory" />
        <div>
          <div className="public-eyebrow">06 / INSTITUTE KNOWLEDGE</div>
          <h2>A helpful assistant.<br />An accountable team.</h2>
          <p>An administrator can add approved course, fee, policy and FAQ material. The assistant uses that institute context to help answer enquiries; staff still manage the knowledge and conversation.</p>
          <ul className="public-checks" id="assistant">
            <li><Check size={18} aria-hidden="true" />Assisted, autonomous and paused modes</li>
            <li><Check size={18} aria-hidden="true" />Human takeover in the conversation</li>
            <li><Check size={18} aria-hidden="true" />A configurable daily AI message-count limit</li>
          </ul>
          <p>The message-count control is not a hard currency or token spending cap.</p>
        </div>
      </section>
      <section className="public-section public-container" id="voice-examples">
        <SectionHeading
          eyebrow="VOICE EXAMPLES"
          title="Hear the tone, read the words."
          body="These are fictional counselling examples with AI-generated stock voices. Playback is local to this page and sends no student message."
        />
        <div className="audio-grid">
          {["counselling-invitation", "session-reminder", "thoughtful-followup"].map((slug) => (
            <SampleAudio slug={slug} key={slug} />
          ))}
        </div>
      </section>
      <section className="public-section public-container product-setup" id="setup">
        <div>
          <div className="public-eyebrow">BEFORE YOUR TEAM STARTS</div>
          <h2>Set up the parts you plan to use.</h2>
          <p>Your institute adds its team and enquiry data, records messaging permissions and connects WhatsApp, Calendar or payment services where relevant. Each integration has its own access and provider requirements.</p>
        </div>
        <div className="product-setup-links">
          <Link href="/help">Read the setup guide <ArrowUpRight size={15} aria-hidden="true" /></Link>
          <Link href="/security">Review implemented controls <ArrowUpRight size={15} aria-hidden="true" /></Link>
          <Link href="/signup" data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="body">Create account <ArrowUpRight size={15} aria-hidden="true" /></Link>
        </div>
      </section>
      <ClosingCTA eyebrow="SEE HOW IT FITS YOUR INSTITUTE" />
    </>
  );
}

function Question({
  question,
  children,
}: {
  question: string;
  children: ReactNode;
}) {
  return <article><h3>{question}</h3><div>{children}</div></article>;
}

export function PricingPage() {
  return (
    <>
      <section className="public-container pricing-intro">
        <div className="public-eyebrow">START WITH A SCOPED PILOT</div>
        <h1>Evaluate your follow-up workflow.<br /><em>Then plan the rollout.</em></h1>
        <p>Start with one coaching team and an agreed enquiry group. Discuss the workflow, connected services and success measures before committing to a rollout. There is no published rate or paid plan to select here yet.</p>
      </section>
      <section className="public-container pricing-card">
        <div>
          <span className="badge violet">Pricing not published</span>
          <h2>A clear scope before you begin.</h2>
          <p>A pilot discussion covers your enquiry sources, counsellor ownership, WhatsApp readiness and counselling process. Agree the duration, fees, service charges and support responsibilities in writing before starting.</p>
          <div className="pricing-actions">
            <Link href="/contact" className="button primary public-cta" data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="body">
              Discuss a pilot <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
            <Link href="/product" className="text-link">
              Explore the current product <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </div>
        <div>
          <span className="public-eyebrow">CURRENT PRODUCT AREAS</span>
          <ul className="public-checks">
            {[
              "Enquiry records and built-in pipeline stages",
              "Shared conversation context and human takeover",
              "Counselling bookings and follow-up workflows",
              "Institute knowledge and assistant modes",
              "Recorded collections, refunds and net reporting",
            ].map((text) => <li key={text}><Check size={18} aria-hidden="true" />{text}</li>)}
          </ul>
          <p>These describe the product, not a priced package or guaranteed plan entitlement.</p>
        </div>
      </section>
      <section className="public-section public-container public-answer-section pricing-answers">
        <div className="public-answer-heading">
          <div className="public-eyebrow">BUYING QUESTIONS</div>
          <h2>What is known today?</h2>
        </div>
        <div className="public-answer-grid">
          <Question question="How much does AdmitFlow cost?">
            <p>Public pricing has not been set for launch. Ask the AdmitFlow team about commercial terms and any implementation or third-party charges before making a paid commitment.</p>
          </Question>
          <Question question="Is there a free plan or trial?">
            <p>No public free-plan or trial terms have been announced. Creating an account is a setup step, not acceptance of a paid plan or a reserved pilot.</p>
          </Question>
          <Question question="How should we evaluate fit?">
            <p>List your enquiry sources, counsellor roles, messaging permissions and calendar needs. Compare those with the <Link href="/product">current capabilities</Link> and <Link href="/security">implemented controls</Link> before planning a rollout.</p>
          </Question>
        </div>
        <Link href="/signup" className="button secondary public-cta" data-af-event="primary_cta_click" data-af-cta="signup" data-af-placement="body">
          Create account <ArrowUpRight size={16} aria-hidden="true" />
        </Link>
      </section>
    </>
  );
}

const guideSteps = [
  {
    id: "enquiries",
    title: "Bring enquiries together",
    body: "Enter a student enquiry or, as an administrator, import a CSV. A CSV needs a name and phone number for each row. Preview the import, check consent fields and review skipped duplicates before assigning the next action.",
  },
  {
    id: "knowledge",
    title: "Give your team the right context",
    body: "Add approved institute information about courses, fees and policies. An owner or administrator manages assistant settings; your team chooses assisted, autonomous or paused mode.",
  },
  {
    id: "whatsapp",
    title: "Reconnect on WhatsApp",
    body: "Connect an eligible institute WhatsApp Business account, record the student’s messaging permission and use an approved template outside the 24-hour reply window. After sending, check the delivery status.",
  },
  {
    id: "counselling",
    title: "Book counselling",
    body: "Book from the enquiry record, assign a counsellor and confirm the time. Connected Google Calendar updates flow from AdmitFlow to one institute calendar; Google changes do not flow back.",
  },
  {
    id: "receipts",
    title: "Record the outcome",
    body: "Record an amount actually received with a receipt or transaction reference when marking an admission. Record refunds separately. A manual record does not charge the student or confirm bank settlement.",
  },
] as const;

export function HelpPage() {
  return (
    <>
      <section className="public-container help-intro">
        <div className="public-eyebrow">GETTING STARTED</div>
        <h1>From first enquiry<br /><em>to a clear next step.</em></h1>
        <p>A practical guide for coaching admissions teams. Available actions depend on your role, connected services and the student’s contact permission.</p>
        <Link href="/product" className="text-link">
          Explore the product example <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </section>
      <section className="public-section public-container help-guide" aria-label="Getting-started steps">
        <div className="help-guide-aside">
          <span className="public-eyebrow">THE WORKFLOW</span>
          <h2>Start with context.<br />Keep the trail.</h2>
          <p>These steps describe the current product. The public preview uses fictional students and sends nothing.</p>
          <Link href="/product">See each capability <ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
        <ol>
          {guideSteps.map((item, index) => (
            <li key={item.id} id={item.id}>
              <span className="help-step-number">{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{item.title}</h3><p>{item.body}</p></div>
            </li>
          ))}
        </ol>
      </section>
      <section className="public-section public-container public-answer-section help-answers">
        <div className="public-answer-heading">
          <div className="public-eyebrow">DIRECT ANSWERS</div>
          <h2>Questions before rollout.</h2>
        </div>
        <div className="public-answer-grid">
          <Question question="What is AdmitFlow?">
            <p>AdmitFlow is an admissions CRM for coaching institutes. It keeps enquiries, follow-ups, counselling and recorded admission outcomes in one workspace.</p>
          </Question>
          <Question question="Can we import existing enquiries?">
            <p>An institute administrator can import a CSV of up to 1,000 enquiries and 2 MB. Each row needs a name and phone number. The preview shows mapped fields, and duplicate phone numbers are skipped.</p>
          </Question>
          <Question question="How does admissions recovery work?">
            <p>Open enquiries become candidates after seven days without contact. The team reviews the audience and follow-up. Messaging permission and eligibility checks apply; an active sequence stops after a reply, booking, opt-out or human takeover.</p>
            <Link href="/product/admissions-recovery">See the recovery workflow <ArrowRight size={14} aria-hidden="true" /></Link>
          </Question>
          <Question question="Can it sync counselling with Google Calendar?">
            <p>With a connected institute calendar, AdmitFlow sends booking, rescheduling and cancellation updates to Google. Google-side changes are not imported, and an availability check does not reserve a slot.</p>
          </Question>
          <Question question="What controls does the admissions team keep?">
            <p>The team can assign ownership, take over a conversation and choose assisted, autonomous or paused assistant mode. Messaging checks use recorded opt-in and guardian consent when applicable. The daily AI limit counts messages; it is not a hard money cap.</p>
          </Question>
          <Question question="How much does it cost?">
            <p>Pricing and pilot terms have not been published. <Link href="/pricing">Check the pricing page</Link> or <Link href="/contact" data-af-event="primary_cta_click" data-af-cta="contact" data-af-placement="body">contact AdmitFlow</Link> before making a decision.</p>
          </Question>
          <Question question="How is student data handled?">
            <p>Institute members work within their own workspace, with roles governing sensitive actions. Review the <Link href="/security">security and data-handling page</Link> for the implemented controls and current limits before importing student information.</p>
          </Question>
          <Question question="How should we measure a pilot?">
            <p>Agree on an enquiry group, follow-up process and time period first. Track replies, counselling bookings and recorded admissions as separate outcomes; those observations alone do not prove incremental impact. <Link href="/resources/measuring-admissions-recovery-pilot">Read the pilot measurement guide</Link> for a practical starting point.</p>
          </Question>
        </div>
      </section>
      <ClosingCTA eyebrow="READY FOR YOUR FIRST STEP?" />
    </>
  );
}
