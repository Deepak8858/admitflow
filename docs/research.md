# AdmitFlow — market research

Research date: 11 September 2026. Starting brief: the user's shared ChatGPT conversation, titled “Greeting response”. The conversation was extracted from its embedded public share data. Its citation markers are not independently usable sources.

## Conclusion

Pursue a narrow, assisted lead-recovery pilot for independent NEET/JEE coaching institutes. The proposed product's workflow is useful, but **recovery and revenue attribution are already competitor features**. The defensible hypothesis is lower setup effort, a focused daily recovery queue, explainable prioritisation, and a measurable pilot outcome. Product positioning alone is not a moat.

## What was directly verified

| Source, accessed 11 Sep 2026 | Observation | Product implication |
| --- | --- | --- |
| [Meritto Education CRM](https://www.meritto.com/education-crm/) | Advertises bulk imports, duplicate blocking, lead scoring, follow-ups, re-engagement of inactive prospects, WhatsApp, AI, source attribution and payments. | Do not describe recovery or attribution as unique. Target teams poorly served by implementation overhead. |
| [LeadSquared Education](https://www.leadsquared.com/education/) | Covers capture, routing, counselling, nurturing, admissions analytics, WhatsApp templates and payment integrations. Its case studies are vendor-reported. | A feature-for-feature CRM is an expensive entry strategy. Lead ownership and next action are baseline requirements. |
| [AiSensy pricing](https://aisensy.com/pricing) | Lists the AI Agent Builder at ₹1,350/month with 1,000 AI messages; ₹1,215/month billed annually. Chatbot builder is ₹2,500/month. Usage listed separately at ₹1.09/marketing message and ₹0.145/utility or authentication message for India. | The shared brief's ₹3,500 AI add-on and earlier message rates do not match the currently retrieved page. Treat these as AiSensy's advertised rates, not a independently verified universal Meta rate card. |
| [WATI pricing](https://www.wati.io/pricing/) | Advertises a ₹999 pay-as-you-go entry offer, subscription tiers, separate message fees, AI qualification and revenue reporting. Dynamic subscription amounts were not reliably rendered. | Cheap entry products and revenue-oriented messaging already exist. Avoid unsourced subscription-price comparisons. |
| [Twilio WhatsApp API](https://www.twilio.com/docs/whatsapp/api) | Documents opt-in/opt-out, the 24-hour window after the last inbound message, approved templates outside that window, inbound webhooks and delivery callbacks. | Recovery requires a template workflow. A draft is not a sent message; an API acceptance is not proof of delivery. |

Direct Meta documentation requests returned HTTP 400 in this environment. G2 and GetApp review pages returned HTTP 403. Therefore the specific ratings, review counts, complaint frequencies, market-size numbers and app-store rankings in the shared conversation remain **unverified here**. No independent customer interviews have been performed.

## Initial customer hypothesis

- Independent offline/hybrid NEET/JEE institutes with a named owner, 1–5 counsellors, and an existing enquiry list.
- A meaningful backlog of enquiries plus an existing lawful contact basis and usable WhatsApp opt-in records.
- Courses with sufficient contribution margin for a few incremental admissions to pay for software and messaging.
- Enough staff capacity to take over qualified conversations and honour appointments.

This is a prospecting definition, not an assertion of market size or willingness to pay.

## Validation experiment

Recruit five institute owners. Ask to inspect an anonymised sample export and their actual follow-up process. Measure time to a usable import, valid-phone rate, consent coverage, stale-open-lead count, counsellor capacity, existing systems, realised collected fees and refunds.

Run a bounded recovery cohort and, where practical, randomly hold out a comparable group. Record appointments attended and admissions paid, not messages sent. Compare outcomes across the same observation window. Report campaign-associated revenue separately from estimated incremental revenue: attribution alone does not prove causality.

Pilot success gates are **proposed**, not market benchmarks: first usable import in one session; a counsellor can work the daily queue without training; booked appointments appear in the team's calendar; the owner can reconcile every revenue entry to a lead and campaign; at least two pilot owners agree to continue on paid terms.

## Pricing and economics to test

Test ₹1,999 / ₹4,999 / ₹9,999 monthly packages from the original brief as hypotheses. Start by quoting one assisted ₹4,999 pilot with a disclosed usage budget rather than building three billing tiers. Validate price through actual offers.

Example planning calculation, not a forecast: 1,000 template deliveries × ₹1.09 = ₹1,090 at the currently advertised AiSensy marketing rate, before tax, AI and platform overhead. Three touches can triple usage before a single student responds. Margin depends on delivery count, model tokens, provider markup, support time and collected subscription revenue.

## Product priorities

1. Import → validate → deduplicate → own the next action.
2. Show recoverable open enquiries with explainable priority scores.
3. Draft/schedule a short recovery sequence and stop on reply, opt-out or admission.
4. Keep conversation history and a human owner visible together.
5. Book counselling and record actual admission amounts.
6. Reconcile campaign-associated revenue to its source records.

Initial scoring is a transparent heuristic, not an admission-probability model. Pipeline face value is an estimate of open course value, not cash lost. Demo data and simulated sending are visibly labelled.

## Biggest uncertainties

Consent quality in old spreadsheets; seasonal lead decay; owner willingness to pay; reliability of admission reconciliation; staff adoption; provider onboarding friction; true incremental lift; and whether the focused workflow is materially easier than tools the institute already uses. Address these through pilots rather than stronger marketing claims.
