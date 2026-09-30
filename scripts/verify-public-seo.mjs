import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { publicPages } from "../src/lib/public-content.ts";

const PUBLIC_ORIGIN = "https://admitflow.incfrog.ai";
const SOCIAL_IMAGE = `${PUBLIC_ORIGIN}/opengraph-image.png`;
const JSON_LD_TYPES = new Set(["WebSite", "Organization", "SoftwareApplication", "BreadcrumbList"]);

function argumentsFrom(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!["--base-url", "--mode", "--output"].includes(key) || !value || values[key]) {
      throw new Error("Usage: node scripts/verify-public-seo.mjs --base-url http://127.0.0.1:<port> --mode public|preview --output <evidence.json>");
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3 || !["public", "preview"].includes(values["--mode"])) {
    throw new Error("Supply exactly --base-url, --mode public|preview, and --output.");
  }
  const base = new URL(values["--base-url"]);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new Error("--base-url must be http://127.0.0.1:<port> without a path, query, or credentials.");
  }
  return { base, mode: values["--mode"], output: resolve(values["--output"]) };
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeEntities(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp|#x27);/gi, (_, entity) => {
    if (entity.startsWith("#")) {
      const hex = entity[1]?.toLowerCase() === "x";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    }
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" }[entity.toLowerCase()] ?? _;
  });
}

function normalizeText(value) {
  return decodeEntities(value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function openingTags(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map(match => {
    const attributes = {};
    const body = match[0].slice(name.length + 1, -1);
    for (const attribute of body.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attributes[attribute[1].toLowerCase()] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    return attributes;
  });
}

function one(values, label) {
  ensure(values.length === 1, `Expected exactly one ${label}; found ${values.length}.`);
  return values[0];
}

function tagContent(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "gi"))].map(match => normalizeText(match[1]));
}

function metaContent(html, key, value) {
  return one(openingTags(html, "meta").filter(meta => meta[key] === value).map(meta => meta.content), `${key}=${value}`);
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => openingTags(match[0].slice(0, match[0].indexOf(">") + 1), "script")[0]?.type === "application/ld+json")
    .map(match => match[2]);
  return blocks.map(block => {
    ensure(!/<|>/.test(block), "JSON-LD contains a raw HTML delimiter.");
    const document = JSON.parse(block);
    const nodes = Array.isArray(document) ? document : [document];
    ensure(nodes.length > 0, "JSON-LD array is empty.");
    for (const node of nodes) {
      ensure(node && typeof node === "object" && node["@context"] === "https://schema.org", "JSON-LD has an unexpected context.");
      ensure(JSON_LD_TYPES.has(node["@type"]), `Unexpected JSON-LD type: ${node["@type"]}.`);
      if (node["@type"] === "Organization") {
        ensure(node.name === "AdmitFlow" && node.url === `${PUBLIC_ORIGIN}/` && node.email === "support@admitflow.incfrog.ai", "Organization identity differs from approved facts.");
        for (const forbidden of ["legalName", "address", "founder", "parentOrganization", "aggregateRating", "review"]) {
          ensure(!(forbidden in node), `Unverified Organization field: ${forbidden}.`);
        }
      }
      if (node["@type"] === "WebSite") ensure(node.name === "AdmitFlow" && node.url === `${PUBLIC_ORIGIN}/`, "WebSite identity differs from the public origin.");
      if (node["@type"] === "SoftwareApplication") {
        ensure(node.name === "AdmitFlow" && node.url === `${PUBLIC_ORIGIN}/product`, "SoftwareApplication identity differs from the product page.");
        ensure(!("offers" in node) && !("aggregateRating" in node), "Unverified offer or rating in software schema.");
      }
      if (node["@type"] === "BreadcrumbList") {
        ensure(Array.isArray(node.itemListElement) && node.itemListElement.length > 0, "BreadcrumbList has no items.");
        node.itemListElement.forEach((item, index) => {
          ensure(item["@type"] === "ListItem" && item.position === index + 1 && typeof item.name === "string", "Breadcrumb item is malformed.");
          ensure(typeof item.item === "string" && item.item.startsWith(`${PUBLIC_ORIGIN}/`), "Breadcrumb points outside the public origin.");
        });
      }
    }
    return nodes.map(node => node["@type"]);
  }).flat();
}

function inspectPage(html, definition, mode, headers) {
  const pathname = definition.pathname;
  const canonical = `${PUBLIC_ORIGIN}${pathname}`;
  const title = one(tagContent(html, "title"), "title");
  const description = metaContent(html, "name", "description");
  const h1 = one(tagContent(html, "h1"), "H1");
  const main = one(tagContent(html, "main"), "main");
  const actualCanonical = one(openingTags(html, "link").filter(link => link.rel === "canonical").map(link => link.href), "canonical");
  const robots = metaContent(html, "name", "robots").toLowerCase().split(",").map(part => part.trim());
  const shouldIndex = mode === "public" && definition.indexable;
  const xRobots = headers.get("x-robots-tag")?.toLowerCase() ?? "";

  ensure(title === definition.title, `${pathname}: title differs from the published registry.`);
  ensure(description === definition.description, `${pathname}: description differs from the published registry.`);
  ensure(title.length >= 12 && title.length <= 90, `${pathname}: title is too short or long.`);
  ensure(description.length >= 50 && description.length <= 220, `${pathname}: description is too short or long.`);
  ensure(h1.length >= 10 && h1.length <= 180, `${pathname}: H1 is too short or long.`);
  ensure(main.length >= 120, `${pathname}: main content is too sparse.`);
  ensure(actualCanonical === canonical, `${pathname}: canonical is not the exact public URL.`);
  ensure(robots.includes(shouldIndex ? "index" : "noindex") && robots.includes(shouldIndex ? "follow" : "nofollow"), `${pathname}: robots metadata contradicts ${mode} mode.`);
  ensure(!shouldIndex || (!robots.includes("noindex") && !xRobots.includes("noindex")), `${pathname}: a conflicting noindex directive was emitted.`);
  ensure(metaContent(html, "property", "og:url") === canonical, `${pathname}: og:url differs from the canonical.`);
  ensure(metaContent(html, "property", "og:title") === title, `${pathname}: og:title differs from the title.`);
  ensure(metaContent(html, "property", "og:description") === description, `${pathname}: og:description differs from the description.`);
  ensure(metaContent(html, "property", "og:image") === SOCIAL_IMAGE, `${pathname}: og:image differs from the owned social card.`);
  ensure(metaContent(html, "property", "og:site_name") === "AdmitFlow", `${pathname}: og:site_name differs from the brand.`);
  ensure(metaContent(html, "property", "og:type") === "website", `${pathname}: og:type differs from the declared page type.`);
  ensure(metaContent(html, "name", "twitter:card") === "summary_large_image", `${pathname}: Twitter card type is missing.`);
  ensure(metaContent(html, "name", "twitter:title") === title, `${pathname}: Twitter title differs from the title.`);
  ensure(metaContent(html, "name", "twitter:description") === description, `${pathname}: Twitter description differs from the description.`);
  ensure(metaContent(html, "name", "twitter:image") === SOCIAL_IMAGE, `${pathname}: Twitter image differs from the owned social card.`);

  const schemaTypes = jsonLd(html);
  if (["/", "/product", "/about", "/contact"].includes(pathname)) ensure(schemaTypes.length > 0, `${pathname}: expected factual JSON-LD is absent.`);
  return { pathname, title, description, h1, canonical: actualCanonical, robots: robots.join(", "), schemaTypes };
}

async function request(base, pathname, { method = "GET", cookie = false } = {}) {
  const response = await fetch(new URL(pathname, base), {
    method,
    redirect: "manual",
    headers: cookie ? { cookie: "wos-session=expired-fixture; admitflow_session=expired-fixture" } : {},
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}

function contentType(response, expected, pathname) {
  ensure(expected.test(response.headers.get("content-type") ?? ""), `${pathname}: unexpected Content-Type ${response.headers.get("content-type") ?? "(none)"}.`);
}

async function main() {
  const { base, mode, output } = argumentsFrom(process.argv.slice(2));
  const checks = [];
  const pages = [];
  async function check(name, action) {
    try {
      const result = await action();
      checks.push({ name, ok: true, ...(result === undefined ? {} : { result }) });
    } catch (error) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const definition of publicPages) {
    const pathname = definition.pathname;
    await check(`page ${pathname}`, async () => {
      const response = await request(base, pathname);
      ensure(response.status === 200, `${pathname}: expected HTTP 200; got ${response.status}.`);
      contentType(response, /text\/html/i, pathname);
      const inspected = inspectPage(await response.text(), definition, mode, response.headers);
      pages.push(inspected);
      return inspected;
    });
    await check(`stale session ${pathname}`, async () => {
      const response = await request(base, pathname, { cookie: true });
      ensure(response.status === 200, `${pathname}: stale cookie returned HTTP ${response.status}.`);
      contentType(response, /text\/html/i, pathname);
      const inspected = inspectPage(await response.text(), definition, mode, response.headers);
      return { pathname, title: inspected.title, canonical: inspected.canonical };
    });
  }

  await check("unique page titles, descriptions, and H1", () => {
    ensure(pages.length === publicPages.length, "Some published pages did not pass HTML verification.");
    for (const field of ["title", "description", "h1"]) {
      const normalized = pages.map(page => page[field].toLowerCase().replace(/\s+/g, " ").trim());
      ensure(new Set(normalized).size === normalized.length, `Published pages repeat a ${field}.`);
    }
  });

  await check("robots policy", async () => {
    const response = await request(base, "/robots.txt");
    ensure(response.status === 200, `robots.txt returned HTTP ${response.status}.`);
    contentType(response, /text\/plain/i, "/robots.txt");
    const text = await response.text();
    ensure(/^User-agent:\s*\*$/im.test(text), "robots.txt has no wildcard user agent.");
    if (mode === "public") {
      ensure(/^Allow:\s*\/$/im.test(text) && /^Disallow:\s*\/api\/$/im.test(text), "Public robots policy is missing the root allowance or API exclusion.");
      ensure(text.includes(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`), "robots.txt has the wrong sitemap URL.");
      ensure(!/^Disallow:\s*\/$/im.test(text), "Public robots policy excludes the entire site.");
    } else {
      ensure(/^Disallow:\s*\/$/im.test(text), "Preview robots policy does not disallow the site.");
      ensure(!/^Sitemap:/im.test(text), "Preview robots policy advertises a sitemap.");
    }
  });

  await check("metadata assets bypass stale hosted sessions", async () => {
    for (const pathname of ["/robots.txt", "/sitemap.xml", "/opengraph-image.png", "/favicon.ico"]) {
      const response = await request(base, pathname, { cookie: true });
      ensure(response.status === 200, `${pathname}: stale cookie returned HTTP ${response.status}.`);
    }
  });

  await check("sitemap content and MIME", async () => {
    const response = await request(base, "/sitemap.xml");
    ensure(response.status === 200, `sitemap.xml returned HTTP ${response.status}.`);
    contentType(response, /(?:application|text)\/xml/i, "/sitemap.xml");
    const xml = await response.text();
    ensure(/<urlset\b/i.test(xml), "sitemap.xml has no URL set.");
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(match => decodeEntities(match[1]));
    const expected = mode === "public"
      ? publicPages.filter(page => page.indexable && page.sitemap).map(page => `${PUBLIC_ORIGIN}${page.pathname}`)
      : [];
    ensure(new Set(urls).size === urls.length, "Sitemap has duplicate URLs.");
    ensure(urls.length === expected.length && expected.every(url => urls.includes(url)), "Sitemap URLs differ from the published registry.");
    ensure(!/<lastmod>/i.test(xml), "Sitemap uses an unverified last-modified date.");
    return { urls };
  });

  for (const method of ["GET", "HEAD"]) {
    await check(`/welcome ${method} permanent redirect`, async () => {
      const response = await request(base, "/welcome?utm_source=google&trace=once", { method });
      ensure(response.status === 308, `/welcome ${method} returned HTTP ${response.status}, expected 308.`);
      const location = response.headers.get("location");
      ensure(location, `/welcome ${method} has no Location header.`);
      const destination = new URL(location, base);
      ensure(destination.origin === base.origin && destination.pathname === "/", `/welcome ${method} redirects outside the local root.`);
      ensure(destination.searchParams.get("utm_source") === "google" && destination.searchParams.get("trace") === "once", `/welcome ${method} dropped query parameters.`);
      const final = await request(base, `${destination.pathname}${destination.search}`, { method });
      ensure(final.status === 200, `/welcome ${method} triggered another redirect or did not reach HTTP 200.`);
      return { status: response.status, destination: `${destination.pathname}${destination.search}` };
    });
  }

  await check("owned social card", async () => {
    const response = await request(base, "/opengraph-image.png");
    ensure(response.status === 200, `Social image returned HTTP ${response.status}.`);
    contentType(response, /image\/png/i, "/opengraph-image.png");
    const bytes = Buffer.from(await response.arrayBuffer());
    ensure(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "Social image is not a PNG.");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    ensure(width === 1200 && height === 630, `Social image is ${width}x${height}, expected 1200x630.`);
    return { width, height, bytes: bytes.length };
  });

  await check("favicon response", async () => {
    const response = await request(base, "/favicon.ico");
    ensure(response.status === 200, `favicon.ico returned HTTP ${response.status}.`);
    contentType(response, /image\/(?:x-icon|vnd\.microsoft\.icon|png)/i, "/favicon.ico");
    const bytes = Buffer.from(await response.arrayBuffer());
    ensure(bytes.length > 16, "favicon.ico is empty.");
    ensure(bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])) || bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "favicon.ico is not an icon or PNG.");
    return { bytes: bytes.length };
  });

  for (const pathname of ["/login", "/signup", "/auth/error", "/overview"]) {
    await check(`private or auth ${pathname}`, async () => {
      const response = await request(base, pathname);
      if (response.status >= 300 && response.status < 400) {
        ensure(response.headers.has("location"), `${pathname}: redirect has no Location.`);
        return { pathname, status: response.status, disposition: "redirect" };
      }
      ensure(response.status === 200, `${pathname}: unexpected HTTP ${response.status}.`);
      contentType(response, /text\/html/i, pathname);
      const robots = metaContent(await response.text(), "name", "robots").toLowerCase();
      ensure(robots.includes("noindex"), `${pathname}: HTML has no noindex directive.`);
      return { pathname, status: response.status, disposition: "noindex" };
    });
  }

  for (const pathname of ["/privacy", "/terms", "/__seo_unknown__", "/product/unknown-feature", "/resources/unknown-guide"]) {
    await check(`unknown ${pathname}`, async () => {
      const response = await request(base, pathname);
      ensure(response.status === 404, `${pathname}: expected a real HTTP 404; got ${response.status}.`);
      contentType(response, /text\/html/i, pathname);
      return { pathname, status: response.status };
    });
  }

  const evidence = {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    baseUrl: base.origin,
    publicOrigin: PUBLIC_ORIGIN,
    mode,
    publishedPaths: publicPages.map(page => page.pathname),
    passed: checks.filter(check => check.ok).length,
    failed: checks.filter(check => !check.ok).length,
    checks,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Public SEO: ${evidence.passed} passed, ${evidence.failed} failed. Evidence: ${output}`);
  if (evidence.failed) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
