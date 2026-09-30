# Public performance and measurement handoff

## What source review found

- The public marketing page had no analytics provider, measurement ID, pixel, network sink, or public event contract in source. The workspace's "Revenue analytics" screen is product reporting, not website analytics.
- The current primary journey is a link to `/signup`. `AccountEntry` validates an email and the server action starts a hosted WorkOS handoff. The callback sends users toward onboarding. Reaching `/signup`, redirecting to WorkOS, or refreshing onboarding does not confirm that an account was created.
- `/contact` offers a real mail destination at `support@admitflow.incfrog.ai` for pilot and support requests. Opening a mail link cannot confirm that a message was written, sent, delivered, or accepted.
- `marketing.tsx` was a single client component on the reviewed base and imported appearance/motion and UI code. Root `globals.css` imported workspace, surface, responsive, marketing, redesign, account, and onboarding styles. Those are candidates for the verification worker to measure on a clean and final production build; their presence alone does not establish a performance regression.
- The original hero had a 28,918-byte 640w WebP candidate and a 307,322-byte 1920w WebP candidate. Its image is eager with high fetch priority and explicit dimensions. Other illustrations are lazy by default. The audio samples use `preload="none"` and include transcript text. The later baseline justified the intermediate hero candidate documented below.

## Local event contract

Mount `<PublicAnalytics pathname={pathname} />` once inside the public `PublicLayout`, where `pathname` is the route's public path. The component emits the browser event `admitflow:public-analytics` with a `detail` object. It performs no network request, storage write, provider setup, automatic page tracking, or collection of referrer and URL fields.

Permitted paths come from the published `src/lib/public-content.ts` registry, including About, Security, Resources and each published resource detail. Query strings and fragments are discarded before an event is built. Auth, callback, API, onboarding, and workspace routes cannot produce an event.

For a real CTA anchor, use:

```tsx
<a
  href="/signup"
  data-af-event="primary_cta_click"
  data-af-cta="signup"
  data-af-placement="hero"
>Get started</a>
```

Allowed `data-af-placement` values are `nav`, `hero`, `body`, and `footer`. `data-af-cta` and the exact `href` must match one of these pairs:

| CTA name | Required destination | Interpretation |
| --- | --- | --- |
| `signup` | `/signup` | Activated the account CTA |
| `contact` | `/contact` | Activated the contact page CTA |
| `pilot_email` | `mailto:support@admitflow.incfrog.ai` | Opened the pilot email link |
| `support_email` | `mailto:support@admitflow.incfrog.ai` | Opened the support email link |

The email address is validated as a destination and is not placed in the event detail. The emitted CTA detail contains `version: 1`, `name: "primary_cta_click"`, `page_path`, `cta_name`, and `placement`, plus optional coarse acquisition fields described below. A mail link event measures a click only.

When a marked `/signup` CTA is activated, the same interaction also emits `signup_start` with `version`, `page_path`, `placement`, and optional coarse acquisition fields. Here "start" means the visitor activated navigation into signup; it does not mean they entered or submitted the form or reached WorkOS.

The event boundary reads the current public page's query only for one exact `utm_source` and one exact `utm_medium`. The accepted sources are `google`, `bing`, `linkedin`, `whatsapp`, and `newsletter`. The accepted mediums are `organic`, `cpc` or `paid_search` (both emitted as `paid_search`), `email`, `social`, and `referral`. Output keys are `acquisition_source` and `acquisition_medium`; medium is emitted only when a known source is present. Duplicate, unknown, oversized, or absent values are omitted. `utm_campaign`, `utm_content`, `utm_term`, all other query fields, and raw URLs never enter the event. These fields help distinguish coarse channels when a visitor activates a CTA on the tagged public landing page. Since no context is stored or sent across routes, they do not attribute later signup completion or carry through WorkOS.

`SampleAudio` marks its `<audio>` with `data-af-audio` set to the fixed sample slug. The component emits `sample_audio_play` when the browser raises `playing`, after playback actually starts. It requires the corresponding exact `/media/<slug>.mp3` source and emits only `version`, `name`, `page_path`, and `sample_id`. The four permitted slugs are `walkthrough`, `counselling-invitation`, `session-reminder`, and `thoughtful-followup`. A pause and later restart counts as a new play; a buffer stall within one play does not. Playback in the private workspace is excluded because the listener mounts only in the public layout and private paths fail validation.

An eventual analytics adapter may subscribe to `window.addEventListener("admitflow:public-analytics", listener)` and read the event's validated `detail`. The adapter should use the owner's chosen property and applicable consent settings, and inspect that provider's automatic page-location and referrer collection before enabling it. Do not copy `location.href`, search parameters, element text, form values, or the anchor destination into a provider event.

## Events not yet claimed

`signup_complete` must be emitted only after verified account creation, with a durable deduplication key handled privately rather than included in analytics. The hosted callback or provisioning acceptance path must be reviewed before integration. No refresh or navigation should emit it.

There is no accepted demo/pilot form or approved booking destination. `demo_request_start`, `demo_request_success`, `product_demo_play`, and `resource_download` are not emitted. A mail link must never be reported as a completed lead.

## Performance and usability validation

`Reveal` no longer hides marketing text after hydration or while waiting for viewport observation. This keeps headings and copy available without JavaScript and under reduced motion. The verification worker owns the comparable clean baseline and final production build measurements. Record URL, timestamp, build revision, browser/tool version, mobile and desktop profiles, network and CPU settings, repeated lab runs, and medians. LCP, CLS, and interaction diagnostics from those runs are lab evidence; field Core Web Vitals require representative real-user data and cannot be inferred from a Lighthouse navigation score. The worker should also check a narrow mobile width, keyboard navigation, media controls, and JS-disabled content.

If the final build shows public CSS or JavaScript dominating transfer or main-thread time, scope a route-level split after comparing the loaded files and entry chunks. Preserve root robots exclusions and WorkOS provider behavior when making that decision.

## Measured responsive hero delivery change

Galileo's `artifacts/admitflow-seo-implementation-2026-09-29/baseline-turbopack-measurements.json` captures the pristine `02a03632957610765ba8911a1db0ea37d628d45f` production build using Chromium 153.0.8010.12 on 2026-09-29. The homepage's three mobile runs used a 390×844 viewport, DPR 2, 4× CPU throttling, 150 ms latency and 200,000 bytes/second download bandwidth, with a cold browser cache per run. Median LCP was 4,352 ms and JavaScript transfer was 248,764 bytes. The browser requested the 1920w hero at 307,754 transfer bytes.

The original `srcset` jumped from 640w to 1920w. A 390 CSS-pixel slot at DPR 2 needs approximately 780 source pixels, making the full desktop candidate the next available choice. A new 960×640 candidate now fills that gap:

| Hero candidate | Actual dimensions | File bytes |
| --- | --- | --- |
| `admissions-mountain-hero-small.webp` | 640×427 | 28,918 |
| `admissions-mountain-hero-960.webp` | 960×640 | 56,232 |
| `admissions-mountain-hero.webp` | 1920×1280 | 307,322 |

The new file is derived from the existing owned 1920w WebP with installed Sharp, a proportional 960w resize, WebP quality 78 and effort 4. Its file payload is 81.7% smaller than the 1920w file; transfer bytes will include response overhead. The measured 780-pixel demand is covered by 960w, so no 1280w asset was added. The original 640w and 1920w files, default `src`, sizes, intrinsic layout dimensions, eager/high-priority hero behavior, lazy behavior for other images, fallback and accessible text are preserved.

Local verification checked actual dimensions, the RIFF/WEBP signature and `image/webp` format, visually reviewed the generated image against the original, and checked the edited component in a focused TypeScript program. No full build or browser suite was run for this patch. Galileo must confirm the selected `currentSrc`, transferred bytes and comparable final LCP in the production build; this change alone does not establish an LCP improvement or field Core Web Vitals.
