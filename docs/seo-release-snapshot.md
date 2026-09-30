# Verified SEO + Moonjar release snapshot

Prepared 30 September 2026 on isolated branch `codex/admitflow-seo-production`, based on `02a03632957610765ba8911a1db0ea37d628d45f`. This snapshot preserves the SEO and Moonjar implementation verified on 29 September. The concurrent executive redesign in the shared checkout was read only during recovery and is excluded from this branch. Publication, CodeRabbit review and deployment are subsequent release steps; this document does not claim they occurred.

## Source identity and recovery

All **192/192** files in the [original tested-source fingerprint](../artifacts/admitflow-seo-implementation-2026-09-29/final-tested-source-fingerprint.json) match byte-for-byte. Its recorded digest is `f3baa7646125abb2b16e28dfd15e225cc8373e31340b5bd1ad5f2386bd97bd94`. That original fingerprint deliberately covered app source, public binary assets and selected Docker/Next/CI configuration; it did **not** cover dependencies, tests or documentation. The [expanded release fingerprint](../artifacts/admitflow-seo-implementation-2026-09-29/release-source-fingerprint.json) now includes dependency manifests, all tests and verification scripts, infrastructure and CI configuration. This expanded receipt records reconstruction identity; it is not a new test run.

The 192-file tested-source fingerprint and 302-file expanded release fingerprint describe the initial `15e02cd` snapshot. The later CodeRabbit resource-date formatter, documentation-path and harness corrections, and dependency security repair are follow-up changes. Their validation belongs to fresh CI on the PR; the original fingerprints and test counts above do not establish coverage of those changes.

Four shared-checkout files had been overwritten by the later redesign. Recovery was checked against the original SHA-256 values, not merely visually compared:

| File | Recovery | Recovered SHA-256 |
| --- | --- | --- |
| `src/app/globals.css` | Unchanged baseline bytes | `cb1cb5e123cd406e058d616f0d6013e10ea0fcea3a09acfd2d04c04decafc148` |
| `src/components/marketing/marketing.tsx` | Original recorded source patch | `79dcc48cf934c58e9edf3ba2ad51d976fd40831481e931c7de81c1b733e42d45` |
| `src/components/marketing/public-layout.tsx` | Original recorded source and analytics/contact patches | `deb3d6f1e303ec8537788f5b7684ddf9359f8d267c2f41d80ae66f1a97cfff4a` |
| `src/lib/public-content.ts` | Original registry strings restored in the isolated copy | `c75c8de2980b8e0a1b2eaec170f378f48e6e28f237808cffce2eee8b6c369919` |

`package.json` and `package-lock.json` are unchanged from the base commit: the SEO/font work added no dependency. Their later shared-checkout differences were the executive verification command and Lenis. Those changes are excluded, along with executive components, stylesheet, browser configuration/spec, Geist Sans asset/license and `docs/design`. Existing `.depot/workflows/ci.yml` is retained unchanged. The font license document retains the tested Inter/Geist Mono provenance and variable-plus-medium preload contract; only the later Geist Sans addition is omitted. The [recovery receipt](../artifacts/admitflow-seo-implementation-2026-09-29/release-recovery-receipt.json) records these decisions, and the [changed-file manifest](../artifacts/admitflow-seo-implementation-2026-09-29/release-file-manifest.json) enumerates this release's paths.

## Portable validation record

The [full implementation report](seo-implementation-report.md) contains the handoff task statuses, 13-route inventory, schema/claims, privacy/auth evidence, accessibility, conversion contract and limitations. Compact original JSON evidence is included in Git. Large screenshots, foreign reference captures, diagnostic trials and raw logs remain in the original local evidence archive; they are explicitly labelled local-only in the reports. Their available SHA-256 values (including separate portable hashes when text line endings were normalized) are recorded in the [evidence index](../artifacts/admitflow-seo-implementation-2026-09-29/evidence-index.json). The index proves file identity when an archive is available; it does not substitute for an independently rerun test. No fixture cookie values, session histories or raw provider logs are included.

| Check | Recorded result and scope |
| --- | --- |
| Final public production build | Turbopack compilation, full TypeScript and 27/27 static routes completed. `PUBLIC_SEARCH_INDEXABLE=true` at build; that variable and `APP_BASE_URL` absent at runtime, with `APP_BASE_URL` also absent at build. [Public HTTP/SEO checks: 43/43](../artifacts/admitflow-seo-implementation-2026-09-29/final-corrected-public-verification.json). |
| Hosted fixture, same public build | [Passed](../artifacts/admitflow-seo-implementation-2026-09-29/final-corrected-public-hosted-v2-hosted-fixture.json): 13 public pages/eight assets remain public under anonymous, malformed and stale fake cookies. Workspace API 401; protected page is a generic noindex shell and browser returns to login. No remote sockets or real provider credentials. |
| Separate preview build | Full app build and remaining infrastructure TypeScript/worker builds, syntax/help checks and migration dry-run passed. Flag empty at build (only `true` indexes), absent at runtime. [Preview HTTP/SEO checks: 43/43](../artifacts/admitflow-seo-implementation-2026-09-29/final-corrected-preview-verification.json). |
| Public/workspace browser suite | First run **79 passed, 4 failed**; targeted rerun **4/4 passed**. Three test-only locator/route repairs and one transient dev-chunk load failure. Paid-control restrictions stayed unchanged. [Initial failure record](../artifacts/admitflow-seo-implementation-2026-09-29/browser-first-run-failures.json). This is split-run evidence. |
| Account browser suite | **10/10 passed** using isolated fake fixtures. Separate from the injected invalid-field CSS/axe visual probe. |
| Prior behavioral checks | Python audio **3/3**, application **395/395**, infrastructure **120/120**, offline IAM policy **646/646**, app/infra TypeScript passed. IAM checks are not AWS simulation. These precede the visual-only changes and were not needlessly rerun. |
| Earlier whole verifier | The prior `--all` run **failed** at its 20-minute whole-build deadline after compilation, typechecking and static generation. Later corrected builds completed the remaining checks; there is no single all-green `--all` receipt. |
| Reconstructed snapshot | Exact app-byte verification, dependency baseline comparison, harness syntax checks, diff whitespace checks and scoped secret review. No duplicate application build was run because the 192 tested files are identical. |

[Log result excerpts](../artifacts/admitflow-seo-implementation-2026-09-29/verification-summary.json) preserve the result counts and source-log hashes without committing raw logs. Both built check logs contain `Internal: NoFallbackError` near expected unknown-route probes; precise attribution was not established. Root `global-error.tsx` compiled in both builds, but a deliberate runtime fault was not triggered. Real-provider hosted auth and live post-release responses remain unverified.

## Performance interpretation and release limits

The [baseline](../artifacts/admitflow-seo-implementation-2026-09-29/baseline-turbopack-measurements.json) and [corrected cold lab](../artifacts/admitflow-seo-implementation-2026-09-29/final-corrected-public-lab-measurements.json) use the same Turbopack, Chromium, CPU/network profiles and three-run protocol. Baseline `APP_BASE_URL` was empty, while final was absent; [method correction](../artifacts/admitflow-seo-implementation-2026-09-29/baseline-methodology-correction.json) discloses this. Baseline layout shifts are a short-window sum, not standard CLS. Final supplies both metrics.

Home mobile LCP improved 4352→3260 ms and selected the new 960w hero; product mobile LCP worsened 2172→3064 ms and pricing worsened 1992→2440 ms. Font/CSS overhead and run variance are retained in the report. No field INP, Lighthouse score, ranking gain or uniform performance gain is claimed. Rejected intercepted-response preload experiments do not replace the genuine built-response measurements.

Keep distinct public and preview images because indexability is baked at build time. The manual paid-build gate in [release-gates.md](release-gates.md) remains intact; user release authorization does not itself change repository gate settings. Legal/commercial approval, analytics selection, mailbox delivery, production provider checks and post-release Search Console work remain as documented. No search submission or production migration was performed during verification or reconstruction.
