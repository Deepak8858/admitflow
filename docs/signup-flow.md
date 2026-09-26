# AdmitFlow account and institute setup

The public `/signup` and `/login` pages use AdmitFlow's typography, blue palette, campus illustration, theme controls and public navigation. They collect an email address and start the existing WorkOS AuthKit flow through a server action. WorkOS handles account credentials, enabled sign-in methods, email verification and human verification.

## Reference review

The implementation follows a visual review of 28 Mobbin screens: three account entry screens, four organization forms, Attio's five-screen workspace flow and Clay's sixteen-screen onboarding flow. Reference images are retained locally in the ignored `.data/ui-audit-2026-09-26/` directory. They are design references, not production assets.

| Reference | Observed pattern | AdmitFlow adaptation |
| --- | --- | --- |
| [Runway signup](https://mobbin.com/screens/38f91207-39b8-4687-a6bd-e3408bc67ae7) | Focused form beside a large visual, clear returning-user link | Form and campus illustration share a two-column desktop layout; the form comes first on mobile |
| [Emergent signup](https://mobbin.com/screens/dcf2f029-c756-4701-aac9-234ef98552b9) | Consistent input widths, primary action and product context | One prominent email action with concise next-step guidance |
| [lululemon account creation](https://mobbin.com/screens/7ca4a335-563d-4257-ac63-0e67a93cb2e4) | Clear account stage and a way to change the entered email | Editable email before the handoff, retained input when starting authentication fails |
| [Relevance AI organization setup](https://mobbin.com/screens/9d088df5-e755-4e4e-a7dc-7e80cadef19c) | One organization question with a visible step indicator | Focused institute name form and Account / Institute / Workspace stages |
| [QuickBooks business setup](https://mobbin.com/screens/ee8b4100-c0f2-4962-a182-a002ef0001cc) | Plain-language naming question and progress | Clear institute naming copy without unrelated intake questions |
| [Remote company details](https://mobbin.com/screens/5210bcb2-3df1-4405-a744-554c9d57886e) | Form beside a supporting illustration, progress across the top | Continuity with AdmitFlow's campus artwork |
| [Whop business naming](https://mobbin.com/screens/22d499dc-a6d7-42de-b32f-cdccc0f7ffdb) | Single naming field and an explicit submitting state | Disabled duplicate submission and clear setup progress |
| [Attio workspace flow](https://mobbin.com/flows/2ccc324e-049f-4f5f-b291-493259902d2b) | Workspace preview changes with its name; separate setup stages | Preview the institute name and initials while keeping membership selection explicit |
| [Clay onboarding](https://mobbin.com/flows/21f8625b-efe8-4a09-bd42-85eb878c621a) | Distinct account, verification, workspace naming and workspace entry states | Only mark progress when authenticated data or a provisioning receipt confirms it |

## Journey

| Stage | Behavior |
| --- | --- |
| Landing | `/` displays the public landing page; Get started opens `/signup` |
| Account | Validate an email, submit through a same-origin server action, create AuthKit PKCE state and navigate to the provider |
| Verification | WorkOS presents the enabled authentication and verification steps |
| Callback | AuthKit processes the callback using the configured public origin and returns to `/onboarding`; interrupted callbacks open `/auth/error` |
| Institute | Choose an active membership or name a new institute; pending creation retains its original request identity across retries/reloads |
| Workspace | A ready institute is opened through a confirmed session switch; only a successful response containing the selected organization ID navigates to `/overview` |

The form never accepts a caller-controlled callback, organization or return destination. Public account pages bypass session refresh so a stale cookie cannot prevent a fresh sign-in. Server actions still validate the exact configured origin. Provider failures show retry guidance without exposing provider messages, tokens or email addresses in logs.

Unconfigured account access is shown explicitly. The local workspace link appears only in local mode; hosted signup does not fall back to local registration. No unsupported social sign-in buttons or additional profile fields are presented.

The account browser suite uses real Next server actions and AuthKit URL/PKCE generation with synthetic configuration. Provider navigation and organization responses are intercepted; it does not create live users or institutes and cannot prove a production token exchange. Live acceptance still requires completing the enabled WorkOS verification and callback after deployment.
