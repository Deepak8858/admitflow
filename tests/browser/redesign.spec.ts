import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = ["/", "/leads", "/pipeline", "/inbox", "/appointments", "/recovery", "/automations", "/knowledge", "/analytics", "/team", "/integrations", "/settings"];
const publicRoutes = ["/welcome", "/product", "/pricing"];
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
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
      if (path === "/welcome") {
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
        await expect(page.locator("#hero-title")).toHaveCSS("font-weight", "650");
        await expect(page.locator("#hero-title")).toHaveText("Your admissions pipeline. One connected workspace.");
        await page.screenshot({ path: `test-results/hero-${width}.jpg`, type: "jpeg", quality: 80 });
        await page.locator(".hero-actions").getByRole("link", { name: "Explore the product" }).click();
        await expect(page.locator("#workbench .workbench-heading")).toBeInViewport();
        await expect(page.locator(".feature-knowledge")).toHaveCSS("opacity", "1");
        for (const image of await page.locator(".illustration img").all()) {
          await image.scrollIntoViewIfNeeded();
          await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `test-results/welcome-${width}.png`, fullPage: true });
      }
    }
    expect(workspaceRequests).toEqual([]);
    expect(errors).toEqual([]);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`public accessibility in ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const path of publicRoutes) {
      await page.goto(path);
      await selectTheme(page, theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // Reveal all below-fold sections before checking their rendered contrast.
      for (const section of await page.locator(".public-section, .closing-cta").all()) await section.scrollIntoViewIfNeeded();
      await accessible(page);
    }
  });
}

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
  await expect(page.getByRole("status")).toContainText("Monthly rates have not been published yet.");
  await page.getByRole("button", { name: "Annual", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Annual rates and terms have not been published yet.");
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
  await page.goto("/welcome");
  await page.locator("audio").evaluate(async element => { await (element as HTMLAudioElement).play(); });
  await expect.poll(() => page.locator("audio").evaluate(element => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(0);
});

test("missing media keeps readable fallback and transcript", async ({ page }) => {
  await page.route("**/media/**", route => route.abort());
  await page.goto("/welcome");
  await expect(page.locator(".hero-background .illustration-fallback")).toBeVisible();
  await expect(page.locator("#hero-title")).toBeVisible();
  await expect(page.locator(".hero-actions").getByRole("link", { name: "Get started" })).toBeVisible();
  await page.locator("audio").evaluate(element => (element as HTMLAudioElement).load());
  await expect(page.getByRole("status")).toContainText("Audio is unavailable");
  await page.getByText("Read transcript", { exact: true }).click();
  await expect(page.locator(".sample-audio details p")).toBeVisible();
});

test("theme selection is disabled until appearance hydration is ready", async ({ browser, page }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const serverPage = await context.newPage();
    await serverPage.goto("http://127.0.0.1:3100/welcome");
    const select = serverPage.getByRole("combobox", { name: "Colour theme" });
    await expect(select).toHaveAttribute("data-appearance-ready", "false");
    await expect(select).toBeDisabled();
  } finally { await context.close(); }
  await page.addInitScript(() => localStorage.setItem("admitflow:theme", "dark"));
  await page.goto("/welcome");
  const select = page.getByRole("combobox", { name: "Colour theme" });
  await expect(select).toHaveAttribute("data-appearance-ready", "true");
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await selectTheme(page, "light");
});

test("sidebar, profile, theme persistence and keyboard search remain usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "light" });
  await page.goto("/");
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
  await page.goto("/");
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
  for (const route of ["/analytics", "/"]) {
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
