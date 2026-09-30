export const buyerResources = [
  {
    slug: "coaching-admissions-follow-up-checklist",
    title: "Coaching admissions follow-up checklist",
    description: "A manager's practical checklist for lead intake, consent, ownership, WhatsApp follow-up and stop conditions.",
    summary: "A working checklist for managers setting up a responsible follow-up process.",
    audience: "Admissions manager",
    publishedOn: "2026-09-29",
    readingMinutes: 7,
  },
  {
    slug: "how-to-evaluate-an-admissions-crm",
    title: "How to evaluate an admissions CRM",
    description: "A requirements matrix for coaching institutes comparing enquiry intake, staff ownership, messaging controls, counselling and outcome records.",
    summary: "A requirements matrix for an owner comparing admissions systems against real work.",
    audience: "Institute owner",
    publishedOn: "2026-09-29",
    readingMinutes: 8,
  },
  {
    slug: "measuring-admissions-recovery-pilot",
    title: "Measuring an admissions recovery pilot",
    description: "A pilot scorecard and fictional worked example that separates follow-up activity, admissions outcomes and causal claims.",
    summary: "A scorecard and worked example for assessing a focused recovery pilot.",
    audience: "Admissions operations",
    publishedOn: "2026-09-29",
    readingMinutes: 8,
  },
] as const;

export type BuyerResource = (typeof buyerResources)[number];
export type BuyerResourceSlug = BuyerResource["slug"];

const resourceDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatResourceDate(publishedOn: string): string {
  return resourceDateFormatter.format(new Date(`${publishedOn}T00:00:00Z`));
}

export function getBuyerResource(slug: string): BuyerResource | undefined {
  return buyerResources.find((resource) => resource.slug === slug);
}
