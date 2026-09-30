import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { publicPages } from "../../src/lib/public-content";

const routes = ["/overview", "/leads", "/pipeline", "/inbox", "/appointments", "/recovery", "/automations", "/knowledge", "/analytics", "/team", "/integrations", "/settings"];
const publicRoutes = ["/", "/contact", "/product", "/pricing", "/help"];
const publishedRoutes = publicPages.map(page => page.pathname);
const entryRoutes = ["/login", "/signup", "/onboarding", "/auth/error"];
const publicRobots = process.env.PUBLIC_SEARCH_INDEXABLE === "true" ? "index, follow" : "noindex, nofollow";
const runtimeErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  runtimeErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text()); });
});
test.afterEach(({ page }) => { expect.soft(runtimeErrors.get(page)).toEqual([]); });
async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(size.scroll, `Horizontal overflow at ${new URL(page.url()).pathname}`).toBeLessThanOrEqual(size.viewport);
}
async function selectTheme(page: Page, theme: "light" | "dark" | "system") {
  const select = page.getByRole("combobox", { name: "Colour theme" });
  await expect(select).toHaveAttribute("data-appearance-ready", "true");
  await select.selectOption(theme);
  await expect(select).toHaveValue(theme);
  if (theme !== "system") await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => ({ target: node.target, failure: node.failureSummary })) }))).toEqual([]);
}

test("a fresh visit uses the reference light palette even when the device prefers dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const loadedFonts = await page.evaluate(async () => {
    await document.fonts.load('400 14px "Geist Mono"');
    await document.fonts.ready;
    return Array.from(document.fonts).filter(face => face.status === "loaded").map(face => face.family.toLowerCase());
  });
  expect(loadedFonts).toContain("inter variable");
  expect(loadedFonts).toContain("inter hero");
  expect(loadedFonts).toContain("geist mono");
  const theme = page.getByRole("combobox", { name: "Colour theme" });
  await expect(theme).toHaveAttribute("data-appearance-ready", "true");
  await expect(theme).toHaveValue("light");
  await selectTheme(page, "dark");
  await page.goto("/signup");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectTheme(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

for (const width of [320, 375, 414, 768, 1440]) {
  test(`reference typography and paper palette reach public, workspace and account pages at ${width}px`, async ({ page }) => {
    test.setTimeout(360_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    expect(publishedRoutes).toHaveLength(13);
    for (const path of [...publishedRoutes, ...routes, ...entryRoutes]) {
      await test.step(path, async () => {
        if (path === entryRoutes[0]) {
          await page.context().clearCookies();
          await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        }
        const response = await page.goto(path);
        expect(response?.status(), path).toBe(200);
        const marker = publishedRoutes.includes(path)
          ? ".marketing-site"
          : routes.includes(path)
            ? ".app-shell"
            : path === "/onboarding"
              ? ".institute-onboarding"
              : path === "/auth/error"
                ? ".standalone-empty"
                : ".account-entry";
        await expect(page.locator(marker), `Expected ${path} to render its own page`).toBeVisible();
        await expect(page.locator("h1")).toBeVisible();
        await expect.poll(() => new URL(page.url()).pathname, `Unexpected redirect from ${path}`).toBe(path);
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
        const appearance = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          const body = getComputedStyle(document.body);
          const heading = getComputedStyle(document.querySelector("h1")!);
          const property = (name: string) => root.getPropertyValue(name).trim().toLowerCase();
          const color = (name: string) => {
            const probe = document.createElement("span");
            probe.style.backgroundColor = `var(${name})`;
            document.body.appendChild(probe);
            const value = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return value;
          };
          return {
            fontDisplay: property("--font-display"),
            fontBody: property("--font-body"),
            fontMono: property("--font-mono"),
            fontHero: property("--font-hero"),
            paper: color("--color-paper"),
            secondary: color("--color-paper-2"),
            surface: color("--color-surface"),
            ink: color("--color-ink"),
            muted: color("--color-muted"),
            bodyFont: body.fontFamily,
            bodyWeight: body.fontWeight,
            bodyLineRatio: Number.parseFloat(body.lineHeight) / Number.parseFloat(body.fontSize),
            bodyLetterSpacing: Number.parseFloat(body.letterSpacing) / Number.parseFloat(body.fontSize),
            bodyFeatures: body.fontFeatureSettings,
            bodyVariation: body.fontVariationSettings,
            bodyBackground: body.backgroundColor,
            buyerHeading: Boolean(document.querySelector(".buyer-page .buyer-header h1")),
            headingFont: heading.fontFamily,
            headingWeight: heading.fontWeight,
            headingSize: Number.parseFloat(heading.fontSize),
            headingLineRatio: Number.parseFloat(heading.lineHeight) / Number.parseFloat(heading.fontSize),
            headingLetterSpacing: Number.parseFloat(heading.letterSpacing) / Number.parseFloat(heading.fontSize),
            headingFeatures: heading.fontFeatureSettings,
            headingVariation: heading.fontVariationSettings,
          };
        });
        expect(appearance.fontDisplay).toContain("inter variable");
        expect(appearance.fontBody).toContain("inter variable");
        expect(appearance.fontMono).toContain("geist mono");
        expect(appearance.fontHero).toContain("inter");
        expect(appearance.paper).toBe("rgb(250, 250, 247)");
        expect(appearance.secondary).toBe("rgb(243, 242, 236)");
        expect(appearance.surface).toBe("rgb(255, 255, 255)");
        expect(appearance.ink).toBe("rgb(42, 42, 39)");
        expect(appearance.muted).toBe("rgb(102, 100, 93)");
        expect(appearance.bodyFont.toLowerCase()).toContain("inter variable");
        expect(appearance.bodyWeight).toBe("400");
        expect(appearance.bodyLineRatio).toBeCloseTo(1.55, 2);
        expect(appearance.bodyLetterSpacing).toBeCloseTo(-0.008, 3);
        for (const feature of ["blwf", "cv03", "cv04", "cv09", "cv11"]) expect(appearance.bodyFeatures).toContain(feature);
        expect(appearance.bodyVariation).toContain("opsz");
        expect(appearance.bodyBackground).toBe("rgb(250, 250, 247)");
        expect(appearance.headingFont.toLowerCase()).toContain("inter");
        expect(appearance.headingWeight).toBe("500");
        if (appearance.buyerHeading) {
          expect(appearance.headingFont.toLowerCase()).toContain("inter variable");
          for (const feature of ["blwf", "cv03", "cv04", "cv09", "cv11"]) expect(appearance.headingFeatures).toContain(feature);
          expect(appearance.headingVariation).toContain("opsz");
        }
        if (publishedRoutes.includes(path) || ["/login", "/signup", "/onboarding"].includes(path)) {
          expect(appearance.headingLineRatio).toBeCloseTo(1.02, 2);
        }
        expect(appearance.headingLetterSpacing).toBeCloseTo(-0.03, 2);
        if (publishedRoutes.includes(path)) expect(appearance.headingSize).toBeLessThanOrEqual(52);
        if (path.startsWith("/resources/") && width <= 768) {
          const alignment = await page.evaluate(() => ({
            meta: document.querySelector(".buyer-resource-meta.public-container")?.getBoundingClientRect().left,
            article: document.querySelector(".buyer-measure.public-container")?.getBoundingClientRect().left,
          }));
          expect(alignment.meta, "Resource byline must share the article's mobile gutter").toBeCloseTo(alignment.article!, 0);
        }
        await noOverflow(page);
      });
    }
  });
}

for (const width of [390, 768, 1440]) {
  test(`reference hero and reading roles resolve at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    const hero = page.locator("#hero-title");
    const intro = page.locator(".hero-copy > p");
    const sectionHeading = page.locator(".voice-section h2");
    const readingText = page.locator(".voice-section > div > p");
    const measurements = await page.evaluate(() => {
      const styles = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const heroStyle = styles("#hero-title");
      const introStyle = styles(".hero-copy > p");
      const sectionStyle = styles(".voice-section h2");
      const readingStyle = styles(".voice-section > div > p");
      return {
        heroSize: Number.parseFloat(heroStyle.fontSize),
        heroFeatures: heroStyle.fontFeatureSettings,
        heroVariation: heroStyle.fontVariationSettings,
        introSize: Number.parseFloat(introStyle.fontSize),
        introFeatures: introStyle.fontFeatureSettings,
        introVariation: introStyle.fontVariationSettings,
        sectionSize: Number.parseFloat(sectionStyle.fontSize),
        sectionVariation: sectionStyle.fontVariationSettings,
        readingSize: Number.parseFloat(readingStyle.fontSize),
        readingColor: readingStyle.color,
      };
    });
    await expect(hero).toHaveCSS("font-family", /Inter Hero/);
    await expect(intro).toHaveCSS("font-family", /Inter Hero/);
    await expect(sectionHeading).toHaveCSS("font-family", /Inter Variable/);
    await expect(readingText).toHaveCSS("font-family", /Inter Variable/);
    expect(measurements.heroSize).toBeCloseTo(width === 1440 ? 52 : 28.4553, 1);
    expect(measurements.heroFeatures).toBe("normal");
    expect(measurements.heroVariation).toBe("normal");
    expect(measurements.introSize).toBe(width === 1440 ? 18 : 17);
    expect(measurements.introFeatures).toBe("normal");
    expect(measurements.introVariation).toBe("normal");
    expect(measurements.sectionSize).toBe(width === 1440 ? 56 : 28);
    expect(measurements.sectionVariation).toContain("opsz");
    expect(measurements.readingSize).toBe(width === 1440 ? 18 : 15.5);
    expect(measurements.readingColor).toBe("rgb(102, 100, 93)");
    if (width === 1440) {
      await expect(page.locator(".public-desktop-nav a").first()).toHaveCSS("font-size", "14px");
    } else {
      await page.locator(".public-mobile-nav summary").click();
      const row = page.getByRole("navigation", { name: "Mobile public navigation" }).getByRole("link").first();
      await expect(row).toHaveCSS("font-size", "17px");
      await expect(row).toHaveCSS("font-weight", "500");
      await expect(row).toHaveCSS("font-variation-settings", /"opsz" 17/);
    }
  });
}

for (const width of [320, 375, 768, 1440]) {
  test(`public pages at ${width}px never load a workspace`, async ({ page }) => {
    const workspaceRequests: string[] = [], errors: string[] = [];
    page.on("request", request => { if (/\/api\/(workspace|leads|billing|team|organizations)(\?|$)/.test(request.url())) workspaceRequests.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const path of publicRoutes) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByRole("combobox", { name: "Colour theme" })).toBeVisible();
      await selectTheme(page, "dark");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await noOverflow(page);
      await selectTheme(page, "light");
      await noOverflow(page);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", publicRobots);
      if (path === "/") {
        const background = page.locator(".hero-background img");
        await expect(background).toHaveAttribute("alt", "");
        await expect(background).toHaveAttribute("sizes", "100vw");
        await expect(background).toHaveAttribute("fetchpriority", "high");
        await expect.poll(() => background.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        const hero = await page.locator(".public-hero").boundingBox();
        const navigation = await page.locator(".public-nav").boundingBox();
        const copy = await page.locator(".hero-copy").boundingBox();
        expect(hero?.width).toBe(width);
        expect(navigation && copy && navigation.y + navigation.height <= copy.y).toBe(true);
        await expect(page.locator("#hero-title")).toHaveCSS("font-weight", "500");
        await expect(page.locator("#hero-title")).toHaveText("Admissions CRM for coaching institutes.");
        await page.screenshot({ path: `test-results/hero-${width}.jpg`, type: "jpeg", quality: 80 });
        await page.locator(".hero-actions").getByRole("link", { name: "Explore the product" }).click();
        await expect(page).toHaveURL(/\/product$/);
        await expect(page.getByRole("heading", { name: /The enquiry-to-admission workflow/i })).toBeVisible();
        await page.goto("/");
        await page.locator("#workbench").scrollIntoViewIfNeeded();
        await expect(page.locator(".feature-knowledge")).toHaveCSS("opacity", "1");
        for (const image of await page.locator(".illustration img").all()) {
          await image.scrollIntoViewIfNeeded();
          await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `test-results/home-${width}.png`, fullPage: true });
      }
    }
    expect(workspaceRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`public accessibility in ${theme} theme`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const path of publishedRoutes) {
      await page.goto(path);
      await selectTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Reveal all below-fold sections before checking their rendered contrast.
      for (const section of await page.locator(".public-section, .closing-cta").all()) await section.scrollIntoViewIfNeeded();
      await accessible(page);
    }
  });
}

test("account access and institute setup remain accessible in both themes", async ({ page }) => {
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["light", "dark"] as const) {
    for (const path of ["/login", "/signup", "/onboarding"]) {
      await page.goto(path);
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);
      await expect(page.locator("h1")).toBeVisible();
      await selectTheme(page, theme);
      await accessible(page);
    }
  }
});

test("invalid-input message contrast remains readable", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.locator(".account-entry form")).toBeVisible();
  await page.evaluate(() => {
    const message = document.createElement("p");
    message.className = "account-entry-field-error";
    message.setAttribute("role", "alert");
    message.textContent = "Please enter a valid email address.";
    document.querySelector(".account-entry form")?.appendChild(message);
  });
  const message = page.locator(".account-entry-field-error");
  await expect(message).toBeVisible();
  const style = await message.evaluate(element => {
    const computed = getComputedStyle(element);
    return { color: computed.color, background: computed.backgroundColor, fontSize: computed.fontSize };
  });
  expect(style.color).toBe("rgb(185, 54, 40)");
  await page.screenshot({ path: "test-results/signup-invalid-style-probe.png" });
  const result = await new AxeBuilder({ page }).include(".account-entry-field-error").withRules(["color-contrast"]).analyze();
  expect(result.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), JSON.stringify(style)).toEqual([]);
});

test("selected calendar date keeps small text readable", async ({ page }) => {
  await page.goto("/appointments");
  const day = page.locator(".week-strip > button").first();
  await expect(day).toBeVisible();
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
  const style = await day.evaluate(element => {
    const computed = getComputedStyle(element.querySelector("small")!);
    return { color: computed.color, background: getComputedStyle(element).backgroundColor, fontSize: computed.fontSize };
  });
  expect(style.background).toBe("rgb(107, 92, 218)");
  await page.screenshot({ path: "test-results/calendar-selected-style-probe.png" });
  const result = await new AxeBuilder({ page }).include(".week-strip > button.selected").withRules(["color-contrast"]).analyze();
  expect(result.violations.map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })), JSON.stringify(style)).toEqual([]);
});

test("fictional preview requires review and pricing publishes no invented rate", async ({ page }) => {
  const writes: string[] = [];
  page.on("request", request => { if (request.method() !== "GET") writes.push(request.method() + " " + new URL(request.url()).pathname); });
  await page.goto("/product");
  await page.getByRole("button", { name: /Kabir/ }).click();
  await expect(page.getByRole("heading", { name: "Kabir’s enquiry" })).toBeVisible();
  await page.getByRole("button", { name: "Draft a follow-up" }).click();
  await page.getByLabel("Sample follow-up for Kabir").fill("Hi Kabir, which course would you like to discuss?");
  const next = page.getByRole("button", { name: "See example statuses" });
  await expect(next).toBeDisabled();
  await page.getByRole("checkbox", { name: "I’ve reviewed this fictional message." }).check();
  await next.click();
  await expect(page.getByRole("heading", { name: "Accepted is not delivered." })).toBeVisible();
  await expect(page.locator(".preview-statuses")).toContainText("No live request has been made.");
  expect(writes).toEqual([]);
  await page.goto("/pricing");
  await expect(page.locator(".pricing-intro")).toContainText("There is no published rate or paid plan to select here yet.");
  await expect(page.locator(".pricing-card")).not.toContainText("₹");
  await page.locator(".pricing-card").getByRole("link", { name: "Discuss a pilot" }).click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.locator('a[href="mailto:support@admitflow.incfrog.ai"]').first()).toBeVisible();
});

test("audio plays only on request, pauses other samples and includes transcripts", async ({ page }) => {
  await page.goto("/product");
  const players = page.locator("audio");
  await expect(players).toHaveCount(3);
  expect(await players.evaluateAll(items => items.every(item => (item as HTMLAudioElement).paused && !(item as HTMLAudioElement).autoplay))).toBe(true);
  for (const sample of await page.locator(".sample-audio").all()) {
    await sample.getByText("Read transcript", { exact: true }).click();
    await expect(sample.locator("details p")).toBeVisible();
    expect((await sample.locator("details p").innerText()).length).toBeGreaterThan(40);
    await sample.locator("audio").evaluate(async element => { await (element as HTMLAudioElement).play(); });
    await expect.poll(() => sample.locator("audio").evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
    expect(await players.evaluateAll(items => items.filter(item => !(item as HTMLAudioElement).paused).length)).toBe(1);
  }
  await page.goto("/");
  await page.locator("audio").evaluate(async element => { await (element as HTMLAudioElement).play(); });
  await expect.poll(() => page.locator("audio").evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
});

test("missing media keeps readable fallback and transcript", async ({ page }) => {
  await page.route("**/media/**", route => route.abort());
  await page.goto("/");
  await expect(page.locator(".hero-background .illustration-fallback")).toBeVisible();
  await expect(page.locator("#hero-title")).toBeVisible();
  await expect(page.locator(".hero-actions").getByRole("link", { name: "Create account" })).toBeVisible();
  await page.locator("audio").evaluate(element => (element as HTMLAudioElement).load());
  await expect(page.getByRole("status")).toContainText("Audio is unavailable");
  await page.getByText("Read transcript", { exact: true }).click();
  await expect(page.locator(".sample-audio details p")).toBeVisible();
});

test("theme selection is disabled until appearance hydration is ready", async ({ browser, page }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const serverPage = await context.newPage();
    await serverPage.goto("http://127.0.0.1:3100/");
    const select = serverPage.getByRole("combobox", { name: "Colour theme" });
    await expect(select).toHaveAttribute("data-appearance-ready", "false");
    await expect(select).toBeDisabled();
  } finally { await context.close(); }
  await page.addInitScript(() => localStorage.setItem("admitflow:theme", "dark"));
  await page.goto("/");
  const select = page.getByRole("combobox", { name: "Colour theme" });
  await expect(select).toHaveAttribute("data-appearance-ready", "true");
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectTheme(page, "light");
});

test("sidebar, profile, theme persistence and keyboard search remain usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/overview");
  await expect(page.locator("#main-content h1")).toBeVisible();
  await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "80px");
  await selectTheme(page, "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("combobox", { name: "Colour theme" })).toHaveValue("dark");
  await expect(page.locator(".sidebar")).toHaveCSS("width", "80px");
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Profile and workspace settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Search workspace", exact: true }).focus();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search pages and students" }).fill("nothing-matches-this-phrase");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".command-empty")).toBeVisible();
  await accessible(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Search workspace", exact: true })).toBeFocused();
  await selectTheme(page, "system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: "test-results/overview-dark-collapsed.png", fullPage: true });
});

test("all workspace screens are accessible in dark theme", async ({ page }) => {
  test.setTimeout(240_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/overview");
  await selectTheme(page, "dark");
  for (const route of routes) {
    await page.goto(route);
    await expect(page.locator("#main-content h1")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Colour theme" })).toHaveAttribute("data-appearance-ready", "true");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    if (route === "/leads") await expect(page.locator(".leads-panel")).toHaveAttribute("aria-busy", "false");
    await noOverflow(page);
    await accessible(page);
  }
});

test("charts stay contained while zoom resize measurements are pending", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    let paused = false;
    const pending = new Map<ResizeObserver, () => void>();
    window.addEventListener("pause-chart-resize", () => { paused = true; });
    window.addEventListener("resume-chart-resize", () => {
      paused = false;
      for (const deliver of pending.values()) deliver();
      pending.clear();
    });
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        super((entries, observer) => {
          if (paused) pending.set(observer, () => callback(entries, observer));
          else callback(entries, observer);
        });
      }
      disconnect() { pending.delete(this); super.disconnect(); }
    };
  });
  for (const route of ["/analytics", "/overview"]) {
    await test.step(route, async () => {
      await page.goto(route);
      await page.evaluate(() => document.fonts.ready);
      const container = page.locator(".recharts-responsive-container");
      const chart = container.locator(".recharts-wrapper");
      await expect(chart).toBeVisible();
      // Start from a measured chart, then hold the pre-zoom dimensions in place.
      await expect.poll(() => container.evaluate(element => {
        const svg = element.querySelector("svg");
        return Math.abs(Number(svg?.getAttribute("width")) - element.clientWidth);
      })).toBeLessThanOrEqual(1);
      await page.evaluate(() => {
        window.dispatchEvent(new Event("pause-chart-resize"));
        document.body.style.zoom = "2";
      });
      try {
        await noOverflow(page);
        for (const selector of [".recharts-wrapper", ".recharts-surface"]) {
          const fits = await container.evaluate((element, selector) => {
            const child = element.querySelector(selector)!;
            return child.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1;
          }, selector);
          expect(fits, `${selector} must fit before ResizeObserver catches up`).toBe(true);
        }
      } finally {
        await page.evaluate(() => window.dispatchEvent(new Event("resume-chart-resize")));
      }
      await expect.poll(() => container.evaluate(element => {
        const svg = element.querySelector("svg");
        return Math.abs(Number(svg?.getAttribute("width")) - element.clientWidth);
      })).toBeLessThanOrEqual(1);
      await noOverflow(page);
    });
  }
});

test("200 percent CSS zoom keeps public and workspace content reachable", async ({ page }) => {
  test.setTimeout(150_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const route of [...publicRoutes, ...routes]) {
    await page.goto(route);
    await expect(page.locator("h1")).toBeVisible();
    // A visible SSR heading does not mean hydration has attached handlers yet.
    await selectTheme(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await selectTheme(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.evaluate(() => { document.body.style.zoom = "2"; });
    await noOverflow(page);
  }
});
