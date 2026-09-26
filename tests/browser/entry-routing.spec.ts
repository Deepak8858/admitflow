import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createWorkspace } from "../../src/lib/seed";

test("the domain opens the existing landing page without creating a workspace session", async ({ page }) => {
  const workspaceRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/workspace") workspaceRequests.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your admissions pipeline. One connected workspace." })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Colour theme" })).toHaveAttribute("data-appearance-ready", "true");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(workspaceRequests).toEqual([]);
  expect((await page.context().cookies()).some(cookie => cookie.name === "admitflow_session")).toBe(false);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
  await page.locator(".public-nav").getByRole("link", { name: "Product", exact: true }).click();
  await expect(page).toHaveURL(/\/product$/);
  await page.locator(".public-nav").getByRole("link", { name: "AdmitFlow home", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("overview and every sidebar link stay inside the workspace", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.locator("#main-content h1")).toBeVisible();
  await expect(page).toHaveTitle("Overview — AdmitFlow");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  await page.getByRole("link", { name: "AdmitFlow overview" }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await page.locator('.sidebar nav a[href="/leads"]').click();
  await expect(page.locator("#main-content h1")).toBeVisible();
  await expect(page).toHaveTitle("Enquiries — AdmitFlow");
  await page.locator('.sidebar nav a[href="/overview"]').click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator(".marketing-site")).toHaveCount(0);
});

test("unknown routes and failed sign-in show recovery pages without loading a workspace", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/workspace") calls.push(request.url()); });
  for (const route of ["/missing-page", "/leads/missing-page", "/__proto__"]) {
    const response = await page.goto(route);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "This page isn’t here." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  }
  await page.goto("/auth/error");
  await expect(page.getByRole("heading", { name: "Let’s get you signed in." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Try signing in again" })).toHaveAttribute("href", "/login");
  expect(calls).toEqual([]);
});

test("a workspace gateway failure provides a readable retry and recovers", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/workspace", route => ++attempts === 1
    ? route.fulfill({ status: 502, contentType: "text/html", body: "<html>Gateway unavailable</html>" })
    : route.fulfill({ json: createWorkspace(true) }));
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "Let’s get you into your workspace" })).toBeVisible();
  await expect(page.getByText("Your workspace could not load. Please retry.")).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.locator("#main-content h1")).toBeVisible();
  expect(attempts).toBe(2);
});

test("HTML unauthorized responses still send visitors to sign-in", async ({ page }) => {
  await page.route("**/api/workspace", route => route.fulfill({ status: 401, contentType: "text/html", body: "<html>Unauthorized</html>" }));
  await page.route("**/login", route => route.fulfill({ contentType: "text/html", body: "<h1>Sign-in destination</h1>" }));
  await page.goto("/overview");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign-in destination" })).toBeVisible();
});

test("mobile visitors can navigate the public pages and getting-started guide", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Public navigation" });
  await expect(navigation).toBeHidden();
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close menu", exact: true })).toHaveAttribute("aria-expanded", "true");
  await navigation.getByRole("link", { name: "Help", exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.locator(".help-guide li")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("landing actions keep readable text while hovered in both themes", async ({ page }) => {
  await page.goto("/");
  const theme = page.getByRole("combobox", { name: "Colour theme" });
  await expect(theme).toHaveAttribute("data-appearance-ready", "true");
  for (const value of ["light", "dark"]) {
    await theme.selectOption(value);
    for (const selector of [".hero-actions .primary", ".hero-actions .secondary", ".public-nav .primary"]) {
      await page.locator(selector).hover();
      const result = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze();
      expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.failureSummary) }))).toEqual([]);
    }
  }
});
