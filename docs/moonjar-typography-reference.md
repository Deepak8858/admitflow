# Moonjar typography and background reference

Reference: [https://moonjar.ai/](https://moonjar.ai/). Observed 2026-09-29 in a fresh, credential-free Playwright Chromium 153.0.8010.12 context. The public homepage returned HTTP 200. Font readiness was awaited before sampling. Screenshots use device scale factor 1, reduced motion, and light preference. Additional computed-style checks cover 810px, 1024px, an opened mobile menu, and dark preference.

This is reference evidence, not a verification of the AdmitFlow implementation. During reference capture, no local app build, test, server, Git operation, deployment, or app-source edit was performed. The later, separately authorized root-error fix is recorded in the finding status below. Reference branding, copy, and imagery were retained only inside the reference screenshots/DOM evidence.

## Corrections to the initial reference extraction

- Actual mobile menu rows are **17px**, CSS weight **500**, `font-variation-settings: "opsz" 17`, line-height **1.2**, and tracking **-.01em**. The menu CTA is **15px**. The 15px Framer nav preset does not describe the custom mobile menu rows.
- The visible nav is **15px at 810/1024px**, and **14px at 1440px**. Its explicit axes remain `"wght" 500, "opsz" 14` at these widths.
- The hero H1 and hero paragraph render **static Inter**. Both compute `font-feature-settings: normal`, unlike the standard Inter Variable presets that enable the five glyph features.
- The hero paragraph is **18px at desktop/tablet** and **17px below 810px**. Standard body text is **18/16/15.5px** across the three breakpoint bands.
- The page canvas is `#FAFAF7`, but the hero panel also has a pale gradient and separate lavender/pink radial glows. These are distinct from the global canvas.
- `#66645D`, `#F3F2EC`, and `#7466E8` are confirmed declared tokens. The sampled standard body/lead text actually renders `#8A8880`; the exact solid-paint scan did not establish a rendered use of those three declared tokens.
- A requested dark browser preference leaves the sampled page canvas `#FAFAF7`, hero gradient unchanged, and H1 ink `#2A2A27`. The sampled reference does not switch to a dark palette automatically.

## Typography measurements

The breakpoint conditions in the live CSS are `min-width: 1440px` by default, `810px–1439px`, and `0px–809px`. The required 768px screenshot is therefore in the smallest type band.

| Role | 1440px | 810px / 1024px | 768px / 390px | Line-height | Tracking | Face and axes |
| --- | --- | --- | --- | --- | --- | --- |
| Section H2 | 56px | 36px | 28px | 1.04 | -.03em | Inter Variable; CSS weight 400, explicit `wght 500`, `opsz 32` |
| Standard body | 18px | 16px | 15.5px | 1.55 | -.008em | Inter Variable; CSS weight 400, `wght 400`, `opsz 18` |
| Lead paragraph | 22px | 18px | 17px | 1.45 | -.012em | Inter Variable; CSS weight 400, `wght 400`, `opsz 22` |
| Visible desktop/tablet nav | 14px | 15px | Hidden behind menu | 1.2 | -.003em | Inter Variable; CSS weight 400, explicit `wght 500`, `opsz 14` |
| Opened mobile menu rows | — | — | 17px at 390px | 1.2 | -.01em | Inter Variable; CSS weight 500, explicit `opsz 17`; no explicit `wght` in computed variation settings |
| Opened mobile menu CTA | — | — | 15px at 390px | 1.2 | normal | Inter Variable; CSS weight 500, explicit `opsz 15` |
| Hero H1 | 52px | 45.72px / 48.288px | 28.4553px / 28.4553px | 1.02 | -.03em | Static Inter Medium; CSS weight 500, normal variation/features |
| Hero paragraph | 18px | 18px | 17px | 1.55 | -.008em | Static Inter Regular; CSS weight 400, normal variation/features |
| Footer label/link | 14px | 14px | 14px | 1.2 | +.06em | Geist Mono Variable/Geist Mono, weight 400; uppercase |
| Footer small label | 12px | 12px | 12px | 1.2 | +.06em | Geist Mono Variable, `wght 400`; uppercase |

The H1's live rule is:

```css
font-family: Inter, "Inter Placeholder", system-ui, -apple-system, sans-serif;
font-weight: 500;
font-size: clamp(20px, min(8.13008cqi, 36px + 1.2vw), 52px);
line-height: 1.02;
letter-spacing: -.03em;
font-kerning: normal;
```

Its `.mjah` parent is an inline-size container. That container was 350px wide at both 768px and 390px, explaining the identical observed H1 size. A viewport-only clamp is not equivalent.

Standard variable presets and the mobile menu compute these features as enabled:

```css
font-feature-settings: "blwf" on, "cv03" on, "cv04" on, "cv09" on, "cv11" on;
```

Do not infer effective heading weight from `font-weight: 400` alone: the explicit `wght 500` axis controls the section heading and desktop/tablet navigation presets. Do not apply the five features indiscriminately to the static hero typography.

Chrome DevTools Protocol `CSS.getPlatformFontsForNode` confirmed custom font glyphs for the sampled elements:

| Sample | Actual reported font / PostScript name |
| --- | --- |
| Hero H1 | Inter Medium / `Inter-Medium` |
| Hero paragraph | Inter / `Inter-Regular` |
| Section H2 | Inter Variable / `Inter-Variable-Display-Medium` |
| Desktop nav | Inter Variable / `Inter-Variable-Text-Medium` |
| Standard body, lead, mobile menu | Inter Variable / `Inter-Variable-Text` |
| Footer label | Geist Mono / `Geist-Mono` |
| Separate static mono sample | Geist Mono / `GeistMono-Regular` |

**Original reference observations:** every listed sample reported `isCustomFont: true`. This sidecar's captured CDP records establish the rendered families/PostScript names and computed feature settings, but did not contain font release numbers, source binary hashes, or font-resource response metadata. Those original observations are unchanged; computed declarations alone do not establish a replacement binary's OpenType contents.

**Subsequent independent corroboration — Ampere, 2026-09-29:** the “Inter provenance and reference comparison” section of [public/fonts/LICENSES.md](../public/fonts/LICENSES.md) now records the official source URLs/hashes and the three inspected Moonjar reference URLs/hashes. The variable, static Regular 400, and static Medium 500 reference/local pairs all report **Version 4.000;git-a52131595**, **2048 units per em**, the same static weights or variable axis limits, and the requested `cv03`, `cv04`, `cv09`, and `cv11` features. Neither the reference nor source has a Latin `blwf` lookup; the stylesheet retains Moonjar's declaration.

Ampere records matching decomposed glyph outlines and advance widths for **all 278 common encoded characters** of the variable pair at body **400/18**, navigation **500/14**, and heading **500/32** weight/optical settings. The same comparison matched **all 304 common encoded characters of each static pair**. This corroborates the Inter release, compared glyph geometry, and advances at those tested settings, resolving the earlier release/geometry uncertainty within that scope. This sidecar read and cross-linked Ampere's evidence; it did not repeat the font comparison.

**Subsequent Geist Mono corroboration — Ampere, 2026-09-29:** the “Moonjar Geist Mono comparison” section of [public/fonts/LICENSES.md](../public/fonts/LICENSES.md) now records the local Latin 400 face's comparison with both Moonjar's static 400 reference and its variable reference evaluated at **`wght=400`**. All report **Version 1.701**, family **Geist Mono**, regular weight **400**, PostScript name **`GeistMono-Regular`**, and **1000 units per em**. The shaping feature sets match (`ccmp`, `dnom`, `frac`, `locl`, `mark`, `mkmk`, `numr`), and decomposed outlines and advance widths match for **all 225 common encoded characters against each reference**. The variable reference is also **byte-identical to the licensed original Fontsource Latin source** identified in that record. Ampere found no correction needed to the existing 9,940-byte local static instance. This is subsequent independent font-data evidence, separate from this sidecar's original CDP observations; this sidecar did not repeat the comparison.

**Remaining limits:** the retained Inter fonts are newly compressed official-release subsets with additional application character coverage, **not byte-identical reference-CDN subsets**. For Geist Mono, byte identity applies to the variable reference and licensed variable source, not to the instantiated local static file. The recorded comparisons cover common encoded characters, matching feature sets, and the listed role axes; they do not establish every shaping sequence or every variable-axis combination. They are **not rendered page-to-page pixel acceptance**. No new browser session, font forensics, build, or runtime work was started for this documentation reconciliation.

## Palette and painted backgrounds

| Value | Evidence and role |
| --- | --- |
| `#FAFAF7` | Body and main page background; also retained under dark preference |
| `#F3F2EC` | Declared secondary token; no exact solid background use established by the sampled element scan |
| `#FFFFFF` | Rendered white content surfaces; also a declared token |
| `#EAE8E1` | Declared rule token; rendered footer divider background |
| `#DFDCD3` | Declared rule token and rendered comparison-card border/divider |
| `#2A2A27` | Rendered H1/H2/nav ink and primary CTA background |
| `#8A8880` | Rendered standard body, lead, hero paragraph, and footer-link color |
| `#B1AEA5` | Declared faint token and rendered small comparison label |
| `#66645D` | Declared readable-body token; not the sampled standard-body preset's rendered color |
| `#7466E8` | Declared accent token; exact solid paint not established in the sampled element scan |
| `#7466E81F` | Declared translucent accent token |

Other declared semantic tokens include `#D64532` and `#3AA676`. Illustration/UI-demo colors were not treated as application-wide palette roles.

The hero panel's computed background is:

```css
linear-gradient(#F7F7F5 0%, #F5F4F6 58%, #EEE9F5 100%)
```

Separate rendered decorative layers use:

```css
radial-gradient(50% 50%, rgba(170,146,236,.30) 0%, rgba(170,146,236,0) 100%)
radial-gradient(50% 50%, rgba(240,170,206,.24) 0%, rgba(240,170,206,0) 100%)
```

Several feature panels use `linear-gradient(#F1F0EB 0%, #EAE8E2 58%, #ECEAE4 100%)`. These gradients are reference surface variants, not a request to copy the reference's product artwork into AdmitFlow.

The initial `surfaceColors` inventory in `computed-styles.json` includes computed border colors even where border width may be zero. Use the stricter `paletteUsage` records in `rendered-addenda.json` for confirmed nonzero border paints.

## Read-only AdmitFlow override audit

This is a source snapshot during parallel implementation, not final runtime acceptance. Already assigned font/theme/CSS work remains with its owners.

**P2 — implemented in source and compiled in the final local builds (2026-09-29).** The initial audit found no [global-error.tsx](../src/app/global-error.tsx). Next 16.3.5's default replacement document uses inline `system-ui` at builtin/error-styles.js:32 (installed Next.js 16.3.5 dependency: `next/dist/client/components/builtin/error-styles.js:32`) and its own white/dark palette at builtin/error-styles.js:114 (installed Next.js 16.3.5 dependency: `next/dist/client/components/builtin/error-styles.js:114`); root layout styles alone do not cover that document.

A separately authorized bounded fix now adds [global-error.tsx](../src/app/global-error.tsx). It supplies its own `html`, `head`, and `body`, directly imports Ampere's shared `fonts.css` and `tokens.css`, fixes `data-theme="light"`, and includes scoped paper-palette styles. It reuses the plain copy from `error.tsx`, provides a `reset` button and native `<a href="/">` home navigation, declares `noindex, nofollow`, and never reads/displays the error payload or mounts `AppearanceProvider`. It does not import the full workspace styles.

Validation: TypeScript 5.9.3 single-file TSX transpilation reported no syntax diagnostics; both stylesheet imports and all eight currently referenced local font assets exist. Transpilation output stayed in memory. Subsequently, the final public and preview Next builds completed compilation and full application TypeScript checks; see the [implementation report](seo-implementation-report.md). No deliberate global-error runtime fault was triggered, so its replacement document's runtime behavior remains unverified. Ampere's completed Inter and Geist Mono 400 comparisons are cross-linked above and do not substitute for that runtime acceptance. App-source changes by this sidecar are frozen following parent review.

The normal custom [not-found.tsx:3](../src/app/not-found.tsx#L3) and [error.tsx:6](../src/app/error.tsx#L6) already use `standalone-empty`, `page-eyebrow`, and button classes, with no inline font-family/background. There is no source reason to add a duplicate normal 404/error component. Galileo should confirm those actual routes in the final built acceptance.

Next's generic HTTP fallback does hardcode `system-ui` at access-error-styles.js:14 (installed Next.js 16.3.5 dependency: `next/dist/client/components/styles/access-error-styles.js:14`) and inject black/white light/dark body rules at error-fallback.js:37 (installed Next.js 16.3.5 dependency: `next/dist/client/components/http-access-fallback/error-fallback.js:37`). This is conditional framework behavior, not evidence the existing custom 404 currently renders it. No custom `global-not-found.tsx` or `experimental.globalNotFound` configuration was observed.

Outside assigned CSS scopes:

- [globals.css:1](../src/app/globals.css#L1) contains stylesheet imports only.
- [billing.tsx:99](../src/components/billing.tsx#L99) uses `--color-accent-soft` / `--color-surface` for inline backgrounds.
- [overview.tsx:23](../src/components/overview.tsx#L23) uses `--color-surface` for its tooltip.
- The narrow non-CSS, non-marketing source search found no additional inline `fontFamily` / `font-family` override or literal Tailwind `font-[...]` / `bg-[#...]` match. This is bounded search coverage, not proof all runtime third-party styles inherit correctly.
- Root layout font imports/theme bootstrap are already Ampere-owned and were not filed as duplicate unassigned issues.

## Absolute evidence paths

Primary capture completed at **2026-09-29T14:38:17.670Z**. Addenda were completed before browser closure at **2026-09-29T14:42:05.782Z** (20:12:05 Asia/Calcutta). Pixel dimensions and SHA-256 hashes are in the manifest.

| Evidence | Absolute path |
| --- | --- |
| Computed styles, selectors, bounds, token declarations, first font samples | computed-styles.json (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/computed-styles.json`; see [portable evidence summary](seo-release-snapshot.md)) |
| Mobile menu, 810/1024 checks, actual fonts, dark preference, gradients, live CSS rules | rendered-addenda.json (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/rendered-addenda.json`; see [portable evidence summary](seo-release-snapshot.md)) |
| Source audit and framework fallback evidence | app-source-audit.json (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/app-source-audit.json`; see [portable evidence summary](seo-release-snapshot.md)) |
| Screenshot dimensions, sizes, hashes | evidence-manifest.json (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/evidence-manifest.json`; see [portable evidence summary](seo-release-snapshot.md)) |
| Explicit browser shutdown evidence | browser-lifecycle.json (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/browser-lifecycle.json`; see [portable evidence summary](seo-release-snapshot.md)) |
| 1440×1000 hero | moonjar-1440-hero.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-1440-hero.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 1440×1000 typography section | moonjar-1440-type-section.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-1440-type-section.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 768×1024 hero | moonjar-768-hero.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-768-hero.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 768×1024 typography section | moonjar-768-type-section.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-768-type-section.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 390×844 hero | moonjar-390-hero.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-390-hero.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 390×844 typography section | moonjar-390-type-section.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-390-type-section.png`; see [portable evidence summary](seo-release-snapshot.md)) |
| 390×844 opened mobile menu | moonjar-390-menu.png (local-only archive: `artifacts/admitflow-seo-implementation-2026-09-29/moonjar-reference/moonjar-390-menu.png`; see [portable evidence summary](seo-release-snapshot.md)) |

The Playwright context and Chromium browser were explicitly closed; `browser.isConnected()` returned **false**. No reference helper or local app server remains running from this task.
