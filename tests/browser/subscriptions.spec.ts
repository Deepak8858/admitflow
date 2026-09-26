import { test, expect, type Page } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";
import type { Workspace } from "../../src/lib/domain";

function fixture(): Workspace {
  const data = createWorkspace(true);
  data.demo = false;
  data.actor = { id: "user_subscription", memberId: data.members?.[0]?.id, role: "owner", name: "Subscription Owner", email: "owner@example.com", backend: "workos" };
  data.capabilities = { allowed: false, reason: "trial_expired", checkedAt: new Date().toISOString(), message: "Your seven-day trial has ended. Subscribe to restore paid features." };
  return data;
}
async function routes(page: Page, data: Workspace) {
  await page.route("**/api/events", route => route.abort());
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  await page.route("**/api/leads?**", route => route.fulfill({ json: { leads: data.leads, total: data.leads.length, page: 1, pageSize: 25, hasMore: false } }));
  await page.route("**/api/team", route => route.fulfill({ json: { workspace: data, members: data.members, mode: "test" } }));
  await page.route("**/api/billing**", route => route.fulfill({ status: 503, json: { error: "Offline billing fixture" } }));
  await page.route("**/api/intake", route => route.fulfill({ json: { count: 2, capped: false, needsConnection: false, message: "No automatic replies." } }));
}

test("trial expires in an open tab, fails closed on refresh outage and recovers explicitly", async ({ page }) => {
  const data = fixture();
  const now = new Date();
  // Allow navigation to settle before advancing beyond the observation window.
  data.capabilities = { allowed: true, reason: "trial", checkedAt: now.toISOString(), validUntil: new Date(+now + 300000).toISOString(), message: "Your institute's seven-day trial is active." };
  await routes(page, data);
  await page.clock.install({ time: now });
  await page.goto("/leads");
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeEnabled();
  await expect(page.getByLabel("Subscription access")).toContainText("Trial ends");
  let refreshes = 0;
  await page.route("**/api/workspace", route => { refreshes++; return route.fulfill({ status: 503, json: { error: "Offline verification" } }); });
  await page.clock.fastForward(301000);
  await expect(page.getByLabel("Subscription access")).toContainText("Restricted mode");
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeDisabled();
  await expect.poll(() => refreshes).toBe(1);
  await expect(page.getByRole("link", { name: "Manage billing" })).toHaveAttribute("href", "/settings#billing");
  data.capabilities = { allowed: true, reason: "active", checkedAt: new Date(+now + 301000).toISOString(), validUntil: new Date(+now + 601000).toISOString(), message: "Verified active subscription." };
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  await page.getByRole("button", { name: "Refresh access", exact: true }).click();
  await expect(page.getByLabel("Subscription access")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeEnabled();
});

test("repeated capability snapshots cannot postpone an open tab's expiry", async ({ page }) => {
  const data = fixture(), now = new Date();
  data.capabilities = { allowed: true, reason: "trial", checkedAt: now.toISOString(), validUntil: new Date(+now + 60000).toISOString(), message: "Trial active." };
  await routes(page, data); await page.clock.install({ time: now });
  await page.goto("/leads");
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeEnabled();
  await page.clock.fastForward(40000);
  const refresh = page.getByRole("button", { name: "Refresh access", exact: true });
  const refreshed = page.waitForResponse("**/api/workspace");
  await refresh.click();
  await refreshed;
  await expect(refresh).toBeEnabled();
  await page.clock.fastForward(21000);
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeDisabled();
  await expect(page.getByLabel("Subscription access")).toContainText("Restricted mode");
  const replayed = page.waitForResponse("**/api/workspace");
  await refresh.click();
  await replayed;
  await expect(refresh).toBeEnabled();
  await expect(page.getByRole("button", { name: "Add enquiry", exact: true }).first()).toBeDisabled();
});

test("restricted UI blocks paid controls but retains drafts, notes, pauses and existing records", async ({ page }) => {
  const data = fixture(); await routes(page, data);
  await page.goto("/leads");
  await expect(page.getByRole("button", { name: "Import CSV" })).toBeDisabled();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search pages and students" }).fill("add enquiry");
  await expect(page.getByRole("option", { name: /Add an enquiry/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/automations");
  await expect(page.getByRole("radio", { name: "Autonomous", exact: true })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "Paused", exact: true })).toBeEnabled();
  await page.locator("label.mode-option").filter({ has: page.getByRole("radio", { name: "Paused", exact: true }) }).click();
  await expect(page.getByRole("radio", { name: "Paused", exact: true })).toBeChecked();
  await expect(page.getByRole("button", { name: "Save assistant settings" })).toBeEnabled();
  await page.goto("/team");
  await expect(page.getByRole("button", { name: "Invite teammate" })).toBeDisabled();
  await page.goto("/inbox");
  await expect(page.getByRole("button", { name: "Suggest reply" })).toBeDisabled();
  await page.getByLabel("Message reply", { exact: true }).fill("A retained draft");
  await expect(page.getByRole("button", { name: "Save draft", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Internal note", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add note", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Full enquiry details" })).toBeEnabled();
});

test("billing refresh restores access and deferred intake requires one click per batch", async ({ page }) => {
  const data = fixture(); await routes(page, data);
  let imports = 0;
  await page.route("**/api/intake", async route => {
    if (route.request().method() === "POST") {
      imports++;
      expect(route.request().postDataJSON()).toEqual(imports === 1 ? { type: "import" } : { type: "import", after: "a".repeat(64) });
      return route.fulfill({ json: { workspace: data, result: { imported: 25, blocked: 0, hasMore: true, after: "a".repeat(64) } } });
    }
    return route.fulfill({ json: { count: 52 - imports * 25, capped: false, needsConnection: false, message: "No automatic replies." } });
  });
  await page.goto("/settings#billing");
  await expect(page.getByRole("button", { name: "Import up to 25 events" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh billing", exact: true })).toBeEnabled();
  data.capabilities = { allowed: true, reason: "active", checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 300000).toISOString(), message: "Verified active subscription." };
  await page.getByRole("button", { name: "Refresh billing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import up to 25 events" })).toBeEnabled();
  expect(imports).toBe(0);
  await page.getByRole("button", { name: "Import up to 25 events" }).click();
  await expect(page.getByRole("button", { name: "Import next batch" })).toBeEnabled();
  expect(imports).toBe(1);
  await page.getByRole("button", { name: "Import next batch" }).click();
  await expect.poll(() => imports).toBe(2);
});

test("restricted non-admin gets contact guidance, not billing or intake privileges", async ({ page }) => {
  const data = fixture(); data.actor!.role = "analyst"; await routes(page, data);
  await page.goto("/settings");
  await expect(page.getByLabel("Subscription access")).toContainText("Contact your institute owner or administrator");
  await expect(page.getByRole("link", { name: "Manage billing" })).toHaveCount(0);
  await expect(page.getByLabel("Deferred enquiries")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh billing", exact: true })).toHaveCount(0);
});

test("ordinary workspace conflicts stay in place and only missing organization redirects", async ({ page }) => {
  await page.route("**/api/workspace", route => route.fulfill({ status: 409, json: { code: "TEAM_ACCESS_PENDING", error: "Access update is awaiting confirmation." } }));
  await page.goto("/leads");
  await expect(page.getByText("Access update is awaiting confirmation.")).toBeVisible();
  await expect(page).toHaveURL(/\/leads$/);
  await page.route("**/onboarding", route => route.fulfill({ contentType: "text/html", body: "<h1>Organization setup</h1>" }));
  await page.route("**/api/workspace", route => route.fulfill({ status: 409, json: { code: "ORGANIZATION_REQUIRED", error: "Choose an institute." } }));
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
});
