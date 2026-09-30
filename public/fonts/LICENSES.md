# AdmitFlow local typography

All runtime font requests are same-origin `/fonts/*.woff2` requests. No Google,
Fontsource CDN, or Framer request is made by the application. The root layout
preloads Inter Variable Latin and static Inter Medium 500 Latin on every page.
Static Inter Regular 400, Geist Mono, and extended subsets load on demand
when their characters and CSS families are used.

## CSS family contract

The stylesheet is `src/app/fonts.css`, imported by the root layout before
`tokens.css` and the application styles.

| CSS family | Shared tokens | Actual face |
| --- | --- | --- |
| `Inter Variable` | `--font-body`, `--font-display` | Inter 4.0 upright variable; `wght` 100–900, `opsz` 14–32 |
| `Inter Hero` | `--font-hero`, `--font-hero-body` | Separate static Inter 4.0 Regular 400 and Medium 500 |
| `Geist Mono` | `--font-mono` | Geist Mono 1.701, instantiated at regular 400 |

`Inter Hero` is an explicit CSS alias for the supplied static faces, not a
different Inter design. Assertions should expect that CSS family name.
Hero headings select weight 500; hero paragraphs select weight 400.
Both use normal feature and variation settings through
`--font-hero-features` and `--font-hero-variations`. The variable body, heading,
and navigation roles use optical sizes 18, 32, and 14 respectively, with
`"blwf" on, "cv03" on, "cv04" on, "cv09" on, "cv11" on`.
CSS `font-weight` drives the variable weight axis independently.

## Inter provenance and reference comparison

Official source: [rsms/inter v4.0](https://github.com/rsms/inter/tree/v4.0).
The unmodified license is [OFL-Inter.txt](OFL-Inter.txt).

| Original file | Download URL | Original bytes | Original SHA-256 |
| --- | --- | ---: | --- |
| InterVariable.woff2 | https://raw.githubusercontent.com/rsms/inter/v4.0/docs/font-files/InterVariable.woff2 | 345,588 | `8af7bd5b545567adffb3dfceb5bedb353a522d7bf1b3a2b8af7b6064156babc0` |
| Inter-Regular.woff2 | https://raw.githubusercontent.com/rsms/inter/v4.0/docs/font-files/Inter-Regular.woff2 | 108,488 | `b6f9db9e45be20f3c1312c97fbee7ec36b7d8280f8caa4d53c9ba0408cc9997a` |
| Inter-Medium.woff2 | https://raw.githubusercontent.com/rsms/inter/v4.0/docs/font-files/Inter-Medium.woff2 | 111,380 | `8458f8afa67b5691c1fcbe51607a2dafb53a9839e48131c608a186b65415d96d` |

On 2026-09-29, the three relevant Moonjar reference WOFF2 files were inspected
in memory and compared with the retained official-release subsets:

| Reference face | Public reference URL | Reference bytes | Reference SHA-256 |
| --- | --- | ---: | --- |
| Variable Latin | https://framerusercontent.com/assets/7lw0VWkeXrGYJT05oB3DsFy8BaY.woff2 | 100,176 | `fb914a30c2e0e0e135d5fadedb1396abd8e52723b08baab8357b9dd241d5af02` |
| Static 400 Latin | https://framerusercontent.com/assets/GrgcKwrN6d3Uz8EwcLHZxwEfC4.woff2 | 27,380 | `362b168da82d69bc67d2a358fa20c59151cb4ceac8a5506be6baef5e6827fa42` |
| Static 500 Latin | https://framerusercontent.com/assets/UjlFhCnUjxhNfep4oYBPqnEssyo.woff2 | 27,996 | `216fcca1239e2ce6a2cc6009eac87e7a90ae36e3e0bf1992fdf712f83f58ef06` |

All three reference and local pairs report **Version 4.000;git-a52131595**,
2048 units per em, the same static weight or variable axis limits, and the
requested `cv03`, `cv04`, `cv09`, and `cv11` features. Neither the reference nor
the source font has a Latin `blwf` lookup; the CSS retains the reference's
feature declaration.

Decomposed outlines and advance widths matched for all 278 common encoded
characters of the variable pair at the body (400/18), navigation (500/14),
and heading (500/32) weight/optical settings. They also matched for all 304
common encoded characters of each static pair. This verifies the release,
glyph geometry, and metrics at those settings. It is not a rendered
page-to-page pixel comparison.

These are newly compressed subsets of the licensed official release, rather
than byte-identical copies of the reference CDN files. They retain extra
Latin, combining marks, currency (including U+20B9 ₹), and extended Latin
coverage useful for the application.

## Retained font files

| File | Bytes | Loading |
| --- | ---: | --- |
| `inter-variable-4.0-latin.woff2` | 120,332 | Main face; preloaded by the root layout on every page |
| `inter-variable-4.0-latin-ext.woff2` | 86,160 | Extended characters on demand |
| `inter-regular-4.0-latin.woff2` | 36,284 | Static hero paragraphs on demand |
| `inter-regular-4.0-latin-ext.woff2` | 22,596 | Extended static 400 characters on demand |
| `inter-medium-4.0-latin.woff2` | 37,136 | Static hero headings; preloaded by the root layout on every page |
| `inter-medium-4.0-latin-ext.woff2` | 23,240 | Extended static 500 characters on demand |
| `geist-mono-latin-5.3.0.woff2` | 9,940 | Regular labels and footer on demand |
| `geist-mono-latin-ext-5.3.0.woff2` | 7,056 | Extended mono characters on demand |

Total font files: 342,744 bytes on disk. A page using the main face, both
static hero weights, and Latin mono uses 203,692 bytes of font files before
HTTP headers, assuming no extended glyphs and no cached fonts. Pages without
static hero text still receive the Medium 500 preload; Regular 400 remains
on demand. These are file sizes, not a measured browser-transfer or
performance improvement.

Subsets were produced with the installed FontTools and Brotli libraries;
no application dependency was added. FontTools default shaping features,
kerning, and the additional `cv03`, `cv04`, `cv09`, `cv11`, `tnum`, `pnum`,
and `case` features were retained where their glyphs exist. Glyph names,
name records, and the .notdef outline were retained. Outlines and font
metrics were not redesigned.

Combined Inter Unicode coverage is U+0000–024F, U+0300–036F, U+1E00–1EFF,
U+2000–206F, U+2070–209F, U+20A0–20CF, U+2100–214F, U+2190–2199,
U+2212, U+2215, U+FEFF, and U+FFFD, to the extent supported by the source.
The main subset contains U+0000–00FF, U+0131, U+0152–0153,
U+0300–036F, U+2000–20CF, U+2122, U+2190–2199, U+2212, U+2215,
U+FEFF, and U+FFFD. The extended subset contains the remaining code points.
`unicode-range` in the stylesheet keeps extended files out of the common
Latin path.

## Geist Mono provenance

Pinned distribution:
[`@fontsource-variable/geist-mono@5.3.0`](https://www.npmjs.com/package/@fontsource-variable/geist-mono/v/5.3.0).
Upstream: [vercel/geist-font](https://github.com/vercel/geist-font).
The unmodified license is [OFL-Geist-Mono.txt](OFL-Geist-Mono.txt).

Sources:

- https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.3.0/files/geist-mono-latin-wght-normal.woff2 — 23,128 bytes, SHA-256 `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc`
- https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.3.0/files/geist-mono-latin-ext-wght-normal.woff2 — 14,696 bytes, SHA-256 `1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b`
- https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.3.0/LICENSE

Both source subsets report Version 1.701 and were instantiated at `wght=400`
with FontTools, then compressed to WOFF2. Their original Unicode coverage
was retained. Only upright regular labels are requested, so carrying the
unused weight axis would add bytes without changing their rendering.

### Moonjar Geist Mono comparison

On 2026-09-29, FontTools compared the local Latin 400 face with both declared
Moonjar Latin references:

- [Static 400](https://fonts.gstatic.com/s/geistmono/v6/or3yQ6H-1_WfwkMZI_qYPLs1a-t7PU0AbeE9KK5U5Ck.woff2): 9,864 bytes; SHA-256 `3f98383b122fe015a48536cd4a1cda855a201718923ffe74931a01597107b9b5`.
- [Variable 100–900, evaluated at 400](https://fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmg.woff2): 23,128 bytes; SHA-256 `684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc`.

All report Version 1.701, family `Geist Mono`, regular weight 400, PostScript
name `GeistMono-Regular`, and 1000 units per em. Their shaping feature sets
match (`ccmp`, `dnom`, `frac`, `locl`, `mark`, `mkmk`, `numr`). Decomposed
outlines and advance widths matched for all **225 common encoded characters**
against each reference, including the variable face evaluated at `wght=400`.
The variable reference is also byte-identical to the licensed Fontsource
Latin source identified above. The existing 9,940-byte local static
instance therefore needs no correction. This was a font-data comparison;
no browser or application build was run.
