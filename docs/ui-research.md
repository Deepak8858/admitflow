# UI/UX research — Mobbin MCP

> Historical MVP research. The user requested a new visual direction on 12 September 2026. See [the focused 8-image production review](production-ui-direction.md) for the current recommendation.

Date: 11 September 2026. Source: authenticated `https://api.mobbin.com/mcp`, using its actual `search_screens` and `search_flows` tools. Returned screen images were fetched and visually inspected. No customer data was submitted; queries described generic product workflows.

## References and observed patterns

1. [Shopify analytics](https://mobbin.com/screens/e78d70e8-0d91-445f-b0cc-0e4093b4f117): compact summary metrics above a large time-series chart; date/currency controls above the report; a breakdown immediately beside the chart. **Apply:** lead with collected recovery revenue, a date filter, and an adjacent funnel. Calculate every metric from stored records.
2. [HoneyBook contacts](https://mobbin.com/screens/87a18caf-2d48-4f2d-80b6-ba8534d5c96a): saved-view tabs above a table, filters below tabs, clear add/import entry points, row checkboxes. **Apply:** All / High intent / Needs follow-up views, accessible bulk selection and one import action.
3. [Customer.io people](https://mobbin.com/screens/4b6226b8-69a9-43f3-aa6e-1840f27bc6b0): labelled sidebar groups, plain filtering controls, CSV export and explicit test-mode status. **Apply:** group admissions work separately from setup; keep demo mode visible; offer portable exports.
4. [Plain inbox](https://mobbin.com/screens/6b03543c-d8bd-403c-a3eb-3c43783a0a23): thread list, conversation and activity stream, right-hand status/assignee properties, reply/note actions. **Apply:** preserve lead context during replies and human handoff; collapse panes to a list/detail navigation on mobile.
5. [Apollo importing contacts flow](https://mobbin.com/flows/2eb0884f-5123-4de0-8f77-af07565397b0): downloadable sample, column mappings with recognised/unrecognised indicators, visible sample rows and duplicate-handling settings. Images inspected at positions 2, 4 and 5. **Apply:** upload → map → review → import, with visible invalid and duplicate counts; never silently invent consent.
6. [Attio sales pipeline](https://mobbin.com/screens/37ff1181-0cd1-4a35-9888-963786c4029b): stage columns with counts, lightweight cards with amount/owner/date, filtering and a contextual comments panel. **Apply:** concise admissions cards and stage counts; offer a stage select as a keyboard/touch alternative to drag-and-drop.
7. [Flodesk workflow editor](https://mobbin.com/screens/56d4e37c-9dc5-40a0-9089-2b9b26ae7741): a vertical message/delay/branch sequence and a side panel editing the selected delay. **Apply:** readable follow-up steps with explicit wait times and stop conditions, instead of an unrestricted graph builder.

## Adopted system

Modern-minimal, utilitarian workspace. Stat-led overview adapted to an application; visible search/command palette (N13); labelled persistent sidebar; compact inline footer (Ft2). Cool paper, graphite navigation, one cobalt accent, semantic green/amber used with text. Space Grotesk display and Geist UI text are deliberate type choices, not claimed identifications of the reference fonts.

This is an original implementation informed by interaction patterns. Mobbin screenshots and other products' branding are not bundled as app assets. Accessibility: native dialogs, visible focus, labelled controls, keyboard-operable selection and stages, reduced motion, and responsive verification at 320/375/414/768px.
