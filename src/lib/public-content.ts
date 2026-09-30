/**
 * Published public pages only. This module has no server, database, auth or tenant imports,
 * so the proxy can use it to decide which exact paths bypass hosted authentication.
 */
export type PublicPageDefinition = {
  pathname: string;
  title: string;
  description: string;
  indexable: boolean;
  sitemap: boolean;
};

export const publicResources = [
  {
    slug: "coaching-admissions-follow-up-checklist",
    pathname: "/resources/coaching-admissions-follow-up-checklist",
    title: "Coaching Admissions Follow-Up Checklist | AdmitFlow",
    description: "A practical checklist for coaching admissions teams to assign enquiries, plan follow-ups, respect contact preferences and record outcomes.",
    indexable: true,
    sitemap: true,
  },
  {
    slug: "how-to-evaluate-an-admissions-crm",
    pathname: "/resources/how-to-evaluate-an-admissions-crm",
    title: "How to Evaluate an Admissions CRM | AdmitFlow",
    description: "Questions coaching institute owners can use to evaluate enquiry ownership, follow-ups, integrations, access and reporting in an admissions CRM.",
    indexable: true,
    sitemap: true,
  },
  {
    slug: "measuring-admissions-recovery-pilot",
    pathname: "/resources/measuring-admissions-recovery-pilot",
    title: "Measuring an Admissions Recovery Pilot | AdmitFlow",
    description: "Define a baseline, enquiry cohort, measurement window and outcomes before evaluating an admissions recovery pilot.",
    indexable: true,
    sitemap: true,
  },
] as const satisfies readonly (PublicPageDefinition & { slug: string })[];

export const publicResourceSlugs = publicResources.map((resource) => resource.slug);

export const publicPages: readonly PublicPageDefinition[] = [
  {
    pathname: "/",
    title: "Admissions CRM for Coaching Institutes | AdmitFlow",
    description: "AdmitFlow helps coaching institute teams organize enquiries, WhatsApp follow-ups, counselling and admissions recovery in one workspace.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/product",
    title: "Coaching Admissions Software Features | AdmitFlow",
    description: "Explore how AdmitFlow connects enquiries, team ownership, follow-ups, counselling and recovery with human control and clear reporting.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/product/whatsapp-follow-up",
    title: "WhatsApp Follow-Up for Coaching Institutes | AdmitFlow",
    description: "Understand how coaching admissions teams review contact permissions, approved WhatsApp templates, conversation ownership and delivery status.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/product/admissions-recovery",
    title: "Admissions Enquiry Recovery | AdmitFlow",
    description: "See a measured approach to reviewing inactive admissions enquiries, planning eligible follow-ups and tracking outcomes without guaranteed claims.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/pricing",
    title: "Pricing and Pilot Enquiries | AdmitFlow",
    description: "AdmitFlow rates have not been published. Contact AdmitFlow to discuss a pilot for your coaching institute and the admissions workflows you want to evaluate.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/help",
    title: "AdmitFlow Help and Setup Questions",
    description: "Learn the steps for bringing enquiries, institute knowledge, WhatsApp follow-up, counselling and recorded outcomes into one workflow.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/about",
    title: "About AdmitFlow",
    description: "Learn why AdmitFlow is being built for coaching institute admissions teams and what the workspace is designed to help them organize.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/contact",
    title: "Contact AdmitFlow",
    description: "Contact AdmitFlow about organizing enquiries, follow-ups, counselling and admissions recovery for your coaching institute.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/security",
    title: "Security and Data Handling | AdmitFlow",
    description: "Read about AdmitFlow's documented approach to institute access, student data handling and connected service boundaries.",
    indexable: true,
    sitemap: true,
  },
  {
    pathname: "/resources",
    title: "Admissions Operations Resources | AdmitFlow",
    description: "Practical guides for coaching institute teams evaluating admissions follow-up, CRM workflows and recovery measurement.",
    indexable: true,
    sitemap: true,
  },
  ...publicResources,
];

export function publicPageByPath(pathname: string): PublicPageDefinition | undefined {
  return publicPages.find((page) => page.pathname === pathname);
}

export function publicPage(pathname: string): PublicPageDefinition {
  const page = publicPageByPath(pathname);
  if (!page) throw new Error(`Unpublished public page: ${pathname}`);
  return page;
}
