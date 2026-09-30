import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import { publicPages } from "../../src/lib/public-content";
import { PUBLIC_ORIGIN } from "../../src/lib/seo";

const publishedPaths = [
  "/",
  "/product",
  "/product/whatsapp-follow-up",
  "/product/admissions-recovery",
  "/pricing",
  "/help",
  "/about",
  "/contact",
  "/security",
  "/resources",
  "/resources/coaching-admissions-follow-up-checklist",
  "/resources/how-to-evaluate-an-admissions-crm",
  "/resources/measuring-admissions-recovery-pilot",
];
const indexable = process.env.PUBLIC_SEARCH_INDEXABLE === "true";

async function hydrationReady(page: Page) {
  await expect(page.getByRole("combobox", { name: "Colour theme" }).first()).toHaveAttribute("data-appearance-ready", "true");
}

test("the published registry and sitemap have the same exact URLs", async ({ request }) => {
  expect(publicPages.map(page => page.pathname)).toEqual(publishedPaths);
  expect(new Set(publishedPaths).size).toBe(publishedPaths.length);
  expect(publicPages.every(page => page.indexable && page.sitemap)).toBe(true);

  const response = await request.get("/sitemap.xml");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toMatch(/(?:application|text)\/xml/i);
  const xml = await response.text();
  expect(xml).toContain("<urlset");
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replaceAll("&amp;", "&"));
  expect(urls).toEqual(indexable ? publishedPaths.map(path => `${PUBLIC_ORIGIN}${path}`) : []);
});

test("robots policy and public assets use real crawler-facing responses", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toMatch(/text\/plain/i);
  const body = await robots.text();
  expect(body).toMatch(/User-agent:\s*\*/i);
  if (indexable) {
    expect(body).toMatch(/Allow:\s*\/(?:\r?\n|$)/i);
    expect(body).toMatch(/Disallow:\s*\/api\//i);
    expect(body).toContain(`Sitemap: ${PUBLIC_ORIGIN}/sitemap.xml`);
  } else {
    expect(body).toMatch(/Disallow:\s*\/(?:\r?\n|$)/i);
    expect(body).not.toMatch(/^Sitemap:/im);
  }

  const social = await request.get("/opengraph-image.png");
  expect(social.status()).toBe(200);
  expect(social.headers()["content-type"]).toMatch(/image\/png/i);
  expect(await sharp(await social.body()).metadata()).toMatchObject({ width: 1200, height: 630 });
  for (const asset of ["/media/walkthrough.mp3", "/media/admissions-mountain-hero-small.webp"]) {
    const response = await request.get(asset);
    expect(response.status(), asset).toBe(200);
    expect(response.headers()["content-type"], asset).toMatch(asset.endsWith(".mp3") ? /audio\//i : /image\/webp/i);
  }
});

test("welcome redirects once, permanently, for GET and HEAD and keeps the query", async ({ request }) => {
  for (const method of ["GET", "HEAD"] as const) {
    const response = method === "GET"
      ? await request.get("/welcome?utm_source=google&example=1", { maxRedirects: 0 })
      : await request.head("/welcome?utm_source=google&example=1", { maxRedirects: 0 });
    expect(response.status(), method).toBe(308);
    const location = response.headers().location;
    expect(location).toBeTruthy();
    const destination = new URL(location, "http://127.0.0.1:3100");
    expect(destination.pathname).toBe("/");
    expect(destination.searchParams.get("utm_source")).toBe("google");
    expect(destination.searchParams.get("example")).toBe("1");
    const landing = await request.get(destination.pathname + destination.search, { maxRedirects: 0 });
    expect(landing.status()).toBe(200);
  }
});

test("each published page renders a visible heading without private API requests", async ({ page }) => {
  const publicApiCalls: string[] = [];
  page.on("request", request => {
    if (/\/api\/(?:workspace|leads|billing|team|organizations)(?:[/?]|$)/.test(request.url())) {
      publicApiCalls.push(request.url());
    }
  });
  for (const path of publishedPaths) {
    await test.step(path, async () => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toMatch(/text\/html/i);
      const html = await response!.text();
      expect(html).toMatch(/<main(?:\s|>)/i);
      expect(html).toMatch(/<h1(?:\s|>)/i);
      await expect(page.locator("main h1")).toHaveCount(1);
      await expect(page.locator("main h1")).toBeVisible();
      await expect(page.locator("h1")).not.toHaveText("");
      expect(await page.title()).toContain("AdmitFlow");
    });
  }
  expect(publicApiCalls).toEqual([]);
});

test("unpublished and unknown pages are genuine 404s; private pages stay excluded", async ({ page }) => {
  const expectExcluded = async (path: string) => {
    const directives = await page.locator('meta[name="robots"]').evaluateAll(elements =>
      elements.map(element => (element.getAttribute("content") ?? "").toLowerCase().split(",").map(token => token.trim()).filter(Boolean)),
    );
    expect(directives.length, `${path}: robots meta tags`).toBeGreaterThan(0);
    expect(directives.every(tokens => tokens.length > 0 && tokens.includes("noindex")), `${path}: each robots tag must exclude indexing`).toBe(true);
    expect(directives.flat().some(token => token === "nofollow"), `${path}: links must be excluded`).toBe(true);
    expect(directives.flat().filter(token => token === "index" || token === "follow"), `${path}: no contradictory directives`).toEqual([]);
  };
  for (const path of ["/privacy", "/terms", "/__seo_unpublished__", "/product/unknown-feature", "/resources/unknown-guide"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expectExcluded(path);
  }
  await page.goto("/overview");
  await expectExcluded("/overview");
});

test("primary copy and contact paths work without JavaScript or sending a message", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:3100", javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    for (const path of ["/", "/product", "/pricing", "/contact", "/resources"]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("main h1")).toBeVisible();
      expect((await page.locator("main").innerText()).length).toBeGreaterThan(200);
    }
    await page.goto("/");
    await page.getByRole("navigation", { name: "Public navigation" }).getByRole("link", { name: "Product" }).click();
    await expect(page).toHaveURL(/\/product$/);
    await page.getByRole("navigation", { name: "Public navigation" }).getByRole("link", { name: "Resources" }).click();
    await expect(page).toHaveURL(/\/resources$/);
    const pilot = page.locator('a[href="mailto:support@admitflow.incfrog.ai"]');
    await page.goto("/contact");
    await expect(pilot).toHaveCount(2);
    await expect(page.getByText("Both links open your email app")).toBeVisible();
    await expect(page.locator("form")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("mobile navigation, keyboard access, reduced motion and contrast remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await hydrationReady(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const toggle = page.locator(".public-mobile-nav summary");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".public-mobile-nav")).toHaveAttribute("open", "");
  await expect(page.getByRole("navigation", { name: "Mobile public navigation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".public-mobile-nav")).not.toHaveAttribute("open", "");
  await expect(toggle).toBeFocused();
  for (const width of [320, 768]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of publishedPaths) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path} at ${width}px`).toBe(true);
    }
    await page.goto("/");
    const menu = page.locator(".public-mobile-nav");
    if (await menu.isVisible()) {
      const summary = menu.locator("summary");
      await summary.click();
      await expect(menu).toHaveAttribute("open", "");
      await expect(page.getByRole("navigation", { name: "Mobile public navigation" })).toBeVisible();
    } else {
      await expect(page.getByRole("navigation", { name: "Public navigation" })).toBeVisible();
    }
  }
  await page.setViewportSize({ width: 320, height: 720 });
  for (const path of ["/", "/contact"]) {
    await page.goto(path);
    await hydrationReady(page);
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations.map(violation => ({ id: violation.id, targets: violation.nodes.map(node => node.target) }))).toEqual([]);
  }
});

test("analytics records only verified CTA journey starts and actual playback", async ({ page }) => {
  const events: unknown[] = [];
  await page.exposeFunction("__captureAdmitflowEvent", (detail: unknown) => { events.push(detail); });
  await page.addInitScript(() => {
    window.addEventListener("admitflow:public-analytics", event => {
      const capture = (window as typeof window & { __captureAdmitflowEvent: (detail: unknown) => void }).__captureAdmitflowEvent;
      capture((event as CustomEvent).detail);
    });
  });
  await page.goto("/contact?utm_source=google&utm_medium=cpc&email=student%40example.com");
  await hydrationReady(page);
  const pilot = page.locator('a[data-af-cta="pilot_email"]');
  await expect(pilot).toHaveAttribute("href", "mailto:support@admitflow.incfrog.ai");
  await pilot.evaluate(element => element.addEventListener("click", event => event.preventDefault()));
  await pilot.click();
  await expect.poll(() => events.length).toBe(1);
  expect(events[0]).toEqual({
    version: 1,
    name: "primary_cta_click",
    page_path: "/contact",
    cta_name: "pilot_email",
    placement: "body",
    acquisition_source: "google",
    acquisition_medium: "paid_search",
  });
  expect(JSON.stringify(events)).not.toMatch(/student(?:%40|@)example\.com|demo_request_success|signup_complete/i);

  await page.goto("/?utm_source=linkedin&utm_medium=social&phone=9876543210");
  await hydrationReady(page);
  const signup = page.locator('a[data-af-cta="signup"][data-af-placement="hero"]').first();
  await expect(signup).toHaveAttribute("href", "/signup");
  await signup.evaluate(element => element.addEventListener("click", event => event.preventDefault()));
  await signup.click();
  await expect.poll(() => events.length).toBe(3);
  expect(events[1]).toEqual({
    version: 1,
    name: "primary_cta_click",
    page_path: "/",
    cta_name: "signup",
    placement: "hero",
    acquisition_source: "linkedin",
    acquisition_medium: "social",
  });
  expect(events[2]).toEqual({
    version: 1,
    name: "signup_start",
    page_path: "/",
    placement: "hero",
    acquisition_source: "linkedin",
    acquisition_medium: "social",
  });
  expect(JSON.stringify(events)).not.toMatch(/9876543210|student(?:%40|@)example\.com|signup_complete|account_accept/i);

  await page.goto("/pricing?utm_source=student%40example.com&utm_medium=cpc&phone=9876543210");
  await hydrationReady(page);
  const contact = page.locator('a[data-af-cta="contact"][data-af-placement="body"]').first();
  await expect(contact).toHaveAttribute("href", "/contact");
  await contact.evaluate(element => element.addEventListener("click", event => event.preventDefault()));
  await contact.click();
  await expect.poll(() => events.length).toBe(4);
  expect(events[3]).toEqual({
    version: 1,
    name: "primary_cta_click",
    page_path: "/pricing",
    cta_name: "contact",
    placement: "body",
  });

  await page.goto("/");
  await hydrationReady(page);
  const audio = page.locator('audio[data-af-audio="walkthrough"]');
  await expect(audio).toHaveCount(1);
  await audio.dispatchEvent("play");
  expect(events).toHaveLength(4);
  await audio.click({ position: { x: 20, y: 20 } });
  if (await audio.evaluate(element => (element as HTMLAudioElement).paused)) {
    await audio.evaluate(async element => { await (element as HTMLAudioElement).play(); });
  }
  await expect.poll(() => events.length).toBe(5);
  expect(events[4]).toEqual({
    version: 1,
    name: "sample_audio_play",
    page_path: "/",
    sample_id: "walkthrough",
  });
  await audio.dispatchEvent("playing");
  await page.waitForTimeout(150);
  expect(events).toHaveLength(5);
  expect(JSON.stringify(events)).not.toMatch(/9876543210|student(?:%40|@)example\.com|demo_request_success|signup_complete|account_accept/i);
});
