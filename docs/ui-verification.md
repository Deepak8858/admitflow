# Frontend and browser verification

Current release evidence is maintained in [the dated verification ledger](verification.md) and [README](../README.md). The subscription run below is historical, not the latest repair acceptance.

## Historical subscription and public-page verification — 19 September

Final isolated `node scripts/verify.mjs --browser`: **37 passed, 0 failed in 21.3 minutes**, one worker/default Chromium, disposable SQLite; exit **0**. Final isolated project TypeScript also passed, exit **0**. No runtime source changes followed the 175-application/8-infrastructure-test non-browser pass. See [full provenance](verification.md).

Subscription fixtures verify open-tab trial expiry, fail-closed refresh outages and explicit recovery; identical server snapshots cannot extend the same permission interval. Restricted controls preserve drafts, internal notes, pauses and existing records. Billing refresh restores capabilities; deferred intake requires a separate explicit click per 25-event batch. Non-admins receive contact guidance without privileged billing/intake controls. Ordinary 409 conflicts remain in place; only `ORGANIZATION_REQUIRED` redirects.

The public/redesign suite verifies workspace-free public pages at 320/375/768/1440 px, light/dark Axe checks, fictional-preview and non-invented pricing disclosures, user-initiated audio with transcripts and missing-media fallback, keyboard/theme persistence, dark-theme workspace accessibility and 200-percent CSS zoom. Existing workflow, narrow-width, role and keyboard regressions below also passed. This is scoped automated coverage, not a whole-product accessibility or live-provider certification.

Earlier attempts are retained: the hidden Paused radio test now clicks its visible label and still asserts checked state; the repeated-snapshot test no longer pauses timers before hydration and waits for refresh completion. Its interrupted rerun passed the regression but ended after 14 tests. A later server-readiness timeout ran no tests. The diagnostic run passed 36/37; `/api/jobs` cold compilation took 23.2 seconds before the expected 401, beyond the 15-second request limit. The request now uses the existing 45-second navigation budget, with the authorization assertion unchanged. No retries or skipped tests were needed in the final complete run.

Final logs are `.data/verification-subscriptions-20260919/browser-final.log` and `typecheck-final.log`; diagnostics and pre-rerun artifacts remain alongside them and under `.data/verification-subscriptions-20260918-225058/`. Failure screenshots were inspected for the radio/loading issues; final suite screenshots are automated captures, not a fresh comprehensive manual visual review. The screenshot-inspection section below refers to the historical 12 September work.

## Recovered 16 September rerun
OpenCode session `ses_f5588df47ffe2duC3aEl3uiQZV` completed `npm run test:e2e`: **19 passed, 0 failed, 8.3 minutes**, one worker/default Chromium. This continuation recovered the command output; it did not rerun browser tests or visually inspect screenshots. The suite adds exact recovery-revenue/distinct-student chart coverage and verifies saved `view`/`sort` restoration after local storage is cleared. All 12 routes at four narrow widths and the scoped Axe/keyboard checks below passed again. See [current verification](verification.md) for provenance and remaining backend defects.

The former browser-only saved-view limitation is resolved by server-side preferences and migration `0005_saved_view_preferences`. Build and TypeScript now pass after a type-only billing test fixture correction. No UI/runtime source changed in this continuation.

## Historical 12 September completed checks

- `npm run typecheck`: passed, no diagnostics.
- `npm run test:e2e`: **18 passed, 0 failed**, approximately **4.2 minutes**; Chromium, one worker.
- Axe: **0 violations** on the overview, open enquiry form, and inbox using the existing `wcag2a`, `wcag2aa`, and `wcag21aa` tags.
- Responsive: all **12 workspace routes at 320, 375, 414, and 768 px** passed (48 route/viewport combinations). Checks include horizontal table/board scrolling and visibility of the latest mobile message.
- Onboarding: local setup checked separately at the same four widths.
- Uncaught browser errors: none in the completed suite.
- Keyboard: command search, Escape, dialog initial focus, forward/reverse Tab containment, focus restoration, and mobile navigation passed.

The workspace routes are `/`, `/leads`, `/recovery`, `/pipeline`, `/inbox`, `/appointments`, `/analytics`, `/knowledge`, `/automations`, `/team`, `/integrations`, and `/settings`.

## Workflow coverage

- CSV validation/deduplication → recovery campaign → conversation → counselling → admission, including reload persistence.
- Local account registration, sign-out, and sign-in.
- Autonomous demo replies grounded in an existing knowledge source; simulated Business-app takeover stops subsequent AI replies.
- An interrupted inbox HTTP request retains its exact payload and UUID across reload and retry, producing one stored demo message.
- Server pagination/sorting, immutable bulk owner IDs, saved-view restoration, and query-error states with no unfiltered row fallback.
- Team GET reconciliation, role changes, deactivation/reactivation, demo invitations, exclusion of invited assignees, and revocation.
- Demo integration restrictions and billing demo/setup presentation.
- Analyst/counsellor action visibility using public-workspace projection fixtures.
- Counselling reschedule with stable member ID, updated ICS contents, cancellation, and a historical session marked no-show.
- Existing unauthenticated, cross-workspace and cross-origin API rejection checks remain asserted. Cross-workspace lookup now expects the backend's precise 404 response.

Billing setup and role visibility use controlled API-response fixtures where appropriate. These checks do not establish live Meta, Google, WorkOS, R2, OpenAI, ElevenLabs or Razorpay connectivity.

## Verified UI fixes

- Removed the unsupported registered-trademark mark from the brand.
- Hid disallowed overview import/task and ledger refund controls, with role-appropriate navigation actions.
- Added stable explicit form/search names and a reliable dialog Tab loop.
- Anchored screen-reader-only labels inside enquiry, recovery and pipeline scroll containers. Horizontal scrolling remains available; document overflow is not hidden to mask layout problems.
- Tightened desktop enquiry rows, compacted mobile metric cards without wrapping the displayed rupee total, and aligned status text.
- Removed excess schedule-card stretching and anchored the navy AI card's action at its bottom.
- Opening a mobile conversation now scrolls to its latest reply rather than leaving that reply below the composer.

## Screenshots inspected

- `test-results/overview-1440.png`
- `test-results/enquiries-1440.png`
- `test-results/inbox-1440.png`
- `test-results/overview-375.png`
- `test-results/inbox-375.png`

The screenshots were visually inspected; updated enquiry density, mobile metric layout and latest-message positioning were re-inspected after the final changes.

## Historical 12 September handoff

The 18-test run reported no blocking issue in its executed checks. At that point `view`/`sort` used browser fallback; that limitation is superseded by the server persistence and recovered 19-test run above. Passing UI checks do not close the separately documented payment-webhook defects.

The temporary port-3300 preview (launcher PID 10508, server PID 3488) was stopped. The earlier launcher PID 13284 exited during shell timeout. Ports **3100 and 3300 had no listening process** after the final suite.
