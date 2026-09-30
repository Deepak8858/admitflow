# AdmitFlow public search build configuration

AdmitFlow search metadata uses the fixed public origin `https://admitflow.incfrog.ai`. It does not use `APP_BASE_URL`, which remains the runtime origin for callbacks and authentication. Public page metadata always emits an absolute canonical and social URL on that production origin.

`PUBLIC_SEARCH_INDEXABLE` controls whether published public pages may be indexed. Only the exact value `true` enables indexing. Unset, `false`, and every other value keep page robots directives at `noindex, nofollow`; the preview robots route disallows crawling and the sitemap contains no URLs. The flag is evaluated by Next during the web build, so changing a running container's environment does not reliably change prebuilt page metadata. Set it **before** `next build`.

An indexable production image cannot be reused for preview and made safe simply by setting runtime `PUBLIC_SEARCH_INDEXABLE=false`; build a separate preview artifact with the flag set to `false` before `next build`.

The Docker `web-build` stage accepts the nonsecret `PUBLIC_SEARCH_INDEXABLE` build argument with a safe default of `false`. The manual image publication workflow sets it to `true` for the main-branch web image, records the boolean in `release-manifest.json`, and retains its existing exact-commit CI check, explicit `PUBLISH` input, `BUILDS_APPROVED` cost gate, image scan and immutable image digest recording. Worker images do not use the flag. A local preview build should leave the default unchanged.

`src/lib/public-content.ts` holds the published public route list, including `/contact` after the user confirmed `support@admitflow.incfrog.ai`. Only those pages enter the production sitemap. Auth entry routes, `/welcome`, metadata endpoints and social assets may be publicly reachable but do not enter the sitemap. `/welcome` is a permanent 308 redirect to `/`; Next forwards its original query parameters. Last-modified timestamps are omitted until a trustworthy content modification date is available.

The [local implementation report](seo-implementation-report.md) records separate public and preview built-output checks and a fake hosted-auth routing fixture for the tested uncommitted source. Real hosted authentication and crawler responses still require checks after an authorized release. The flag and sitemap make pages eligible for discovery; Google controls crawling, indexing and rankings.
