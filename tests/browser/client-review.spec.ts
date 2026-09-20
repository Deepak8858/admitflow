import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";

test("connection gateway errors retain a useful fallback and allow retry", async ({ page }) => {
  const data = createWorkspace(true);
  data.demo = false;
  data.actor = { id: "user_gateway", memberId: data.members?.[0]?.id, role: "owner", name: "Owner", email: "owner@example.invalid", backend: "workos" };
  data.connections = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/events", route => route.abort());
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  let attempts = 0;
  await page.route("**/api/connections", route => {
    attempts++;
    return attempts === 1
      ? route.fulfill({ status: 502, contentType: "text/html", body: "<html>Upstream unavailable</html>" })
      : route.fulfill({ json: { workspace: data } });
  });
  await page.goto("/integrations");
  const card = page.locator(".integration-card").filter({ has: page.getByRole("heading", { name: "OpenAI", exact: true }) });
  await card.getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("API key").fill("synthetic-browser-only-key");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("The account could not be verified.");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save connection", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(attempts).toBe(2);
  expect(errors).toEqual([]);
});

test("admission ignores same-tick duplicate submits and unlocks after failure", async ({ page }) => {
  const data = createWorkspace(true);
  await page.route("**/api/events", route => route.abort());
  let attempts = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/workspace", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: data });
    const action = route.request().postDataJSON();
    expect(action.type).toBe("revenue.record");
    attempts++;
    if (attempts === 1) {
      await blocked;
      return route.fulfill({ status: 503, json: { error: "Synthetic temporary admission failure" } });
    }
    return route.fulfill({ json: { workspace: data, result: { recorded: true } } });
  });
  await page.goto("/inbox");
  await page.getByRole("button", { name: "Full enquiry details", exact: true }).click();
  await page.getByRole("button", { name: "Record admission", exact: true }).click();
  const admission = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "An enquiry becomes an admission.", exact: true }) });
  await admission.getByLabel("Payment received (₹)").fill("1000");
  await admission.getByLabel("Receipt or transaction reference").fill("BROWSER-DUPLICATE-1");
  try {
    await admission.locator("form").evaluate(form => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => attempts).toBe(1);
    await expect(admission.getByRole("button", { name: "Record admission", exact: true })).toBeDisabled();
  } finally { release(); }
  await expect(admission.getByRole("alert")).toContainText("Synthetic temporary admission failure");
  await expect(admission.getByRole("button", { name: "Record admission", exact: true })).toBeEnabled();
  expect(attempts).toBe(1);
  await admission.getByRole("button", { name: "Record admission", exact: true }).click();
  await expect(admission).toHaveCount(0);
  expect(attempts).toBe(2);
});
