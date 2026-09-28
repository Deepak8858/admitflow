import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";
import { type Connection, uid } from "../../src/lib/domain";
import { publicConnection } from "../../src/lib/permissions";

test("uncertain Google disconnect refreshes the disabled state and requires explicit recovery", async ({ page }) => {
  const data = createWorkspace(true);
  data.demo = false;
  data.actor = { id: "user_google_recovery", memberId: data.members?.[0]?.id, role: "owner", name: "Owner", email: "owner@example.invalid", backend: "workos" };
  const connection: Connection = { id: uid(), service: "google", status: "connected", externalId: "synthetic-google-subject", label: "Shared calendar", updatedAt: new Date().toISOString(), metadata: { calendarId: "primary" }, secret: "synthetic-sealed-value" };
  const projection = () => ({ ...data, connections: [publicConnection(connection)] });
  await page.route("**/api/events", route => route.abort());
  await page.route("**/api/workspace", route => route.fulfill({ json: projection() }));
  let attempts = 0;
  await page.route("**/api/connections", async route => {
    expect(route.request().postDataJSON()).toEqual({ type: "disconnect", service: "google" });
    attempts++;
    if (attempts === 1) {
      connection.status = "error";
      connection.metadata.googleRevocation = "uncertain";
      return route.fulfill({ status: 503, json: { error: "Google could not confirm calendar revocation. The connection is disabled; retry disconnecting before reconnecting." } });
    }
    connection.status = "disconnected";
    connection.metadata = {};
    delete connection.secret;
    return route.fulfill({ json: { workspace: projection() } });
  });
  await page.goto("/integrations");
  const card = page.locator(".integration-card").filter({ has: page.getByRole("heading", { name: "Google Calendar", exact: true }) });
  await expect(card).toContainText("Configured");
  await card.getByRole("button", { name: "Disconnect Google Calendar", exact: true }).click();
  await expect(card).toContainText("Needs attention");
  await expect(card).toContainText("Calendar updates are disabled. Finish disconnecting before reconnecting Google.");
  expect(attempts).toBe(1);
  expect(publicConnection(connection).secret).toBeUndefined();
  await card.getByRole("button", { name: "Manage connection", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("link", { name: "Continue with Google" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Retry disconnect", exact: true }).click();
  await expect(card).toContainText("Disconnected");
  await expect(dialog.getByRole("link", { name: "Continue with Google" })).toHaveAttribute("href", "/api/integrations/google/start");
  expect(attempts).toBe(2);
});
