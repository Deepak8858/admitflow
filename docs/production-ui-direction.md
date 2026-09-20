# AdmitFlow — production UI direction

Direction recorded 12 September 2026; documentation refreshed 19 September. **Accepted direction implemented across the light 12-screen workspace.** Use the [README handoff](../README.md) and [verification ledger](verification.md) for dated browser-test results, commands and scoped evidence, including the chart/200% CSS-zoom fix. Recorded runs do not validate subsequent review repairs or live-provider behavior.

## Accepted direction and current implementation

[Attio's contact workspace](https://mobbin.com/screens/5bb2a956-b937-497e-bd31-afc2616bb111) is the accepted primary reference. Its light navigation, table hierarchy, selection feedback and contextual actions inform AdmitFlow's implemented enquiry/owner/conversation workspace.

The earlier local MVP's visual direction has been replaced. The application now has a light grouped sidebar, shared controls, paginated enquiry table, contextual record drawer, working inbox, recovery/counselling pages and administration screens. Build/typechecking and local browser, viewport and scoped accessibility results are recorded separately in the linked release evidence; build success alone is not UI acceptance.

## Review method and image budget

- The user reduced the original research request to a maximum of 20 images, then requested fewer images.
- The earlier reference review used **8 images, representing 8 unique Mobbin screen IDs**. Each search requested one result, and each returned image was visually inspected at that time.
- Earlier broad searches are not included in this count. This is a focused shortlist, not a claim to have completed a 100-screen review.
- The earlier reference review used direct Mobbin tools; its observations are retained below. The user subsequently authorized parent-assigned subagents for implementation.
- This document contains source links and observations; screenshots are not embedded or bundled with the application.
- **These eight references are sufficient.** Resume from the current components/CSS and recorded browser-QA findings; do not fetch new Mobbin images or load skills for another design-selection pass.

## Inspected references

The visible-evidence column preserves the prior screenshot observations, not a new image inspection. Adaptations identify the applied patterns and remaining ideas; neither the reference images nor this source review establish browser-test results.

| ID | Mobbin reference | Visible evidence | AdmitFlow adaptation |
| --- | --- | --- | --- |
| R01 | [Attio — contacts and bulk selection](https://mobbin.com/screens/5bb2a956-b937-497e-bd31-afc2616bb111) | Light grouped sidebar; Contacts heading; view selector; Sort/Filter; grid columns for person, contact details, company and status; three selected rows; contextual bottom actions. | **Primary reference.** Implemented paginated enquiry views, filter/sort/display controls, selection and bulk member-ID assignment. Saved filters and built-in `view`/`sort` preferences persist server-side. |
| R02 | [Twenty — people table](https://mobbin.com/screens/d0dc59c9-10b0-4896-a01a-ec954d8fd213) | Narrow light navigation; a simple People heading; New Person action; five visible rows; Filter/Sort/Options; substantial open space below the table. | Applied clear page hierarchy and restrained borders, with the richer selection pattern from R01 for recovery work. |
| R03 | [Attio — company record activity](https://mobbin.com/screens/297adfeb-8312-496b-8acf-41839a6cf775) | A company record, sweetgreen, with Activity/Emails/Team/Notes/Tasks/Files tabs; chronological attribute changes; right-side record details; top contextual actions. | Implemented enquiry drawer with properties/history and contextual inbox, counselling and receipt actions. `?lead=<id>` preserves the surrounding page; a separate full-page record route remains future scope. |
| R04 | [Attio — sales pipeline template preview](https://mobbin.com/screens/e275641a-a3e8-440a-b53e-983bb9cec7c7) | A template-preview modal containing stage columns, counts and cards with company, value, date, owner and activity indicators; an attributes panel on the right. | Implemented fixed-stage cards with owner, next action and potential course value, plus drag and explicit stage-select controls. Configurable stage definitions remain roadmap work. |
| R05 | [Front — shared inbox thread](https://mobbin.com/screens/3548f0dd-75c6-4797-af55-6f282ba8a5a7) | Folder navigation, conversation list, open thread, assignee control in the header, muted system events, Reply action and an internal-comment composer. A narrow integration rail is visible at the right. | Implemented conversation list/thread/context layout, reply/note/draft controls, attachments, AI/human ownership and explicit provider-outcome states. |
| R06 | [Customer.io — workflow and selected-step editor](https://mobbin.com/screens/773dc504-362f-4bce-a732-dfce6f95f9d1) | A vertical trigger/email/wait/generate-content/exit sequence; selected step outlined; editing panel with content choices and a visible missing-credit warning. | Implemented short delay playbook, assistant settings and run history. Arbitrary condition graphs, selected-step editing and versioned publishing remain future work. |
| R07 | [Shopify — analytics overview](https://mobbin.com/screens/35153b56-4d7f-4398-ae6b-2fefaba5d024) | Date/comparison/currency controls; compact metrics; a large sales-over-time chart beside a gross-to-net breakdown; channel and product breakdowns below. | Implemented date/course-aware collected-fee reporting, refunds/net, source breakdowns, chart data and payment ledger. Admissions charts and headlines share distinct-student reporting. |
| R08 | [Cal.com — filtered bookings](https://mobbin.com/screens/0e77a5a7-a1e2-4e67-a35f-44b3eca5cf08) | Upcoming/Unconfirmed/Recurring/Past/Canceled tabs; event-type and attendee filters; an open filter editor; booking row with date/time, meeting details, Cancel/Edit and pagination. | Implemented counselling agenda/calendar controls, booking/reschedule/cancel actions and explicit local/pending/synced/failed status. Google synchronization is one-way. |

## Applied principles

1. **Daily work has a clear starting point.** The current landing route is Overview, with receipt-backed metrics, recovery priorities, upcoming counselling and open tasks. Dedicated Today/team-performance routes remain future concepts.
2. **The enquiry list is the centre of the application.** `/api/leads` supplies bounded, server-filtered rows; search, sorting, selection and bulk actions stay together. The query-linked drawer opens within the current page.
3. **Context travels with the work.** Enquiry identity, owner and next step are available in the record drawer, inbox and booking flow. Server checks use stable member IDs and current permissions.
4. **Each screen has one dominant task.** Lists prioritise rows; inbox prioritises the thread; reports prioritise a chart and its underlying records.
5. **A single visual system ties the references together.** Supporting references inform particular workflows; typography, spacing, navigation and controls remain consistent across AdmitFlow.

## Applied visual system

These values come from the applied application source/CSS, not measurements of the Mobbin screenshots. Consult the linked release records for the scope of local browser rendering and accessibility checks.

| Element | Current source implementation |
| --- | --- |
| Navigation | Desktop sidebar is 232px in the shell CSS; grouped links, workspace switcher, quick search, active states and account/help controls. Sidebar changes to menu navigation at narrower widths. |
| Surfaces | White content; `#F7F8FA` paper/sidebar; `#E7EBF0` borders; `#19232F` primary text; `#677382` muted text. |
| Accent | `#4560E6` actions/focus, `#EEF1FE` soft accent; labeled status badges distinguish outcomes. |
| Typography | Geist Variable for headings/body; 14px body; 28–32px main headings; tabular money/counts and monospace identifiers. |
| Layout/controls | 62px desktop top bar; bounded 1660px content area with 28px desktop padding; 38px buttons and 40px form fields before responsive overrides. |
| Shape | 7px base control radius, 12px panels, larger dialog surfaces; fine borders and restrained floating shadows. |
| Enquiries | Student/contact, course, stage, intent, counsellor and last-contact columns; optional enquiry-date column, page sizes and display controls. |
| Records | Up to 560px desktop drawer, opened with `?lead=<id>`; contextual inbox, booking and payment actions. |
| Inbox | Conversation list, thread and wide-screen enquiry context; narrow-screen thread/back navigation; distinct reply/note modes and persistent send-request state. |
| Mobile | Responsive grids/toolbars, contained table/board scrolling and full-screen dialogs/drawers at small widths. Local viewport/zoom coverage is recorded in the release evidence; real-device behavior remains a pilot concern. |
| Feedback | Loading/error/empty/retry states, toasts, field validation, connection setup states and unresolved-provider outcomes are coded. |
| Accessibility | Skip link, labels, focus styles, native modal behavior, keyboard search and reduced-motion CSS are implemented. Scoped local Axe/keyboard/focus results are recorded in the release evidence, not a comprehensive accessibility certification. |

## Implemented information architecture

- **Workspace:** Overview (`/`), Enquiries (`/leads`), Admissions pipeline (`/pipeline`), Shared inbox (`/inbox`), Counselling (`/appointments`).
- **Growth engine:** Recovery campaigns (`/recovery`), AI & automations (`/automations`), Knowledge base (`/knowledge`), Revenue analytics (`/analytics`).
- **Manage:** Team & access (`/team`), Integrations (`/integrations`), Settings (`/settings`, including BillingPanel).
- **Hosted account flow:** `/login`, `/signup`, `/callback`, `/logout`, and `/onboarding` for institute selection/creation. These are additional account flows, not extra main workspace screens.

Navigation visibility follows permissions. Enquiry links and `/inbox?conversation=<id>` resolve within the authenticated workspace; the server independently checks access. The current shell still fetches the full authorized workspace projection, including when Enquiries also requests a paginated list.

## Implementation locations and remaining QA

- Shared shell/routing: `src/components/workspace.tsx`, `src/app/[[...view]]/page.tsx`.
- Visual foundation: `src/app/tokens.css`, `workspace.css`, `surfaces.css`, `responsive.css`; imported by the root layout/global stylesheet.
- Screen behavior: `leads.tsx`, `inbox.tsx`, `recovery.tsx`, `appointments.tsx`, `overview.tsx`, `configuration.tsx`, `billing.tsx`, `whatsapp-connect.tsx` and `onboarding.tsx` under `src/components/`.

**Local browser QA is recorded, not pending:** use the README and dated verification ledger for the latest run, exact coverage and earlier failures. Rerun affected checks after changes to the 12 routes, narrow-screen navigation/table scrolling, dialog focus, role-restricted controls, exact monetary display or demo autonomy/takeover paths. Old nine-test MVP results and old screenshots remain historical only.

Preserve the implemented distinction between configured accounts, requested/verified coexistence, provider acceptance, actual delivery and unresolved sends. Autonomous mode and a Business-app echo must retain human control; local simulation must stay visibly separate from live verification. Booking acceptance and Google sync confirmation, and recorded versus provider-confirmed money, likewise need distinct labels.

The full-workspace projection cost remains a follow-up. Saved-view `view`/`sort` now persist server-side, and Admissions charts/headlines share distinct-student reporting; those former defects are not current roadmap items. Broader workflow publishing, configurable stages and a separate full-page record view remain roadmap features.

Current implementation scope: [production-plan.md](production-plan.md). QA ledger: [verification.md](verification.md). Backend/UI contracts: [backend-verification.md](backend-verification.md).
