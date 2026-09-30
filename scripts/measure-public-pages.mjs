import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { platform, release, arch } from "node:os";
import { chromium } from "@playwright/test";
import { verificationEnvironment } from "./verify.mjs";
import { existsSync, readFileSync } from "node:fs";
import { publicPages } from "../src/lib/public-content.ts";

const baseRoutes = ["/", "/product", "/pricing"];
const preexistingRoutes = new Set([...baseRoutes, "/help", "/welcome"]);
const profiles = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, cpuRate: 4, latencyMs: 150, downloadBytesPerSecond: 200_000, uploadBytesPerSecond: 90_000 },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpuRate: 1, latencyMs: 40, downloadBytesPerSecond: 1_250_000, uploadBytesPerSecond: 625_000 },
};

function options() {
  const result = { runs: 3, build: false, webpack: false, nomeasure: false, heaviestnew: false, capturereview: false, fakehosted: false };
  for (let i = 2; i < process.argv.length; i++) {
    const name = process.argv[i];
    if (name === "--build") result.build = true;
    else if (name === "--webpack") result.webpack = true;
    else if (name === "--no-measure") result.nomeasure = true;
    else if (name === "--heaviest-new") result.heaviestnew = true;
    else if (name === "--capture-review") result.capturereview = true;
    else if (name === "--fake-hosted") result.fakehosted = true;
    else if (name === "--diagnostic-preload-hero-medium") result.diagnosticpreloadheromedium = true;
    else if (["--source", "--label", "--output-dir", "--search-indexable", "--runtime-search-indexable", "--verify-mode", "--source-commit", "--runs", "--routes", "--diagnostic-preload-media"].includes(name)) {
      const value = process.argv[++i];
      if (!value) throw new Error(`Missing value for ${name}`);
      result[name.slice(2).replaceAll("-", "")] = name === "--runs" ? Number(value) : value;
    } else throw new Error(`Unknown option: ${name}`);
  }
  if (!result.source || !result.label || !result.outputdir || !Number.isInteger(result.runs) || result.runs < 1) {
    throw new Error("Usage: node scripts/measure-public-pages.mjs --source PATH --label LABEL --output-dir PATH [--build] [--webpack] [--search-indexable true|false] [--runtime-search-indexable absent|true|false] [--verify-mode public|preview] [--heaviest-new] [--capture-review] [--fake-hosted] [--no-measure] [--source-commit SHA] [--runs 3]");
  }
  if (result.searchindexable !== undefined && !["true", "false"].includes(result.searchindexable)) throw new Error("--search-indexable must be true or false");
  if (result.runtimesearchindexable !== undefined && !["absent", "true", "false"].includes(result.runtimesearchindexable)) throw new Error("--runtime-search-indexable must be absent, true or false");
  if (result.verifymode !== undefined && !["public", "preview"].includes(result.verifymode)) throw new Error("--verify-mode must be public or preview");
  if (result.diagnosticpreloadmedia !== undefined && !["all", "desktop"].includes(result.diagnosticpreloadmedia)) throw new Error("--diagnostic-preload-media must be all or desktop");
  if (result.sourcecommit !== undefined && !/^[a-f0-9]{40}$/.test(result.sourcecommit)) throw new Error("--source-commit must be a full Git commit SHA");
  if (result.routes !== undefined) {
    result.routes = result.routes.split(",").map(path => path.trim());
    if (!result.routes.length || result.routes.some(path => !publicPages.some(page => page.pathname === path))) throw new Error("--routes must list published paths separated by commas");
  }
  return result;
}

function sanitizedEnvironment(source, indexable) {
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local"]) {
    if (existsSync(join(source, name))) throw new Error(`Refusing to run with ${name} present in the measurement source`);
  }
  const template = readFileSync(join(source, ".env.example"), "utf8");
  const env = verificationEnvironment(process.env, template, source);
  delete env.APP_BASE_URL;
  // AuthKit consumes this public callback during compilation; Docker's
  // web-build stage requires the same nonsecret build argument.
  env.NEXT_PUBLIC_WORKOS_REDIRECT_URI = "https://admitflow.incfrog.ai/callback";
  env.DATABASE_URL = "";
  env.DATABASE_URL_UNPOOLED = "";
  env.ADMITFLOW_DB = ":memory:";
  env.PUBLIC_SEARCH_INDEXABLE = indexable ?? "";
  env.AWS_EC2_METADATA_DISABLED = "true";
  env.NEXT_TELEMETRY_DISABLED = "1";
  delete env.ADMITFLOW_BROWSER_ISOLATED;
  delete env.ADMITFLOW_BROWSER_DB;
  delete env.NODE_ENV;
  delete env.HOSTNAME;
  delete env.PORT;
  return env;
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).toSorted((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(samples) {
  const result = {};
  for (const key of ["lcpMs", "cls", "layoutShiftSum", "ttfbMs", "scriptTransferBytes", "stylesheetTransferBytes", "imageTransferBytes", "totalTransferBytes"]) {
    result[key] = median(samples.map(sample => sample[key]));
  }
  return result;
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForServer(origin, child) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`);
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error("Next server did not become ready");
}

async function fetchLocal(origin, path, init = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolveWait => setTimeout(resolveWait, 500 * attempt));
    }
  }
  throw new Error(`Local server fetch ${path} failed after 3 attempts: ${lastError?.message ?? "unknown error"}; cause: ${lastError?.cause?.code ?? lastError?.cause?.message ?? "unavailable"}`);
}

async function findHeaviestNewPage(origin) {
  const sitemap = await fetchLocal(origin, "/sitemap.xml");
  if (!sitemap.ok) throw new Error(`Cannot select new page: sitemap returned ${sitemap.status}`);
  const xml = await sitemap.text();
  const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map(match => new URL(match[1]).pathname)
    .filter(path => path.startsWith("/") && !preexistingRoutes.has(path));
  if (!paths.length) throw new Error("Cannot select new page: sitemap has no new pages");
  const candidates = [];
  for (const path of paths) {
    const response = await fetchLocal(origin, path);
    if (!response.ok) throw new Error(`Cannot select new page: ${path} returned ${response.status}`);
    const html = await response.text();
    candidates.push({ path, emittedHtmlBytes: Buffer.byteLength(html, "utf8") });
  }
  candidates.sort((a, b) => b.emittedHtmlBytes - a.emittedHtmlBytes);
  return { criterion: "largest emitted HTML bytes among new published sitemap pages; shared initial JS/CSS is measured during the selected route's lab runs", candidates, selectedPath: candidates[0].path };
}

async function prepareHostedFixture(outputDir, runtimeEnv, origin) {
  const guardPath = join(outputDir, "fixture-network-guard.cjs");
  const guardLog = join(outputDir, "fixture-network-guard.log");
  const guardSource = `
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const allowed = host => !host || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host).toLowerCase());
function guarded(original) {
  return function (...args) {
    const first = args[0];
    const host = typeof first === "object" && first !== null ? first.host ?? first.hostname :
      typeof first === "number" && typeof args[1] === "string" ? args[1] : undefined;
    if (!allowed(host)) {
      fs.appendFileSync(process.env.ADMITFLOW_FIXTURE_GUARD_LOG, String(host) + "\\n");
      throw new Error("Hosted fixture blocked non-loopback socket");
    }
    return original.apply(this, args);
  };
}
net.connect = guarded(net.connect);
net.createConnection = net.connect;
tls.connect = guarded(tls.connect);
const nativeFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) {
    fs.appendFileSync(process.env.ADMITFLOW_FIXTURE_GUARD_LOG, url.hostname + "\\n");
    throw new Error("Hosted fixture blocked non-loopback fetch");
  }
  return nativeFetch.call(this, input, init);
};
`;
  await writeFile(guardPath, guardSource, "utf8");
  await writeFile(guardLog, "", "utf8");
  runtimeEnv.WORKOS_API_KEY = "sk_test_admitflow_fixture_000000000000000000000000";
  runtimeEnv.WORKOS_CLIENT_ID = "client_00000000000000000000000000";
  runtimeEnv.WORKOS_COOKIE_PASSWORD = "admitflow-fixture-cookie-password-000000000000";
  runtimeEnv.NEXT_PUBLIC_WORKOS_REDIRECT_URI = "https://admitflow.incfrog.ai/callback";
  runtimeEnv.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/admitflow?connect_timeout=1";
  runtimeEnv.ADMITFLOW_FIXTURE_GUARD_LOG = guardLog;
  runtimeEnv.NODE_OPTIONS = `--require=${guardPath}`;
  return { guardPath, guardLog };
}

async function verifyHostedFixture(origin, outputDir, label, guardLog) {
  const cases = [
    { label: "anonymous", cookie: null },
    { label: "malformed", cookie: "wos-session=malformed; admitflow_session=malformed" },
    { label: "stale", cookie: "wos-session=stale-fixture; admitflow_session=stale-fixture" },
  ];
  const sitemapResponse = await fetch(`${origin}/sitemap.xml`, { signal: AbortSignal.timeout(10_000) });
  await sitemapResponse.arrayBuffer();
  const paths = publicPages.map(page => page.pathname);
  const assetPaths = ["/robots.txt", "/sitemap.xml", "/favicon.ico", "/opengraph-image.png", "/media/walkthrough.mp3", "/media/admissions-mountain-hero-960.webp", "/fonts/inter-variable-4.0-latin.woff2", "/fonts/inter-medium-4.0-latin.woff2"];
  const result = {
    label,
    capturedAt: new Date().toISOString(),
    mode: "runtime-only fake hosted WorkOS/Postgres fixture; public build unchanged",
    appBaseUrlRuntime: "absent",
    databaseEndpoint: "unused loopback port 1",
    cookieCases: cases.map(item => item.label),
    publicPaths: paths,
    assetPaths,
    cases: [],
    protected: [],
    protectedBrowser: [],
    blockedRemoteHostsDuringPublicChecks: [],
    blockedRemoteHostsDuringProtectedChecks: [],
    passed: false,
  };
  try {
    if (sitemapResponse.status !== 200 || !paths.length) throw new Error(`Fixture sitemap invalid: ${sitemapResponse.status}, ${paths.length} pages`);
    for (const cookieCase of cases) {
      for (const path of [...paths, ...assetPaths]) {
        const response = await fetch(`${origin}${path}`, { headers: cookieCase.cookie ? { Cookie: cookieCase.cookie } : {}, redirect: "manual", signal: AbortSignal.timeout(15_000) });
        result.cases.push({ cookieCase: cookieCase.label, path, status: response.status, contentType: response.headers.get("content-type") });
        await response.arrayBuffer();
      }
    }
    result.blockedRemoteHostsDuringPublicChecks = [...new Set((await readFile(guardLog, "utf8")).split(/\r?\n/).filter(Boolean))];
    for (const cookieCase of cases) {
      for (const path of ["/overview", "/api/workspace"]) {
        const response = await fetch(`${origin}${path}`, {
          headers: cookieCase.cookie ? { Cookie: cookieCase.cookie } : {},
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        const body = path === "/overview" ? await response.text() : (await response.arrayBuffer(), "");
        result.protected.push({
          cookieCase: cookieCase.label,
          path,
          status: response.status,
          locationPath: response.headers.get("location") ? new URL(response.headers.get("location"), origin).pathname : null,
          noindex: path === "/overview" ? /<meta[^>]+name="robots"[^>]+content="noindex(?:,\s*nofollow)?"/i.test(body) : null,
          emptyWorkspaceShell: path === "/overview" ? body.includes('class="loading-workspace"') : null,
        });
      }
    }
    const browser = await chromium.launch({ headless: true });
    try {
      for (const cookieCase of cases) {
        const context = await browser.newContext();
        const blockedOrigins = new Set();
        await context.route("**/*", route => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          blockedOrigins.add(url.origin);
          return route.abort();
        });
        if (cookieCase.cookie) {
          await context.addCookies(cookieCase.cookie.split("; ").map(part => {
            const [name, value] = part.split("=");
            return { name, value, url: origin };
          }));
        }
        const page = await context.newPage();
        let landedOnLogin = false;
        try {
          await page.goto(`${origin}/overview`, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await page.waitForURL(url => url.pathname === "/login", { timeout: 20_000 });
          landedOnLogin = true;
        } catch {}
        result.protectedBrowser.push({
          cookieCase: cookieCase.label,
          landedOnLogin,
          finalPath: new URL(page.url()).pathname,
          blockedOrigins: [...blockedOrigins],
        });
        await context.close();
      }
    } finally {
      await browser.close();
    }
    result.blockedRemoteHostsDuringProtectedChecks = [...new Set((await readFile(guardLog, "utf8")).split(/\r?\n/).filter(Boolean))]
      .filter(host => !result.blockedRemoteHostsDuringPublicChecks.includes(host));
    result.passed = result.cases.every(item => item.status === 200)
      && result.blockedRemoteHostsDuringPublicChecks.length === 0
      && result.protected.every(item =>
        item.path === "/overview"
          ? (item.status >= 300 && item.status < 400) || (item.status === 200 && item.noindex && item.emptyWorkspaceShell)
          : [401, 403].includes(item.status))
      && result.protectedBrowser.every(item => item.landedOnLogin && item.blockedOrigins.length === 0);
    if (!result.passed) throw new Error("Fake hosted fixture route statuses failed");
  } catch (error) {
    result.error = error.message;
  }
  const output = join(outputDir, `${label}-hosted-fixture.json`);
  await writeFile(output, JSON.stringify(result, null, 2), "utf8");
  console.log(`Saved ${output}`);
  if (!result.passed) throw new Error(`Fake hosted fixture failed: ${result.error}`);
}

async function captureReview(browser, origin, outputDir, label, selectedNewPath) {
  const review = { capturedAt: new Date().toISOString(), reducedMotion: "reduce", screenshots: [], headings: {}, lazyImages: {}, interactions: {}, blockedOrigins: [] };
  const blocked = new Set();
  let failure;
  const contextOptions = { reducedMotion: "reduce", serviceWorkers: "block" };
  const desktop = await browser.newContext({ ...contextOptions, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const mobile = await browser.newContext({ ...contextOptions, viewport: { width: 320, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const referenceMobile = await browser.newContext({ ...contextOptions, viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const tablet = await browser.newContext({ ...contextOptions, viewport: { width: 768, height: 1024 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  for (const context of [desktop, mobile, referenceMobile, tablet]) await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    blocked.add(url.origin);
    return route.abort();
  });
  async function screenshot(page, suffix, fullPage = true) {
    await page.evaluate(() => document.fonts.ready);
    if (fullPage) {
      // Review screenshots should show lazy artwork after it has entered the
      // viewport. Cold performance samples run separately and stay untouched.
      for (const image of await page.locator('img[loading="lazy"]').all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate(async element => {
          if (!element.complete) await new Promise((resolveImage, rejectImage) => {
            element.addEventListener("load", resolveImage, { once: true });
            element.addEventListener("error", () => rejectImage(new Error("Review image failed to load")), { once: true });
          });
          if (!element.naturalWidth) throw new Error("Review image has no natural width");
          await element.decode();
        });
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    }
    const path = join(outputDir, `${label}-${suffix}.png`);
    await page.screenshot({ path, fullPage });
    review.screenshots.push(path);
  }
  async function captureBuyerHeading(page, route) {
    const heading = page.locator(".buyer-page .buyer-header h1");
    if (await heading.count() === 0) return;
    await page.evaluate(() => document.fonts.ready);
    review.headings[route] = await heading.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        text: element.textContent?.trim(),
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        fontSize: style.fontSize,
        fontFeatureSettings: style.fontFeatureSettings,
        fontVariationSettings: style.fontVariationSettings,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
      };
    });
  }
  async function routeScreenshot(page, route, suffix) {
    const response = await page.goto(`${origin}${route}`);
    const expectedStatus = route === "/missing-page" ? 404 : 200;
    if (response?.status() !== expectedStatus) throw new Error(`Visual capture ${route} returned ${response?.status()}`);
    await page.locator("h1").first().waitFor({ state: "visible" });
    if (new URL(page.url()).pathname !== route) throw new Error(`Visual capture ${route} redirected to ${new URL(page.url()).pathname}`);
    if (await page.locator("html").getAttribute("data-theme") !== "light") throw new Error(`Visual capture ${route} did not use the light reference theme`);
    await screenshot(page, suffix);
    await captureBuyerHeading(page, route);
  }
  async function check(name, action) {
    try { review.interactions[name] = { passed: true, result: await action() }; }
    catch (error) { review.interactions[name] = { passed: false, error: error.message }; }
  }
  async function captureLazyImageSection(page, selector, suffix) {
    const section = page.locator(selector).first();
    const image = section.locator("img").first();
    await image.scrollIntoViewIfNeeded();
    review.lazyImages[selector] = await image.evaluate(async element => {
      if (!element.complete) await new Promise((resolveImage, rejectImage) => {
        element.addEventListener("load", resolveImage, { once: true });
        element.addEventListener("error", () => rejectImage(new Error("Image load failed")), { once: true });
      });
      if (!element.naturalWidth) throw new Error("Image has no natural width after scroll");
      await element.decode();
      return { complete: element.complete, naturalWidth: element.naturalWidth, naturalHeight: element.naturalHeight, currentSrc: new URL(element.currentSrc).pathname };
    });
    await screenshot(page, suffix, false);
  }
  try {
    const wide = await desktop.newPage();
    await wide.goto(`${origin}/`);
    await screenshot(wide, "desktop-home");
    await check("desktopTheme", async () => {
      await wide.getByRole("combobox", { name: "Colour theme" }).selectOption("dark");
      await wide.locator('html[data-theme="dark"]').waitFor();
      return { selected: "dark", applied: await wide.locator("html").getAttribute("data-theme") };
    });
    await wide.getByRole("combobox", { name: "Colour theme" }).selectOption("light");
    await wide.locator('html[data-theme="light"]').waitFor();
    await wide.goto(`${origin}/product`);
    await screenshot(wide, "desktop-product");
    if (selectedNewPath) {
      await wide.goto(`${origin}${selectedNewPath}`);
      await screenshot(wide, "desktop-heaviest-new");
      await captureBuyerHeading(wide, selectedNewPath);
      await wide.goto(`${origin}/product`);
    }
    await check("productAudioAndTranscript", async () => {
      const sample = wide.locator(".sample-audio").first();
      await sample.getByText("Read transcript", { exact: true }).click();
      await sample.locator("details p").waitFor({ state: "visible" });
      await sample.locator("audio").evaluate(async element => { await element.play(); });
      await wide.waitForFunction(() => [...document.querySelectorAll(".sample-audio audio")].some(element => element.currentTime > 0), undefined, { timeout: 5_000 });
      const simultaneouslyPlaying = await wide.locator(".sample-audio audio").evaluateAll(items => items.filter(item => !item.paused).length);
      if (simultaneouslyPlaying !== 1) throw new Error(`Expected one playing sample, found ${simultaneouslyPlaying}`);
      return { playbackAdvanced: true, transcriptVisible: true, simultaneouslyPlaying };
    });
    for (const [route, suffix] of [["/contact", "desktop-contact"], ["/resources/how-to-evaluate-an-admissions-crm", "desktop-resource"], ["/overview", "desktop-workspace"], ["/signup", "desktop-signup"], ["/onboarding", "desktop-onboarding"], ["/missing-page", "desktop-not-found"]]) {
      await routeScreenshot(wide, route, suffix);
    }
    const narrow = await mobile.newPage();
    await narrow.goto(`${origin}/`);
    await screenshot(narrow, "mobile-320-home");
    await check("mobileKeyboardMenu", async () => {
      const menu = narrow.locator(".public-mobile-nav summary");
      await menu.focus();
      await narrow.keyboard.press("Enter");
      await narrow.locator(".public-mobile-nav[open]").waitFor();
      const open = await narrow.locator(".public-mobile-nav").getAttribute("open");
      await screenshot(narrow, "mobile-320-menu", false);
      await narrow.keyboard.press("Escape");
      const closed = await narrow.locator(".public-mobile-nav").getAttribute("open") === null;
      const focusReturned = await menu.evaluate(element => document.activeElement === element);
      const horizontalOverflow = await narrow.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      if (open === null || !closed || !focusReturned || horizontalOverflow) throw new Error("Mobile menu keyboard or narrow width assertion failed");
      return { openedWithEnter: true, closedWithEscape: true, focusReturned, horizontalOverflow };
    });
    for (const [context, width] of [[referenceMobile, 390], [tablet, 768]]) {
      const page = await context.newPage();
      for (const [route, suffix] of [["/", "home"], ["/overview", "workspace"], ["/signup", "signup"], ["/onboarding", "onboarding"]]) {
        await routeScreenshot(page, route, `${width}-${suffix}`);
        if (route === "/" && width === 390) {
          await check("mobile390LazyTeamImage", () => captureLazyImageSection(page, ".feature-team", "390-team-image-scrolled"));
          await check("mobile390LazyClosingImage", () => captureLazyImageSection(page, ".closing-cta", "390-closing-image-scrolled"));
        }
      }
      if (width === 390) await routeScreenshot(page, "/resources/how-to-evaluate-an-admissions-crm", "390-resource");
    }
  } catch (error) {
    failure = error;
    review.error = error.message;
  } finally {
    review.blockedOrigins = [...blocked];
    await desktop.close();
    await mobile.close();
    await referenceMobile.close();
    await tablet.close();
  }
  const output = join(outputDir, `${label}-visual-interactions.json`);
  await writeFile(output, JSON.stringify(review, null, 2), "utf8");
  console.log(`Saved ${output}`);
  if (failure) throw failure;
  if (Object.values(review.interactions).some(item => !item.passed)) throw new Error(`Visual interaction checks failed; see ${output}`);
  return review;
}

async function measurePage(browser, origin, path, profile, run, diagnosticPreloadHeroMedium = false, diagnosticPreloadMedia = null) {
  const context = await browser.newContext({
    viewport: profile.viewport,
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const blockedOrigins = new Set();
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) {
      if (diagnosticPreloadMedia && route.request().isNavigationRequest() && ["/", "/product"].includes(url.pathname)) {
        const response = await route.fetch();
        const body = await response.text();
        let replaced = 0;
        const amended = body.replace(/<link rel="preload" href="\/fonts\/inter-medium-4\.0-latin\.woff2"[^>]*\/>/g, tag => {
          replaced++;
          return tag.replace(/\/>$/, ` media="${diagnosticPreloadMedia === "desktop" ? "(min-width: 801px)" : "all"}"/>`);
        });
        if (replaced !== 2) throw new Error(`Expected 2 existing Inter medium preload links, found ${replaced}`);
        return route.fulfill({ response, body: amended });
      }
      if (diagnosticPreloadHeroMedium && route.request().isNavigationRequest() && url.pathname === "/product") {
        const response = await route.fetch();
        const body = await response.text();
        const preload = '<link rel="preload" href="/fonts/inter-medium-4.0-latin.woff2" as="font" type="font/woff2" crossorigin="anonymous">';
        if (!body.includes("<head>")) throw new Error("Diagnostic cannot find an initial HTML head");
        return route.fulfill({ response, body: body.replace("<head>", `<head>${preload}`) });
      }
      return route.continue();
    }
    blockedOrigins.add(url.origin);
    return route.abort();
  });
  await page.addInitScript(() => {
    window.__admitflowLab = { lcpMs: null, cls: 0, layoutShiftSum: 0, lcpElement: null, shiftSessionStart: null, shiftSessionLast: null, shiftSessionValue: 0, shifts: [], fontsReadyMs: null, fontEvents: [] };
    document.fonts.ready.then(() => { window.__admitflowLab.fontsReadyMs = performance.now(); });
    for (const name of ["loading", "loadingdone", "loadingerror"]) {
      document.fonts.addEventListener(name, event => {
        window.__admitflowLab.fontEvents.push({
          name,
          atMs: performance.now(),
          families: Array.from(event.fontfaces ?? []).map(face => face.family),
        });
      });
    }
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__admitflowLab.lcpMs = entry.startTime;
        const element = entry.element;
        window.__admitflowLab.lcpElement = element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${typeof element.className === "string" && element.className ? `.${element.className.trim().split(/\s+/).join(".")}` : ""}` : null;
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.hadRecentInput) continue;
        const lab = window.__admitflowLab;
        lab.layoutShiftSum += entry.value;
        if (lab.shiftSessionStart === null || entry.startTime - lab.shiftSessionLast > 1_000 || entry.startTime - lab.shiftSessionStart > 5_000) {
          lab.shiftSessionStart = entry.startTime;
          lab.shiftSessionValue = 0;
        }
        lab.shiftSessionLast = entry.startTime;
        lab.shiftSessionValue += entry.value;
        lab.cls = Math.max(lab.cls, lab.shiftSessionValue);
        const shift = {
          atMs: entry.startTime,
          value: entry.value,
          fontsStatus: document.fonts.status,
          sources: [],
        };
        lab.shifts.push(shift);
        for (const source of entry.sources ?? []) {
          const node = source.node;
          shift.sources.push({
            node: typeof node?.tagName === "string" ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/).join(".")}` : ""}` : null,
            previousRect: source.previousRect,
            currentRect: source.currentRect,
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const session = await context.newCDPSession(page);
  await session.send("Network.enable");
  await session.send("Network.setCacheDisabled", { cacheDisabled: true });
  await session.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadBytesPerSecond,
    uploadThroughput: profile.uploadBytesPerSecond,
    connectionType: profile.isMobile ? "cellular4g" : "wifi",
  });
  await session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuRate });
  const requests = new Map();
  session.on("Network.responseReceived", event => {
    requests.set(event.requestId, {
      url: event.response.url,
      type: event.type,
      mimeType: event.response.mimeType,
      status: event.response.status,
      transferBytes: 0,
    });
  });
  session.on("Network.loadingFinished", event => {
    const request = requests.get(event.requestId);
    if (request) request.transferBytes = event.encodedDataLength;
  });
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: "load", timeout: 45_000 });
    await page.waitForTimeout(2_500);
    const observations = await page.evaluate(() => ({
      ...window.__admitflowLab,
      ttfbMs: performance.getEntriesByType("navigation")[0]?.responseStart ?? null,
      title: document.title,
      canonical: [...document.querySelectorAll('link[rel="canonical"]')].map(element => element.href),
      robots: [...document.querySelectorAll('meta[name="robots"]')].map(element => element.content),
      h1: [...document.querySelectorAll("h1")].map(element => element.textContent?.trim()),
      heroImageCurrentSrc: (() => {
        const image = document.querySelector('img[src*="/media/admissions-mountain-hero"]');
        return image?.currentSrc ? new URL(image.currentSrc).pathname : null;
      })(),
    }));
    const entries = [...requests.values()].filter(request => new URL(request.url).origin === origin && request.transferBytes > 0);
    const total = kind => entries.filter(request => kind(request)).reduce((sum, request) => sum + request.transferBytes, 0);
    const sample = {
      path, run, status: response?.status() ?? null,
      ...observations,
      scriptTransferBytes: total(request => request.type === "Script" || /javascript/.test(request.mimeType)),
      stylesheetTransferBytes: total(request => request.type === "Stylesheet" || /text\/css/.test(request.mimeType)),
      imageTransferBytes: total(request => request.type === "Image" || /^image\//.test(request.mimeType)),
      totalTransferBytes: total(() => true),
      resourceCount: entries.length,
      blockedOrigins: [...blockedOrigins],
    };
    return { sample, resources: entries };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = options();
  const source = resolve(args.source);
  const outputDir = resolve(args.outputdir);
  const env = sanitizedEnvironment(source, args.searchindexable);
  const runtimeEnv = { ...env };
  if (args.runtimesearchindexable === "absent") delete runtimeEnv.PUBLIC_SEARCH_INDEXABLE;
  else if (args.runtimesearchindexable) runtimeEnv.PUBLIC_SEARCH_INDEXABLE = args.runtimesearchindexable;
  await mkdir(outputDir, { recursive: true });
  if (args.build) {
    const result = spawnSync(process.execPath, ["node_modules/next/dist/bin/next", "build", ...(args.webpack ? ["--webpack"] : [])], { cwd: source, env, stdio: "inherit", timeout: 40 * 60_000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Next production build failed: ${result.error?.message ?? result.status}`);
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixtureGuard = args.fakehosted ? await prepareHostedFixture(outputDir, runtimeEnv, origin) : null;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: source, env: runtimeEnv, stdio: "inherit", windowsHide: true });
  let browser;
  try {
    await waitForServer(origin, child);
    if (args.verifymode) {
      const output = join(outputDir, `${args.label}-verification.json`);
      const checked = spawnSync(process.execPath, [join(import.meta.dirname, "verify-public-seo.mjs"), "--base-url", origin, "--mode", args.verifymode, "--output", output], { cwd: resolve(import.meta.dirname, ".."), env: runtimeEnv, stdio: "inherit", timeout: 3 * 60_000, windowsHide: true });
      if (checked.error || checked.status !== 0) throw new Error(`Built SEO verification failed: ${checked.error?.message ?? checked.status}`);
      console.log(`Saved ${output}`);
    }
    if (fixtureGuard) await verifyHostedFixture(origin, outputDir, args.label, fixtureGuard.guardLog);
    if (args.nomeasure) {
      if (args.capturereview) {
        browser = await chromium.launch({ headless: true });
        await captureReview(browser, origin, outputDir, args.label, null);
      }
      return;
    }
    browser = await chromium.launch({ headless: true });
    const all = {
      label: args.label,
      capturedAt: new Date().toISOString(),
      source,
      sourceCommit: args.sourcecommit ?? spawnSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8", windowsHide: true }).stdout.trim(),
      browser: `Chromium ${browser.version()}`,
      bundler: args.webpack ? "webpack" : "Turbopack",
      node: process.version,
      os: `${platform()} ${release()} ${arch()}`,
      searchIndexableBuildSetting: args.searchindexable ?? "unset",
      appBaseUrlBuildAndRuntime: "absent",
      searchIndexableRuntimeSetting: args.runtimesearchindexable ?? args.searchindexable ?? "unset",
      runsPerPageAndProfile: args.runs,
      reducedMotion: "reduce",
      observationWindow: "navigation load plus 2500 ms; cold cache on each run; no interactions",
      clsMethod: "maximum layout-shift session-window sum (1 s gap, 5 s maximum), excluding recent input",
      externalOriginPolicy: "requests to origins other than the local production server were blocked; each sample lists any attempted origins",
      diagnosticHtmlPreload: args.diagnosticpreloadheromedium ? "/fonts/inter-medium-4.0-latin.woff2 inserted into the initial /product HTML by browser interception; source and built output unchanged" : null,
      diagnosticPreloadMedia: args.diagnosticpreloadmedia
        ? `paired initial HTML interception of both existing Inter medium preload tags; media=${args.diagnosticpreloadmedia === "desktop" ? "(min-width: 801px)" : "all"}; source and built output unchanged`
        : null,
      profiles,
      results: {},
    };
    const selection = args.heaviestnew ? await findHeaviestNewPage(origin) : null;
    const routes = args.routes ?? (selection ? [...baseRoutes, selection.selectedPath] : baseRoutes);
    all.routeSelection = selection;
    for (const path of routes) {
      const filename = path === "/" ? "home" : path.slice(1).replaceAll("/", "-");
      const raw = await fetchLocal(origin, path, { redirect: "manual" });
      await writeFile(join(outputDir, `${args.label}-${filename}.html`), await raw.text(), "utf8");
      const routeResult = { rawHtmlStatus: raw.status, rawHtmlContentType: raw.headers.get("content-type"), profiles: {} };
      for (const [name, profile] of Object.entries(profiles)) {
        const samples = [];
        const resources = [];
        for (let run = 1; run <= args.runs; run++) {
          const observed = await measurePage(browser, origin, path, profile, run, args.diagnosticpreloadheromedium, args.diagnosticpreloadmedia);
          samples.push(observed.sample);
          if (run === 1) resources.push(...observed.resources);
          console.log(`${args.label} ${path} ${name} ${run}/${args.runs}: LCP ${observed.sample.lcpMs?.toFixed(0) ?? "n/a"} ms, CLS ${observed.sample.cls.toFixed(3)}, JS ${observed.sample.scriptTransferBytes} B`);
        }
        routeResult.profiles[name] = { median: summarize(samples), samples, firstRunResources: resources };
      }
      all.results[path] = routeResult;
    }
    await writeFile(join(outputDir, `${args.label}-measurements.json`), JSON.stringify(all, null, 2), "utf8");
    console.log(`Saved ${join(outputDir, `${args.label}-measurements.json`)}`);
    if (args.capturereview) await captureReview(browser, origin, outputDir, args.label, selection?.selectedPath);
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
