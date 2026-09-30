# AdmitFlow: SEO, AEO, GEO and launch discoverability implementation handoff

**Website:** https://admitflow.incfrog.ai/
**Repository:** `H:\new-app`
**Prepared:** 29 September 2026
**Evidence baseline:** source inspection and live checks on 28 September 2026
**Purpose:** Give this document to an implementation agent to improve the existing website.

This is a specification. Its creation does not mean any application changes, deployments, search submissions or analytics configuration have been completed.

## 1. Copy this instruction to the implementation agent

> Implement this handoff in the existing AdmitFlow repository. Keep the brand AdmitFlow and the production domain `https://admitflow.incfrog.ai`. Inspect the current code, applicable repository instructions and deployment configuration before editing; the baseline below may have changed.
>
> Complete the P0 technical work first, then the P1 pages, content, measurement and performance work. Make concrete, reviewable changes and run the relevant checks. Preserve the existing visual identity, authentication, tenant isolation and working product flows.
>
> Use the route map, metadata requirements, content briefs and acceptance matrix in this document. Do not stop at another audit or a plan. Complete work that can be done locally while collecting any missing business facts. Mark account access, factual approvals and provider dependencies separately instead of treating them as reasons to stop unrelated implementation.
>
> Do not invent customers, testimonials, results, pricing, certifications, legal details or product capabilities. The business currently has no users, and pricing has not been decided. Physics Wallah is a target customer, not an existing customer.
>
> Work within the authorization provided when this document is assigned. This document itself does not authorize paid services, live infrastructure changes, external account settings, mass submissions, outreach or publication. Follow current release instructions and existing approvals; do not bypass build or deployment gates.
>
> Return the changed files, validation results, before/after evidence, remaining owner actions and release status. Distinguish implemented, tested locally, deployed and confirmed live. Do not claim that indexing, rankings or AI citations are guaranteed.

## 2. Business objective and scope

AdmitFlow is an admissions workspace for coaching institutes in India. The intended buyers include institute owners, admissions heads and counselling managers. The owner also wants to serve large coaching groups such as Physics Wallah.

The website should make four things immediately clear:

1. What AdmitFlow does: organize enquiries, follow-ups, counselling and admissions recovery.
2. Who it serves: coaching institute admissions teams.
3. How the workflow operates, including human control and integration requirements.
4. How an interested institute can evaluate the product or request a pilot.

Success means more qualified institute enquiries and a technically sound, discoverable website. Raw traffic from students searching for admissions, exam preparation or scholarships is not the primary objective.

| Workstream | Meaning here | Desired outcome |
|---|---|---|
| SEO | Search engine optimization | Public pages can be crawled, indexed and understood for relevant buyer searches. |
| AEO | Answer engine optimization | Pages directly and accurately answer admissions software buying questions. |
| GEO | Generative engine optimization | AI search systems can access, identify and cite useful, trustworthy public information. |
| Conversion | Turning relevant visits into business enquiries | Visitors can take a working, measurable next step. |
| Accessibility and performance | Usable pages across devices and assistive technology | Visitors can read, navigate and interact without avoidable delays or barriers. |
| Authority and identity | Consistent, verifiable business information | People and search systems can distinguish AdmitFlow from similarly named products. |

The current subdomain is a valid SEO target. Buying a new domain, renaming the product or migrating hosting is not a prerequisite for this work.

## 3. Verified baseline and limits

### 3.1 Public website

The latest domain check recorded in the audit was at `2026-09-28T15:44:52.638Z`.

| Check | Observed result | Interpretation |
|---|---|---|
| `/` | HTTPS 200, meaningful server-rendered HTML, `index, follow` | There is already crawlable public content. |
| `/welcome` | HTTPS 200, duplicates the homepage | Consolidate this duplicate with a permanent redirect. |
| `/product` | HTTPS 200, indexable | Improve metadata and useful product detail. |
| `/pricing` | HTTPS 200, indexable, pricing not published | Explain evaluation and pricing availability truthfully. |
| `/help` | Earlier audit: HTTPS 200, indexable | Retain useful visible answers and improve navigation. |
| `/login`, `/signup` | Earlier audit: `noindex, nofollow` | Preserve exclusion from search results. |
| Canonicals | Missing on tested public pages | Repair metadata generation and build configuration. |
| JSON-LD | Missing on tested public pages | Add appropriate, factually supported structured data. |
| Open Graph / Twitter metadata | Not found in the earlier HTML audit | Add complete social sharing metadata and images. |
| `/robots.txt` | 404 | Publish an intentional crawler policy and sitemap location. |
| `/sitemap.xml` | 404 | Publish a sitemap containing canonical public URLs. |
| `/llms.txt` | Earlier audit: 404 | Not a launch blocker or established ranking defect. |

**Do not overstate this diagnosis:** a missing `robots.txt` does not itself prevent Google from crawling. Missing canonical tags, a sitemap or schema do not prove why a page has not been indexed.

### 3.2 Search Console and measurement

The connected property is `sc-domain:incfrog.ai`, which covers the AdmitFlow subdomain.

| Item | Baseline |
|---|---|
| Reporting period | 29 August–25 September 2026 |
| AdmitFlow page filter | Page contains `https://admitflow.incfrog.ai/` |
| Filtered page results | Zero returned rows for that period |
| Homepage URL Inspection | `URL is unknown to Google`; verdict `NEUTRAL`; no last crawl time returned |
| Parent-domain totals | 0 clicks / 259 impressions; these belong to the whole `incfrog.ai` property |
| GA4 | Not connected through GSC Wizard; other configurations were not established |
| CrUX / Core Web Vitals | Not measured; the connection lacked a CrUX API key |
| Bing | No connected Webmaster API key; no Bing indexing assessment completed |
| Google generative AI report | Documented by Google, but not retrieved through the available connector |
| Google generative AI inclusion setting | Effective setting not inspected |
| ChatGPT / Perplexity citation benchmark | Not performed |

Zero scoped rows describe the inspected period, not every historical visit. The inspection does not establish a penalty. Do not label the site “blocked by Google” without new evidence.

Local evidence from the previous analysis:

- Research report (local-only archive: `artifacts/admitflow-market-brand-search-2026-09-28/REPORT.md`; see [portable evidence summary](seo-release-snapshot.md))
- Search Console baseline (local-only archive: `artifacts/admitflow-market-brand-search-2026-09-28/search-console-baseline.json`; see [portable evidence summary](seo-release-snapshot.md))
- Live HTML audit (local-only archive: `artifacts/admitflow-market-brand-search-2026-09-28/live-audit.json`; see [portable evidence summary](seo-release-snapshot.md))

The Search Console JSON is a summary transcribed from successful connector responses, not an original provider export. Keep that provenance clear.

## 4. Priority order

| ID | Priority | Task | Completion evidence |
|---|---|---|---|
| TECH-01 | P0 | Repair metadata origin and production indexability configuration | Built HTML has correct canonical and robots directives. |
| TECH-02 | P0 | Consolidate `/welcome` into `/` safely | One permanent redirect, no loop, updated internal links. |
| TECH-03 | P0 | Make intended public routes work with hosted authentication configured | Anonymous and stale-session requests reach public content. |
| TECH-04 | P0 | Add `robots.txt` and `sitemap.xml` | Correct status, content types, URLs and crawler behavior. |
| TECH-05 | P0 | Verify private routes, errors, redirects and assets | No private content leak, no accidental soft 404 or indexing. |
| PAGE-01 | P1 | Improve homepage and product positioning | Clear buyer-focused copy and verified workflows. |
| PAGE-02 | P1 | Add useful public buyer, company and trust pages | Complete pages with real navigation and truthful facts. |
| ANSWER-01 | P1 | Add direct answers, documentation and evidence | Visible answers supported by the actual product. |
| ENTITY-01 | P1 | Add consistent entity data, structured data and social previews | Valid markup matching visible content. |
| PERF-01 | P1 | Measure and fix important mobile performance issues | Comparable before/after measurements and working interactions. |
| CONVERT-01 | P1 | Verify evaluation/demo/signup paths and measurement | Events correspond to completed actions, with no personal data leakage. |
| SEARCH-01 | P1 | Verify search ownership, submit sitemap and inspect priority URLs | Actual account/readback evidence when access is authorized. |
| CONTENT-01 | P2 | Publish a small set of original buyer resources | Useful, reviewed pages with one clear purpose each. |
| AUTHORITY-01 | P2 | Build legitimate external references and early customer evidence | Real, permitted mentions and documented results. |
| MEASURE-01 | P2 | Track search, AI visibility and qualified enquiries | Repeatable reporting with product-specific filters. |

P0 means launch-critical implementation work. It does not mean the site must achieve a ranking or be indexed by a deadline.

## 5. Repository map and implementation constraints

### 5.1 Existing files to inspect and update as needed

Paths below are relative to `H:\new-app` unless linked.

| File | Current behavior / intended work |
|---|---|
| [src/app/page.tsx](../src/app/page.tsx) | Re-exports the homepage and metadata from `/welcome`. Separate this before redirecting `/welcome`. |
| [src/app/welcome/page.tsx](../src/app/welcome/page.tsx) | Homepage implementation and conditional canonical metadata. |
| [src/app/product/page.tsx](../src/app/product/page.tsx) | Public product metadata and page entry point. |
| [src/app/pricing/page.tsx](../src/app/pricing/page.tsx) | Public pricing-availability page; no approved prices. |
| [src/app/help/page.tsx](../src/app/help/page.tsx) | Public help page. |
| [src/app/layout.tsx](../src/app/layout.tsx) | Root metadata defaults to `noindex, nofollow`; preserve protection for private pages. |
| [src/proxy.ts](../src/proxy.ts) | Exact public-route bypass before hosted authentication middleware. |
| [src/lib/config.ts](../src/lib/config.ts) | `appUrl()` uses `APP_BASE_URL` or localhost; also used outside SEO. |
| [src/lib/workspace-routes.ts](../src/lib/workspace-routes.ts) | Known private workspace routes. |
| [src/app/[...view]/page.tsx](H:/new-app/src/app/[...view]/page.tsx) | Private workspace routing, `noindex`, and `notFound()` for unknown views. |
| [src/components/marketing/marketing.tsx](../src/components/marketing/marketing.tsx) | Public layouts, navigation, footer, landing copy and interactive demo. |
| [src/components/illustration.tsx](../src/components/illustration.tsx) | Responsive WebP images, dimensions, eager/lazy behavior and fallbacks already exist. |
| [src/components/sample-audio.tsx](../src/components/sample-audio.tsx) | Audio already uses `preload="none"` and visible transcript controls. |
| [src/app/globals.css](../src/app/globals.css) | Imports marketing and workspace styles; measure unused CSS before restructuring. |
| [src/app/tokens.css](../src/app/tokens.css) | Existing brand and typography tokens to preserve. |
| [next.config.ts](../next.config.ts) | Standalone output and security headers; potential redirect location. |
| [Dockerfile](../Dockerfile) | Next build runs before runtime configuration is supplied. |
| [.github/workflows/publish-images.yml](../.github/workflows/publish-images.yml) | Public build arguments and publication gates. |
| [infra/stack.ts](../infra/stack.ts) | Runtime application URL configuration. |
| [tests/browser/entry-routing.spec.ts](../tests/browser/entry-routing.spec.ts) | Existing public/private routing and 404 expectations. |
| [scripts/verify.mjs](../scripts/verify.mjs) | Existing verification orchestration and fixture isolation. |
| [docs/deployment.md](deployment.md) | Existing deployment procedure. |
| [docs/release-gates.md](release-gates.md) | Existing release requirements; check which records are current. |

At inspection, the application used Next.js `16.3.5`, React `19.3.0`, TypeScript and Node 24. Production uses a standalone container on AWS ECS/Fargate behind an ALB. Do not introduce a hosting migration for SEO.

### 5.2 Suggested new files

These are proposed paths, not claims that the files already exist. Adapt to current project conventions.

```text
src/lib/seo.ts
src/lib/public-routes.ts
src/lib/public-content.ts
src/components/marketing/structured-data.tsx
src/app/robots.ts
src/app/sitemap.ts
public/opengraph-image.png
src/app/about/page.tsx
src/app/contact/page.tsx
src/app/security/page.tsx
src/app/privacy/page.tsx
src/app/terms/page.tsx
src/app/product/whatsapp-follow-up/page.tsx
src/app/product/admissions-recovery/page.tsx
src/app/resources/page.tsx
src/app/resources/[slug]/page.tsx
tests/seo.test.ts
tests/browser/public-seo.spec.ts
docs/seo-implementation-report.md
```

Use a small, typed public-content registry to coordinate canonical paths, sitemap inclusion, navigation, publication state and metadata. Keep private route classification separate. Never generate the public sitemap by enumerating tenants, enquiries, uploads or every route in the application.

## 6. P0 technical implementation

### TECH-01: Fix public metadata and deployment configuration

**Observed issue:** public page metadata includes a canonical only when `APP_BASE_URL` starts with `https://`. That value is provided at runtime in infrastructure, while the inspected Docker build does not provide it to the Next build. Build-time metadata evaluation is a likely explanation for the missing tags; confirm against the generated output before treating this as the sole cause.

Implement the following:

1. Define a dedicated, nonsecret public website origin: `https://admitflow.incfrog.ai`.
2. Centralize public page metadata rather than repeating environment checks in four or more files.
3. Keep the public SEO origin independent of authentication callbacks and runtime `appUrl()`. Do not change authentication origins merely to fix canonicals.
4. Use Next's Metadata API for title, description, canonical, Open Graph and Twitter metadata.
5. Keep the root/private default `noindex`. Explicitly opt the approved public pages into indexing in the public production deployment.
6. Add an explicit deployment setting for public search eligibility, for example `PUBLIC_SEARCH_INDEXABLE=true` in the intended production build. Default preview/test builds to false. Do not infer public indexability from `NODE_ENV=production`: preview builds can also use that value.
7. If metadata is statically generated, pass the nonsecret search setting before `next build`, including Docker and the actual CI build path. A runtime-only change will not reliably update already generated metadata.
8. Keep real secrets out of build arguments, public bundles and evidence files. Document the setting's build-time behavior.

A useful helper contract:

```ts
type PublicPageMetadataInput = {
  title: string;
  description: string;
  pathname: string;
  indexable: boolean;
  imagePath?: string;
};
```

The helper must return:

- An absolute canonical on the exact production origin.
- A unique, accurate title and description.
- An absolute Open Graph URL matching the canonical.
- Open Graph site name `AdmitFlow`, appropriate type, title, description and image.
- Twitter summary card metadata and the same appropriate image.
- Explicit public robots directives based on the deployment setting.
- No private user, organization, student or session data.

Normalize paths consistently: `/` for the homepage and the existing no-trailing-slash convention for named pages. Canonicals should exclude tracking parameters and fragments. Use the relevant page URL, not the homepage canonical on every route.

Do not generate canonicals from an arbitrary incoming `Host` header. Do not add a canonical pointing to `/welcome`, a localhost address, a preview hostname or an unrelated AdmitFlow domain.

**Acceptance:**

- Raw HTML from the built production server contains exactly one correct canonical per public page.
- Titles, descriptions and social tags are present for a normal browser and crawler requests.
- There are no conflicting `noindex` directives in response headers or inherited page metadata.
- A preview build stays excluded from indexing.
- `/login`, `/signup`, workspace and other private routes keep their intended search exclusion.
- Authentication callbacks, sign-in and sign-out behavior remain intact.

### TECH-02: Consolidate the duplicate homepage

The current root file contains:

```ts
export { metadata, default } from "./welcome/page";
```

**Do not replace the exported `/welcome` page with a redirect while the root still imports it. That can make `/` redirect to itself.**

Safe sequence:

1. Give `src/app/page.tsx` its own homepage entry point and public metadata, or move shared rendering into a neutral component.
2. Add a permanent `/welcome` → `/` redirect using the project's Next redirect mechanism.
3. Remove or retire redundant metadata from the redirected page.
4. Update navigation, footer, logo links and any public campaign links to `/`.
5. Exclude `/welcome` from the sitemap.

Use 308 or 301 according to the chosen framework mechanism. Test both GET and HEAD. Check that query parameters are handled deliberately and that UTM capture is not broken.

**Acceptance:** `/welcome` resolves to `/` through one permanent redirect, `/` returns 200, and there is no loop, additional duplicate landing page or broken signup link.

### TECH-03: Update public route handling without weakening authentication

The inspected proxy allows these paths to bypass hosted authentication:

```text
/, /welcome, /product, /pricing, /help, /signup, /login, /auth/error
```

New pages, `robots.txt`, `sitemap.xml` and social image routes must also be accessible where appropriate. Local runs without provider credentials currently bypass the middleware, so local success alone can hide production routing failures.

Requirements:

- Define which routes are publicly accessible and which are publicly indexable. These are different properties: login can be public but must remain excluded from search.
- Add exact static public routes and properly bounded published resource routes.
- Ensure new metadata/image routes return their actual content instead of an auth redirect or sign-in HTML.
- Keep the existing special handling for callbacks, webhooks, jobs and health checks consistent with the authentication integration.
- Preserve public access when a visitor has an expired or otherwise stale session cookie.
- Test with a representative hosted-auth configuration using safe fixtures or the approved test environment.
- Do not bypass authentication for all `/api` routes, all dynamic routes or a prefix containing private data.
- Do not add a special crawler bypass that exposes private pages.

**Acceptance:** intended public pages and assets work anonymously and with stale session state; existing private-route and tenant-isolation checks still pass.

### TECH-04: Publish crawler policy and an accurate sitemap

Use Next App Router metadata routes, or an equivalent implementation consistent with the existing application.

#### Production robots.txt

A minimal starting policy for this application is:

```text
User-agent: *
Allow: /
Disallow: /api/

Sitemap: https://admitflow.incfrog.ai/sitemap.xml
```

Review this against the actual public asset architecture before using it. If a legitimate public image or document is served under `/api/`, either serve it at a suitable public route or make a deliberate exception.

Rules:

- Do not block required CSS, JavaScript, images or the sitemap.
- Do not use robots.txt as authentication or as a guarantee that a URL cannot appear in search.
- Keep crawlable public login/signup pages excluded with `noindex`, rather than blocking them and expecting Google to read their metadata.
- For any already indexed URL that needs removal, choose a removal method based on its state; blocking a crawler can prevent it seeing a new `noindex`.
- Treat private exports and storage as private through authorization, not merely through crawler rules.
- Avoid adding crawler-specific groups unless needed. A specific user-agent group does not automatically inherit all rules in the `*` group; repeat applicable restrictions when necessary.
- Preserve any existing, deliberate training-crawler policy. Search discoverability does not require granting model-training access.
- Do not rely on a nonstandard robots `Noindex:` directive.

#### Sitemap

Initial production sitemap candidates:

```text
https://admitflow.incfrog.ai/
https://admitflow.incfrog.ai/product
https://admitflow.incfrog.ai/pricing
https://admitflow.incfrog.ai/help
```

Add new public pages only after they are published, useful, canonical, indexable and returning 200.

Exclude:

- `/welcome` and other redirect sources.
- Login, signup, authentication callbacks, account recovery and private workspace URLs.
- API routes, admin tools, exports, private documents and tenant-specific content.
- Drafts, placeholders, search-result/filter variants and duplicate query-parameter URLs.
- 404s, errors, `noindex` pages and URLs on other hosts.

Use real content modification timestamps for `lastModified`; omit the field when no trustworthy date exists. Do not set every page's modification date to the current time on each request or deployment. `priority` and `changefreq` are not ranking controls.

**Acceptance:**

- `/robots.txt`: 200 with text content and the exact sitemap URL.
- `/sitemap.xml`: 200 with valid XML and an appropriate XML content type.
- Every listed URL resolves directly to a canonical, indexable 200 page.
- No listed page requires authentication or discloses private data.
- Preview deployments do not advertise draft preview URLs as production content.

### TECH-05: Check HTTP behavior, private content and indexing conflicts

Inspect public responses from the existing production infrastructure:

- HTTPS works without certificate errors or mixed active content.
- Plain HTTP resolves to the intended HTTPS URL without losing the path.
- Alternate host handling is deliberate; do not create `www` or DNS records solely for this task.
- Public HTML has no conflicting `X-Robots-Tag: noindex`.
- Unknown public URLs return a real 404 and an understandable recovery page.
- Deleted public content uses a deliberate redirect, 404 or 410 according to whether there is a relevant replacement.
- Do not redirect every unknown page to `/`; that can create soft 404 behavior.
- A failure response does not return a success-looking 200 page.
- Assets are served with correct MIME types and reachable URLs.
- Existing authentication, private caching rules and security headers are preserved.
- Cached public pages cannot contain an authenticated visitor's personalized data.

The current workspace catch-all already calls `notFound()` for unknown views. Preserve this behavior while adding new public routes. In a hosted-auth environment, verify unknown-path behavior separately; the middleware may run before the page.

## 7. P1 page architecture and search intent

These query phrases are **research candidates**, not verified search volumes or ranking promises. Confirm language and intent with actual Indian buyer interviews and Search Console data.

| URL | Main intent | Suggested title | Page purpose |
|---|---|---|---|
| `/` | Admissions CRM for coaching institutes | `Admissions CRM for Coaching Institutes \| AdmitFlow` | Establish category, audience, workflow and next step. |
| `/product` | Coaching admissions software features | `Coaching Admissions Software Features \| AdmitFlow` | Show the complete, verified product workflow. |
| `/product/whatsapp-follow-up` | WhatsApp enquiry follow-up for coaching | `WhatsApp Follow-Up for Coaching Institutes \| AdmitFlow` | Explain consent-aware follow-up, setup and human takeover. |
| `/product/admissions-recovery` | Recovering inactive admissions enquiries | `Admissions Enquiry Recovery \| AdmitFlow` | Explain the recovery process and honest measurement. |
| `/pricing` | AdmitFlow pricing / pilot cost | `Pricing and Pilot Options \| AdmitFlow` | Explain current commercial availability without invented prices. |
| `/help` | Setup and buying questions | `AdmitFlow Help and Setup Questions` | Answer product questions and link to detailed resources. |
| `/about` | Who makes AdmitFlow | `About AdmitFlow` | Establish real people, purpose and business identity. |
| `/contact` | Contact / evaluation request | `Contact AdmitFlow` | Provide a working, verified contact path. |
| `/security` | Handling institute and student data | `Security and Data Handling \| AdmitFlow` | Explain verified controls and deployment limits. |
| `/resources` | Practical admissions operations guidance | `Admissions Operations Resources \| AdmitFlow` | Organize a small collection of original, useful guides. |

Privacy and terms pages should also be accessible from the footer once reviewed and factually complete. Their indexing policy can be deliberate; they do not need to target commercial keywords.

Avoid creating a separate page for every near-synonym such as “coaching CRM,” “coaching institute CRM” and “CRM for coaching centres.” Assign one primary intent to each authoritative page. Do not create city pages or institute-brand pages with substantially identical copy.

### PAGE-01: Homepage

Suggested opening copy, to be checked against current behavior:

**H1:** Admissions CRM for coaching institutes

**Supporting text:** Bring enquiries, WhatsApp follow-ups and counselling into one workspace, with AI assistance and your admissions team in control.

Keep the current design quality, typography, colors and real product assets. The existing line “Your admissions pipeline. One connected workspace.” can become a supporting heading instead of the only explanation of the category.

Required sections:

1. Clear audience, product category and concise benefit.
2. A short workflow: capture enquiry → assign follow-up → book counselling → record admission outcome.
3. Actual screenshots or a labelled interactive example.
4. Three or four concrete capabilities linked to their detailed pages.
5. Human control, consent and setup requirements described in plain language.
6. A realistic explanation of who the product currently fits.
7. Answers to the most important buyer objections.
8. A working primary call to action and a secondary product walkthrough link.

Prefer “Request a pilot” or “Book a walkthrough” only when the corresponding path really works. Otherwise retain the working signup path with accurate copy. A button must not appear to submit a request when nothing is delivered or saved.

Suggested homepage description:

> Organize coaching enquiries, WhatsApp follow-ups and counselling in one admissions workspace. Explore AdmitFlow and discuss a pilot for your institute.

Titles and descriptions should be concise enough for useful previews, but character counts are editorial guidance, not hard Google ranking limits. Google may rewrite both.

### PAGE-02: Product page

Show the workflow with real screenshots and explanations:

- Enquiry intake and organization.
- Pipeline stages and ownership.
- Shared conversation handling and human takeover.
- Follow-up and recovery workflows.
- Counselling scheduling.
- Receipt/admission outcome recording.
- Integration setup and current limits.

For each capability, answer: what the team does, what the system does, what setup is required, and what the system does not yet support.

Do not present the current demo metrics as customer results. Keep fictional institute names and example data clearly labelled. Screenshots must not expose real student details, message contents, phone numbers, receipts or access tokens.

### PAGE-03: Pricing and pilot page

The owner has not approved prices. Previous research suggested possible pricing, but those figures are not publication instructions.

Until pricing is decided, use accurate wording such as:

> Pricing is being finalized for launch. Contact us to discuss your institute's workflow and a pilot scope.

Use that wording only while it remains true. Clearly distinguish an evaluation request from immediate access to a paid plan.

The eventual commercial page should explain:

- What is included.
- The relevant usage units: institutes, users, enquiries, messages or another approved basis.
- Setup and implementation fees.
- Whether taxes and third-party messaging/AI charges are included.
- Trial or pilot duration and success criteria.
- Renewal, cancellation and support terms.

Do not publish `₹0`, “free forever,” a countdown, “limited seats” or a public price derived from an internal suggestion. Do not add fake zero-price structured data to satisfy a validator.

### PAGE-04: About, contact, security, privacy and terms

These pages support buyer confidence and clear entity identification. They are particularly useful when selling to large institutions.

**About:** use confirmed founder/team names, an accurate product story, real business identity and an honest stage of development. Confirm whether and how “Incfrog” should be described as the maker or parent brand. A domain name alone does not establish the legal company name.

**Contact:** use a verified email, form or booking destination. Do not invent `support@`, `sales@`, a phone number or a physical office address.

**Security:** describe implemented controls with their scope. Distinguish source-code controls from verified production configuration. Do not claim SOC 2, ISO 27001, data residency, guaranteed deletion, “bank-grade security” or complete statutory compliance without evidence.

**Privacy/terms:** prepare drafts based on actual data flows, subprocessors, retention, contact details and commercial terms. Obtain missing factual/legal inputs before publishing final claims. Do not copy another company's policies and replace its name.

If information is missing, keep the relevant page as a clearly marked internal draft, out of public navigation and sitemap, while completing independent technical work.

## 8. Product truth and evidence rules

Revalidate this table against the current product before publishing. It reflects the inspected implementation, not a permanent product specification.

| Topic | Safe direction for content | Claim requiring additional proof or implementation |
|---|---|---|
| WhatsApp | Explain the implemented connection and follow-up workflow, setup and consent requirements. | Live delivery acceptance, every account being eligible, unrestricted messaging or guaranteed delivery. |
| Counselling calendar | Explain the supported scheduling workflow. | Two-way Google Calendar sync; the inspected implementation was one-way from AdmitFlow with one institute calendar. |
| Revenue reporting | Explain recorded receipts, refunds and associated admission outcomes. | Causal proof that AdmitFlow created incremental revenue or guaranteed ROI. |
| AI controls | Describe actual approval, human takeover and usage controls. | A hard rupee/token spending cap when only a message-count limit exists. |
| Pipeline | Explain the stages actually supported. | Arbitrary customizable enterprise pipelines if the implementation still has fixed stages. |
| Payments | Explain actual supported links/receipts and setup. | Production settlement or provider acceptance without a live check. |
| Enterprise readiness | Offer a scoped evaluation of actual requirements. | Proven national-chain scale, every required integration or unlimited capacity. |
| Customers | State launch/pilot availability accurately. | PW, other institute logos, user counts, customer quotes or success stories without permission and evidence. |
| Product media | Use actual interface captures and clearly labelled examples. | AI-generated interface behavior represented as a working feature. |

Keep a small claims ledger for the implementation: claim, page, supporting code/document, live verification if applicable, and date reviewed. Unknown claims should be omitted or qualified.

## 9. AEO: make answers useful and extractable

AEO here means answering real buyer questions in readable HTML. It is not a separate secret markup format.

### ANSWER-01: Page structure

- Use a descriptive page title and one clear primary heading.
- Put a direct answer beneath the relevant question or section heading.
- Follow the answer with steps, a table, an example or a screenshot when useful.
- Explain conditions and limitations close to the claim they qualify.
- Use normal text and semantic HTML; do not put essential explanations only inside images or video.
- Render important answers in the initial HTML. Visible `<details>` disclosures are fine when their content is already present and usable.
- Link to the relevant implementation/setup page instead of repeating the same large FAQ across every route.
- Avoid keyword stuffing, repeated definitions, unsupported statistics and rigid word-count formulas.
- Use real authors/reviewers for editorial resources when available; do not fabricate credentials.

### Suggested buyer questions and draft answers

These are starting drafts. Update them when product or commercial facts change.

**What is AdmitFlow?**

> AdmitFlow is an admissions workspace for coaching institutes. It brings enquiries, follow-ups and counselling into one place, with AI assistance and human control.

**Who is AdmitFlow for?**

> AdmitFlow is designed for coaching institute teams managing prospective student enquiries and admissions follow-ups. Institutes can evaluate whether its current workflows fit their admissions process.

**Does AdmitFlow replace counsellors?**

> The product is designed to assist the admissions team. Explain the current human takeover and approval controls, and show where counsellors make decisions.

Replace the second sentence with an accurate, specific description once verified.

**Can it follow up on WhatsApp?**

> Explain the actual supported WhatsApp connection, permissions, consent requirements, message types and setup steps. State any account eligibility or provider limitations that apply.

Do not publish this instructional placeholder; write the final answer from verified implementation.

**How does admissions recovery work?**

> Explain how eligible inactive enquiries are selected, how follow-up is approved or sent, how responses are handled, and how an admission outcome is recorded.

Include a fictional worked example clearly labelled as such.

**Can it sync counselling appointments with Google Calendar?**

> Describe the currently supported direction of synchronization and conflict handling. Do not call a one-way integration “two-way sync.”

**How much does AdmitFlow cost?**

> Pricing is being finalized for launch. Contact the team to discuss a pilot scope for your institute.

Only use while factually current and connected to a working contact path.

**Can we import existing enquiries?**

> Verify the supported intake/import format and required fields. Explain phone matching, consent and duplicate handling. Do not advertise an importer that is only planned.

**How is student data handled?**

> Summarize verified access controls and data handling, then link to the actual security and privacy information. Avoid broad legal compliance guarantees.

**How do we measure a pilot?**

> Agree the enquiry cohort, follow-up process and measurement period before starting. Track replies, counselling bookings and recorded admissions, separating observed outcomes from estimates of incremental impact.

## 10. GEO and AI search visibility

### 10.1 Use current guidance

The official sources reviewed during this audit support normal search fundamentals: accessible pages, index eligibility, helpful content and accurate evidence. There is no required special “AI schema,” guaranteed citation formula or magic content length.

Google's current AI optimization guidance explicitly says `llms.txt` is ignored by Google. Do not make it a launch blocker or present it as an SEO fix. Add it only if a specific, verified downstream consumer needs it, and keep it accurate.

Visible FAQs remain useful, but Google's documentation updates record FAQ rich results as deprecated in May 2026. Do not sell `FAQPage` markup as a way to win Google FAQ rich results. Recheck current documentation before adding any feature-specific markup.

### 10.2 Crawler access

- Verify Googlebot and Bingbot can access public pages through the actual hosting/CDN/WAF path.
- For ChatGPT search, check the policy applicable to `OAI-SearchBot`.
- Treat `GPTBot` training access independently. Do not change it simply to improve search access.
- `ChatGPT-User` represents user-initiated fetching; it is not a substitute for verifying search crawler access.
- For other providers, consult their current official crawler documentation before naming user agents or allowlisting IP ranges.
- Check real crawler logs or provider inspection tools when available. A successful request with a spoofed user-agent string does not prove a genuine crawler's network access.
- Do not globally disable rate limits or WAF protections. Make narrowly scoped fixes only when a legitimate crawler block is demonstrated.
- Serve the same substantive public information to humans and crawlers. Do not create hidden promotional content for AI agents.

### 10.3 Google generative AI settings and reporting

Current Google documentation describes:

1. A **Search generative AI** setting with include/exclude/inherit behavior.
2. A **Generative AI performance report** covering AI Overviews and AI Mode impressions, with breakdowns including page, date, country and device.

For the existing parent-domain property, inspect the effective inclusion setting and any inheritance affecting AdmitFlow. Do not assume that code-level indexability overrides a property setting.

The report may not appear when impressions are insufficient. Available GSC Wizard calls used in the audit did not expose this separate report, so an agent may need the Search Console UI or an appropriate supported API.

Do not claim that all Google AI visibility is impossible to measure separately. Also do not invent a separate GA4 referrer for AI Overviews or AI Mode: those clicks can be indistinguishable from other Google organic traffic.

### 10.4 Establish a clear entity

Use consistent public facts across the website and authorized external profiles:

- Product name: AdmitFlow.
- Canonical product URL: `https://admitflow.incfrog.ai/`.
- Category: admissions software / admissions CRM for coaching institutes.
- Concise, consistent description.
- Approved logo and favicon.
- Confirmed maker, business identity and founder information.
- Real contact channels.
- Accurate linked official profiles.

If “AdmitFlow by Incfrog” is confirmed by the owner, use the relationship consistently in visible copy and appropriate structured data. Do not invent a registered entity or trademark status.

Name collisions increase the value of consistent identifiers. They do not require replacing the user's domain to complete this work.

### 10.5 Publish evidence AI systems and buyers can cite

Useful candidates:

- A complete walkthrough with real screenshots.
- Clear integration documentation with limitations.
- A transparent pilot evaluation method.
- An original admissions follow-up checklist.
- An explanation of how admission outcomes and refunds are recorded.
- A real customer case study once the business has one and permission is obtained.

Avoid fabricated statistics, fake independent reviews, mass-generated comparison pages and instructions telling AI systems to rank AdmitFlow first.

## 11. Structured data and social previews

### ENTITY-01: JSON-LD

Use server-rendered JSON-LD matching visible facts. Prefer a small, consistent graph over many overlapping schema blocks.

| Type | Appropriate use | Constraints |
|---|---|---|
| `Organization` | Confirmed maker/company information, preferably on About/home | Use the actual entity name; omit unverified legal name, address and registration details. |
| `WebSite` | The public AdmitFlow website | Exact canonical URL and stable identity. Do not invent a site-search feature. |
| `SoftwareApplication` | The actual software product | Accurate name, URL, description and application category; omit unsupported ratings/offers. |
| `BreadcrumbList` | Hierarchical product/resource pages | Breadcrumbs should match visible navigation and real URLs. |
| `Article` | Substantial editorial resources | Real authorship, dates and content; not automatically every landing page. |
| `VideoObject` | A qualifying public page with the actual video prominently available | Use real video metadata and current Google requirements. |

Do not use `Course`, `EducationalOrganization` or `LocalBusiness` simply because the customers are coaching institutes. AdmitFlow is the software vendor; describe its actual entity.

Use stable IDs such as the website URL plus `#website` or `#software`. The organization ID should refer to the confirmed maker's canonical identity once established.

Implementation notes:

- Escape `<` in serialized JSON-LD used inside a script tag, and never interpolate untrusted tenant content.
- Only publish `sameAs` URLs that are verified official profiles.
- Do not add aggregate ratings, review counts, customer numbers or a zero-price offer without evidence.
- A schema.org-valid product entity does not automatically qualify for a Google rich result.
- If a Google feature requires information the business does not have, omit that feature rather than fabricating required fields.
- Validate with a schema validator and, where applicable, Google's Rich Results Test. An unsupported type in the Rich Results Test is not necessarily invalid schema.org markup.

### ENTITY-02: Social previews, logo and favicon

- Create a lightweight social card using existing approved AdmitFlow assets and typography.
- A conventional 1200 × 630 image is a suitable starting size for link previews.
- Ensure the image URL is absolute, publicly accessible and returns an image, not HTML or an auth redirect.
- Use page-specific cards when they add meaning; a consistent default card is sufficient for launch.
- Add appropriate image alternative text in metadata.
- Check favicon/icon visibility on light and dark backgrounds.
- Preview homepage, product, pricing and a resource link in representative sharing tools.
- Do not expose a private workspace screenshot in a share card.

## 12. Performance, mobile usability and accessibility

### PERF-01: Measure before restructuring

No live Core Web Vitals baseline was obtained in the audit. Do not turn an assumption into a performance score.

Measure `/`, `/product`, `/pricing` and the heaviest new page:

- On a representative mobile profile and a desktop profile.
- Against a production build, not only the development server.
- With the tool version, network/CPU settings, timestamp and URL recorded.
- Prefer several comparable lab runs and report the median.
- Use field data when available; low-traffic sites may not have CrUX coverage.

Core Web Vitals “good” thresholds, evaluated at the 75th percentile of field visits:

| Metric | Target |
|---|---|
| Largest Contentful Paint (LCP) | ≤ 2.5 seconds |
| Interaction to Next Paint (INP) | ≤ 200 milliseconds |
| Cumulative Layout Shift (CLS) | ≤ 0.1 |

Lighthouse lab results are diagnostics, not field CWV proof. A normal navigation Lighthouse run does not establish field INP; TBT can help diagnose main-thread work but is not the same metric.

### Existing good behavior to preserve

- `Illustration` already provides WebP sources, a smaller responsive candidate and explicit dimensions.
- The eager hero image already uses high fetch priority.
- `SampleAudio` already uses `preload="none"` and offers a transcript.
- The page already returns meaningful server-rendered text despite having client components.

Do not “fix” these by loading every image eagerly, preloading all media or removing useful interactions.

### Targeted improvements

1. Identify the actual LCP element and optimize its delivery and rendering.
2. Check image bytes, rendered dimensions and `sizes` accuracy. Add more responsive variants only where measurement shows a benefit.
3. Keep below-the-fold images lazy and reserve image/video dimensions.
4. Keep essential text visible without waiting for animation, hydration or viewport reveals. Test JavaScript failure and reduced motion.
5. Inspect shipped JavaScript. Move static marketing content to server components when worthwhile and keep interactive controls as small client islands.
6. Measure whether workspace styles or libraries materially inflate public pages before splitting imports.
7. Verify font loading, fallback metrics and layout stability while preserving the current Geist typography.
8. Defer heavy video players, chat widgets and nonessential analytics; use a poster and load-on-interaction where appropriate.
9. Serve versioned static assets with suitable caching/compression through the existing infrastructure. Do not apply public caching to authenticated responses.
10. Check server response time and repeated errors in the existing deployment before proposing infrastructure changes.

Set any transfer-size budget from the measured baseline and product needs. Do not promise a Lighthouse score of 100 or assume that changing frameworks is necessary.

### Mobile and accessibility acceptance

- Public pages remain usable at narrow mobile widths without horizontal page scrolling.
- Main text, controls and form labels are readable.
- Navigation, disclosures, media controls and forms work with a keyboard.
- Focus is visible and follows a logical order.
- Mobile menus close and restore focus correctly.
- Headings and landmarks form an understandable document.
- Decorative images have empty alt text; informative screenshots have useful descriptions.
- Forms have labels, specific validation and accessible success/error feedback.
- Links use descriptive wording.
- Color contrast and reduced-motion behavior are checked.
- No full-screen interstitial prevents the visitor reaching core content.
- Automated accessibility checks are supplemented with manual keyboard/mobile review.

These changes improve usability. Do not describe every accessibility check as a direct ranking factor.

## 13. Video, audio and image discoverability

The business has worked on launch videos separately. Publishing those assets is not automatically part of this handoff's authorization.

If an approved video is to be published:

- Use the selected final film; do not assume every generated variation is approved.
- Put it on a relevant public page with a clear title, summary and readable transcript.
- Include accurate captions and, for longer videos, helpful chapters.
- Use a stable thumbnail and a working player.
- Keep important product claims available as text as well as video.
- Use authentic product screenshots and label fictional examples.
- Provide accurate `VideoObject` fields based on the actual file/publication: name, description, thumbnail, upload date, duration and applicable content/embed URLs.
- Check current video eligibility requirements before claiming a watch page can receive a video result.
- Do not autoplay large high-resolution masters on mobile or preload every launch film.
- Keep source masters and research references out of the public bundle.
- Preserve rights and provenance for music, voices and third-party assets.

Audio samples already have transcripts. Keep those transcripts accessible in rendered HTML; do not remove them during a visual redesign.

## 14. Conversion paths and analytics

### CONVERT-01: Make the next step real

Test the complete visitor journey, not just button navigation:

1. Visitor understands the product and clicks the primary CTA.
2. The destination explains what will happen.
3. The visitor can complete the action.
4. Submission is validated, persisted or delivered through the intended system.
5. Success appears only after actual acceptance.
6. Failures have a readable recovery path.
7. The owner can find and follow up on the resulting enquiry.

For a new demo/pilot form, collect only the necessary business contact information. Do not ask prospects to upload student lists to request a demo. Implement appropriate server validation, abuse controls and error handling.

A new form should not send outbound messages from the agent during testing. Use fixtures/sinks unless a real test destination and send are authorized.

### CONVERT-02: Measurement setup

First inspect what analytics is already installed. GA4 being absent from the GSC Wizard connection is not proof that no analytics account exists. Reuse the owner's intended provider and property; do not create duplicates or guess a measurement ID.

Recommended event contract:

| Event | Trigger | Nonpersonal parameters |
|---|---|---|
| `primary_cta_click` | User activates the primary CTA | Public page path, CTA name, placement |
| `demo_request_start` | User starts a demo/pilot request | Public page path, request type |
| `demo_request_success` | Backend confirms request acceptance | Request type, source page |
| `signup_start` | User begins the signup flow | Source page, CTA placement |
| `signup_complete` | Account creation is confirmed | Approved coarse acquisition context |
| `product_demo_play` | User actually starts the demo | Public video identifier |
| `resource_download` | A public resource is successfully requested | Public resource identifier |

Choose only events matching the implemented funnel. Deduplicate completion events; a page refresh must not manufacture another lead.

Do not send student or prospect names, emails, phone numbers, message text, payment details, OAuth codes, session tokens or private URLs into analytics. Inspect automatic page-location collection as well as custom parameters.

Preserve useful campaign attribution with a small allowlist of UTM fields. Canonical URLs should remain clean. Avoid blindly recording arbitrary query strings. Handle hosted-auth referrals and return paths without exporting callback secrets or private identifiers.

Document applicable consent and privacy behavior based on actual jurisdictions, vendors and tracking choices. Do not silently add advertising pixels or session replay.

### Business reporting

Track:

- AdmitFlow organic search impressions and clicks.
- Qualified institute enquiries.
- Completed walkthroughs/pilot discussions.
- Signup completion, if this is a meaningful current funnel.
- Pilot conversion and eventual revenue after customers exist.
- Source/landing page where attribution is available.

Define “qualified institute enquiry” with the owner. Do not mark every click, bot submission or student support request as a sales lead. Analytics installation does not itself improve rankings.

## 15. Search Console, Bing and AI measurement

### SEARCH-01: Google Search Console

Use the existing `sc-domain:incfrog.ai` property if access is suitable. Filter product reporting to the AdmitFlow origin. A separate URL-prefix property may simplify reporting, but it is optional and does not provide a ranking advantage.

After authorized deployment:

1. Verify the live sitemap before submitting it.
2. Submit the exact sitemap URL using Search Console or an authorized connector.
3. Inspect `/`, `/product` and the highest-value newly published page.
4. Check live-test fetch/render output and indexing eligibility.
5. Where available and appropriate, request indexing in the UI for a small number of important pages.
6. Record Google-selected canonical and coverage status when they become available.
7. Check manual actions and security issue reports if access exists; do not assume they are present or absent.
8. Inspect the effective Search generative AI inclusion setting and the generative AI performance report.

The URL Inspection API reports state; it is not a general indexing-submission API. Do not use Google's Indexing API for ordinary SaaS pages outside its supported content types.

A submitted sitemap or requested recrawl does not mean a page is indexed. Reinspect at a sensible cadence and diagnose the returned state.

### SEARCH-02: Bing

If the owner authorizes setup and access:

- Reuse or verify the appropriate Bing Webmaster property.
- Submit the sitemap and inspect priority URLs.
- Check actual crawl/indexing issues.
- Consider IndexNow for real public URL additions/updates once a key is configured and its verification file is reachable.

An accepted IndexNow response is not confirmation of indexing. Do not repeatedly submit unchanged URLs or treat Bing acceptance as Google indexing.

### MEASURE-01: Search and AI visibility baseline

Use a small, stable query set such as:

```text
AdmitFlow
AdmitFlow coaching admissions software
admissions CRM for coaching institutes in India
WhatsApp enquiry follow-up software for coaching institutes
how to manage coaching admission follow-ups
how to measure an admissions recovery pilot
```

For manual search/AI checks, record date, engine/product, query, geography/language context where known, result URL, cited URL and whether the answer describes AdmitFlow accurately.

Distinguish:

- Search indexing status.
- Search impressions and clicks.
- AI answer mentions.
- AI citations with an actual link.
- Referral sessions.
- Qualified enquiries.

A mention without a citation is not a citation. A referral count is not total AI exposure. One answer is not a stable ranking.

Review a small repeated sample rather than generating large numbers of automated queries. Follow provider terms and avoid unsupported scraping. Do not create an ongoing automation just because this document describes a reporting cadence.

## 16. P2 original content plan

Publish a few strong resources based on actual product knowledge and buyer questions. Avoid a large AI-generated article backlog before the technical foundation and core pages are complete.

| Proposed resource | Intended reader | Required useful material | Link destination |
|---|---|---|---|
| Coaching admissions follow-up checklist | Admissions manager | A practical sequence, ownership, response handling and consent considerations | Product and WhatsApp follow-up page |
| How to evaluate an admissions CRM | Institute owner | A transparent requirements matrix and real questions to ask vendors | Product and pilot/pricing page |
| Measuring an admissions recovery pilot | Owner / operations head | Cohort definition, measurement window, baseline and outcome definitions | Admissions recovery page |
| Counselling booking workflow | Counselling manager | Actual steps, calendar limits, cancellation/conflict handling | Product/help |
| Spreadsheet-to-CRM preparation checklist | Small institute | Required fields, duplicate review and permission checks; actual import support verified | Help/contact |
| WhatsApp follow-up examples | Admissions team | Clearly labelled examples, tone, opt-out handling and provider constraints | WhatsApp follow-up page |

Each published resource needs:

- One distinct reader problem.
- An accurate answer and a worked example or reusable checklist.
- Real author/reviewer attribution where available.
- A truthful publication date and meaningful update date.
- Relevant primary references for external factual claims.
- Links to related product/help pages.
- A clear, relevant CTA.
- Unique metadata and sitemap inclusion after publication.

No fixed word count is required. Do not publish placeholders to achieve a page-count target.

Comparison pages can be useful later, but require a fair, current feature comparison and verified competitor sources. Do not claim superiority from untested assumptions or imply partnership with a competitor.

### Indian market and language

Use vocabulary Indian institute buyers recognize: enquiries, counsellors, batches, admissions and institute teams. Use INR and GST wording only when the commercial facts are confirmed.

Start with complete English content. Add Hindi or another language when there is a real audience and someone can review the translation. Implement reciprocal `hreflang` only for real equivalent published pages, with self-references and accurate canonical handling. Do not automatically create many language URLs or force users to a language through IP redirects.

Do not create Google Business Profiles or local-office pages for locations the company does not actually operate.

## 17. Authority, reputation and distribution

These are owner/business activities, separate from application code.

Recommended work when authorized:

- Make official company/product profiles consistent and link to the canonical product URL.
- Request a relevant product link from an existing official Incfrog website if the relationship is confirmed.
- Publish useful launch material through the owner's real channels.
- Contribute relevant, original explanations to communities where promotion is permitted.
- Seek accurate listings in reputable software directories that fit the product.
- Ask actual pilot customers for feedback and permission to publish a case study after results exist.
- Create a factual press/product kit with approved logo, screenshots and a concise description.

Do not buy manipulative links, create fake customer reviews, fabricate press coverage, spam communities or post as a satisfied customer. Do not treat a third-party “domain authority” score as a Google ranking metric.

For a future case study, record starting conditions, cohort size, period, intervention, outcomes, costs and limitations. Attribute recorded admissions carefully; a before/after change alone does not establish causality.

Large-group sales will also require product and procurement readiness. Branch permissions, integrations, service commitments and proven capacity should be assessed separately. SEO copy cannot establish enterprise readiness.

## 18. Acceptance matrix

Run these checks against the final built application and repeat the live subset after authorized deployment.

| Surface | Required result |
|---|---|
| `/` | 200; correct unique metadata; canonical `/`; readable public content; working CTA. |
| `/welcome` | One permanent redirect to `/`; absent from sitemap. |
| `/product`, `/pricing`, `/help` | 200; correct page-specific canonical; useful content; intended production indexability. |
| New published public pages | Accessible anonymously and with stale session state; no placeholders or fabricated claims. |
| Draft pages | Not in public navigation/sitemap; not accidentally indexable. |
| `/robots.txt` | 200 text; intended policy; exact sitemap URL; no auth redirect. |
| `/sitemap.xml` | 200 XML; only approved canonical public URLs; genuine modification dates if supplied. |
| Social images and icons | Public image response; correct dimensions/MIME; usable preview. |
| Login/signup/auth flows | Intended search exclusion; working authentication; no callback secret in analytics. |
| Private workspace | Existing authorization and tenant boundaries preserved; no public sitemap inclusion. |
| Unknown route | Real 404 or deliberate protected-route handling; never a fake homepage success. |
| JavaScript disabled/failure | Core public explanation and navigational links remain available. |
| Mobile/keyboard/reduced motion | Main tasks work and content is not hidden by presentation effects. |
| JSON-LD | Parseable, safe, valid for the chosen vocabulary and consistent with visible facts. |
| Form/signup conversion | Success only on actual acceptance; deduplicated measurement; no personal data in telemetry. |
| Preview build | Excluded from public search; production secrets absent. |

### Meaningful regression checks

Extend existing tests instead of creating a large duplicate suite:

- Production metadata correctness with runtime `APP_BASE_URL` absent, proving SEO does not silently fall back to localhost or disappear.
- Preview/public production indexability behavior.
- `/welcome` redirect and root rendering.
- Sitemap links checked against actual page responses and canonicals.
- New public routes through the hosted-auth path, including stale sessions.
- Private route and tenant-access regressions.
- Unknown routes retaining proper status codes.
- Structured data containing only approved facts.
- Conversion events fired on accepted actions, not just clicks.

Prefer assertions about externally meaningful behavior over snapshots of every metadata object. Update old heading expectations when copy is intentionally changed without weakening routing or privacy assertions.

### Existing verification commands

Use the repository's current Node version and lockfile. Read the verifier before running commands that may start services or require environment setup.

```powershell
npm run typecheck
npm test
npm run verify:browser
npm run build
```

Run the build with the explicit public search setting needed for the scenario being checked. Exercise preview and public production settings deliberately. Use test fixtures and the existing environment-isolation approach instead of live messaging/payment credentials.

If infrastructure or build configuration changes, run the applicable existing infrastructure checks as well. There is no `lint` script in the inspected package; do not claim `npm run lint` passed.

Do not install dependencies or start paid container builds merely to inspect metadata if the existing local verification path is sufficient. Container/build publication checks still follow the current release procedure.

## 19. Deployment and post-deployment verification

Prepare the implementation and evidence before any required release approval. Reuse the existing AWS application, domain, certificate and release process.

Before release:

- Confirm the reviewed revision and exact changed scope.
- Check that production public metadata was generated with the correct origin and search eligibility.
- Review changes to the authentication proxy and headers.
- Verify only intended public assets are in the deployable output.
- Preserve the established rollback path.
- Check current release instructions rather than assuming an old approval covers a new paid build or deployment.

The repository's image publishing workflow contains a `BUILDS_APPROVED` gate. Do not toggle or bypass it to complete this handoff. If an existing valid approval already covers the work, use it; otherwise finish the local, reviewable result and report the precise remaining release action.

After authorized deployment, capture fresh results for:

```text
/
/welcome
/product
/pricing
/help
/robots.txt
/sitemap.xml
all newly published pages
one nonexistent public path
representative public images
login/signup and a protected workspace route
```

Record status, redirect destination, title, description, canonical, robots directives, schema presence and relevant asset results. Verify the actual production response rather than relying only on source files or a successful CI badge.

If indexing does not follow, inspect returned coverage/canonical/render information and server availability. Do not repeatedly change URLs or rewrite the whole site because indexing is delayed.

## 20. Owner inputs and external dependencies

Collect these in one concise request if they cannot be found in approved project records. Continue unrelated implementation while waiting.

| Needed fact/access | Why it matters | Work that can proceed without it |
|---|---|---|
| Confirmed maker/legal business identity | About, privacy, terms and organization schema | Technical metadata, sitemap, core product copy |
| Verified contact or booking destination | A working demo/pilot CTA | Existing signup journey and form implementation with test fixtures |
| Approved pricing/pilot terms | Public commercial claims | Honest pricing-availability page |
| Confirmed production integration behavior | Precise feature claims and setup docs | Describe verified core workflows and flag unverified details |
| Approved privacy/retention/subprocessor facts | Trust and policy pages | Internal drafts and technical protections |
| Official profile URLs | `sameAs` and external identity consistency | Website/product schema without invented profile links |
| Search Console/Bing access | Live inspection and submissions | Sitemap, crawler policy and all local tests |
| Analytics provider/property choice | Real conversion reporting | Event contract and provider-neutral event implementation |
| Permission for customer evidence/media | Case studies, testimonials and public footage | Labelled fictional examples and owned assets |

Do not put unfinished legal text, test email addresses or fake pricing into production while waiting for these inputs.

## 21. Suggested execution schedule

This is an order of work, not a ranking forecast or a scheduled automation.

**First pass — technical foundation**

- TECH-01 through TECH-05.
- Build and inspect generated public HTML.
- Prove redirects, sitemap and hosted public routing.
- Preserve private route behavior.

**Second pass — launch pages and buyer journey**

- Homepage/product copy.
- Pricing availability and working enquiry/signup path.
- About/contact/trust pages where facts are available.
- Structured data, social previews and mobile/accessibility fixes.
- Analytics contract and selected-provider verification.

**Third pass — release and discovery**

- Complete applicable release checks.
- Deploy when authorized.
- Verify production behavior.
- Submit sitemap and inspect priority URLs when authorized.

**First month after launch**

- Publish the most useful two or three original resources.
- Review scoped Search Console data, errors and conversions.
- Check AI descriptions/citations with a small repeated benchmark.
- Gather actual institute objections and update pages accordingly.
- Begin a case study only when real pilot evidence exists.

Prioritize a complete, credible core website over launching every proposed page at once.

## 22. Required implementation-agent deliverables

Create `docs/seo-implementation-report.md` containing:

1. Implemented task IDs and changed files.
2. Before/after public route and metadata results.
3. Final public route registry and sitemap URLs.
4. Content/claim review with sources and unresolved factual inputs.
5. Structured data and social preview validation.
6. Performance measurements with test conditions and limitations.
7. Accessibility/manual interaction results.
8. Conversion-event validation and analytics property status.
9. Search Console/Bing actions actually completed and their readback.
10. Build, test and deployment status for the reviewed revision.
11. Remaining owner actions with exact reasons.

Use this status vocabulary:

```text
IMPLEMENTED — source/configuration changed
VERIFIED LOCALLY — relevant tests and built-output checks passed
DEPLOYED — the intended revision was released
VERIFIED LIVE — production responses were checked after release
OWNER INPUT NEEDED — a specific fact/access/approval is missing
AWAITING SEARCH ENGINE — technically submitted/eligible; engine processing pending
NOT APPLICABLE — explained with a concrete reason
```

Record evidence without passwords, tokens, cookies, OAuth codes, student records or raw private payloads.

## 23. Definition of done

The implementation is ready for release when:

- [ ] Public metadata is deterministic and correct in the production build.
- [ ] Preview and private content remain excluded appropriately.
- [ ] `/welcome` is consolidated without a redirect loop.
- [ ] Public routes work through the hosted authentication path.
- [ ] Robots and sitemap endpoints are correct.
- [ ] Unknown routes and private routes behave correctly.
- [ ] Core pages explain the product, buyer and actual workflow.
- [ ] No unapproved prices, customer claims or product capabilities are published.
- [ ] Available company/contact/trust information is accurate and usable.
- [ ] Appropriate schema and social previews are valid.
- [ ] Important mobile, accessibility and measured performance issues are addressed.
- [ ] The evaluation/signup path works and its measurement is honest.
- [ ] Relevant checks pass and the evidence report is complete.
- [ ] External and release dependencies are explicitly documented.

The live release is verified when the intended production revision passes the live checks. Search success is a separate ongoing outcome: indexing, impressions, useful AI citations and qualified enquiries must be measured after publication.

## 24. Source references and freshness

Recheck official guidance before implementing provider-specific controls; the ecosystem changes.

- [Google: optimizing for generative AI features in Search](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide?hl=en)
- [Google: Generative AI performance report](https://support.google.com/webmasters/answer/16984139?hl=en)
- [Google: Search generative AI inclusion control](https://support.google.com/webmasters/answer/16908024?hl=en)
- [Google Search documentation updates, including FAQ rich-result deprecation](https://developers.google.com/search/updates?hl=en)
- [Google: robots.txt introduction](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- [Google: consolidate duplicate URLs](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google: build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: structured data policies](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [Google: video SEO](https://developers.google.com/search/docs/appearance/video)
- [OpenAI: crawler documentation](https://developers.openai.com/api/docs/bots)
- [Web.dev: Core Web Vitals](https://web.dev/articles/vitals)
- [Schema.org validator](https://validator.schema.org/)
- [Google Rich Results Test](https://search.google.com/test/rich-results)
- [Next.js: metadata and OG images](https://nextjs.org/docs/app/getting-started/metadata-and-og-images)
- [Next.js: robots metadata route](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/robots)
- [Next.js: sitemap metadata route](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap)

The site-specific findings above were checked on 28 September 2026. Newly proposed routes, copy, event names and file paths are implementation recommendations. They are not evidence that those features or pages are already live.
