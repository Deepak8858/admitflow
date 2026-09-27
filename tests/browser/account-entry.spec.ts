import { test, expect } from "@playwright/test";

test("public account pages render without workspace access and keep unconfigured signup distinct from a local account", async ({ page }) => {
  const privateRequests: string[] = [];
  page.on("request", request => {
    if (/\/api\/(workspace|organizations|auth)(\?|$)/.test(request.url())) privateRequests.push(request.url());
  });
  for (const route of ["/signup", "/login"]) {
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /Continue with email/ })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await expect(page.getByRole("link", { name: /AdmitFlow home/ })).toHaveAttribute("href", "/");
    }
  }
  expect(privateRequests).toEqual([]);
  await expect(page.getByRole("link", { name: /Create.*account|Sign up/i }).first()).toHaveAttribute("href", "/signup");
});
