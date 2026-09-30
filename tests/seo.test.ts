import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import sitemap from "../src/app/sitemap";
import robots from "../src/app/robots";
import { organizationSchema, serializeStructuredData, softwareSchema, websiteSchema } from "../src/components/marketing/structured-data";
import { publicPage, publicPageByPath, publicPages } from "../src/lib/public-content";
import { PUBLIC_ORIGIN, publicPageMetadata, publicSearchIndexable, publicUrl } from "../src/lib/seo";

const originalSearchFlag = process.env.PUBLIC_SEARCH_INDEXABLE;
const originalAppUrl = process.env.APP_BASE_URL;
afterEach(() => {
  if (originalSearchFlag === undefined) delete process.env.PUBLIC_SEARCH_INDEXABLE;
  else process.env.PUBLIC_SEARCH_INDEXABLE = originalSearchFlag;
  if (originalAppUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalAppUrl;
});

test("public metadata has a fixed canonical and social origin without runtime APP_BASE_URL", () => {
  delete process.env.APP_BASE_URL;
  process.env.PUBLIC_SEARCH_INDEXABLE = "true";
  const page = publicPage("/product");
  const metadata = publicPageMetadata(page);

  assert.equal(publicUrl("/product"), `${PUBLIC_ORIGIN}/product`);
  assert.deepEqual(metadata.alternates, { canonical: `${PUBLIC_ORIGIN}/product` });
  assert.deepEqual(metadata.robots, { index: true, follow: true });
  assert.deepEqual(metadata.openGraph, {
    type: "website",
    siteName: "AdmitFlow",
    title: page.title,
    description: page.description,
    url: `${PUBLIC_ORIGIN}/product`,
    images: [{
      url: `${PUBLIC_ORIGIN}/opengraph-image.png`,
      width: 1200,
      height: 630,
      alt: "AdmitFlow admissions workspace for coaching teams",
    }],
  });
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title: page.title,
    description: page.description,
    images: [`${PUBLIC_ORIGIN}/opengraph-image.png`],
  });

  process.env.APP_BASE_URL = "https://preview.example.test";
  assert.deepEqual(publicPageMetadata(page).alternates, metadata.alternates);
});

test("only explicit build flag enables public indexing and sitemap entries", () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    if (value === undefined) delete process.env.PUBLIC_SEARCH_INDEXABLE;
    else process.env.PUBLIC_SEARCH_INDEXABLE = value;
    assert.equal(publicSearchIndexable(), false);
    assert.deepEqual(publicPageMetadata(publicPage("/")).robots, { index: false, follow: false });
    assert.deepEqual(sitemap(), []);
    assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
  }

  process.env.PUBLIC_SEARCH_INDEXABLE = "true";
  assert.equal(publicSearchIndexable(), true);
  assert.deepEqual(publicPageMetadata({
    title: "Sign in",
    description: "Sign in to AdmitFlow.",
    pathname: "/login",
    indexable: false,
  }).robots, { index: false, follow: false });
  assert.deepEqual(robots(), {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${PUBLIC_ORIGIN}/sitemap.xml`,
  });
});

test("sitemap contains only published canonical pages without invented modification dates", () => {
  process.env.PUBLIC_SEARCH_INDEXABLE = "true";
  const entries = sitemap();
  assert.deepEqual(entries.map((entry) => entry.url), publicPages.map((page) => publicUrl(page.pathname)));
  assert.equal(new Set(entries.map((entry) => entry.url)).size, entries.length);
  for (const entry of entries) {
    assert.equal("lastModified" in entry, false);
    assert.ok(publicPageByPath(new URL(entry.url).pathname));
  }
  for (const excluded of ["/welcome", "/login", "/signup", "/privacy", "/terms", "/overview"]) {
    assert.ok(!entries.some((entry) => new URL(entry.url).pathname === excluded));
  }
  assert.ok(entries.some((entry) => entry.url === `${PUBLIC_ORIGIN}/contact`));
});

test("URL construction excludes query strings, fragments and foreign origins", () => {
  assert.equal(publicUrl("/"), `${PUBLIC_ORIGIN}/`);
  for (const invalid of ["product", "//elsewhere.test/product", "/product/", "/product?utm_source=x", "/product#demo"]) {
    assert.throws(() => publicUrl(invalid));
  }
});

test("JSON-LD serializes safely and uses only approved public identity facts", () => {
  const output = serializeStructuredData({ "@context": "https://schema.org", value: "</script><script>alert(1)</script>&\u2028" });
  assert.ok(!output.includes("<"));
  assert.ok(!output.includes(">"));
  assert.deepEqual(JSON.parse(output), { "@context": "https://schema.org", value: "</script><script>alert(1)</script>&\u2028" });
  assert.deepEqual(websiteSchema(), {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${PUBLIC_ORIGIN}/#website`,
    name: "AdmitFlow",
    url: `${PUBLIC_ORIGIN}/`,
  });
  assert.deepEqual(organizationSchema(), {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${PUBLIC_ORIGIN}/#organization`,
    name: "AdmitFlow",
    url: `${PUBLIC_ORIGIN}/`,
    email: "support@admitflow.incfrog.ai",
  });
  assert.equal(softwareSchema()["@type"], "SoftwareApplication");
  assert.equal("offers" in softwareSchema(), false);
  assert.equal("aggregateRating" in softwareSchema(), false);
});
