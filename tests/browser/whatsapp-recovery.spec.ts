import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";
import { uid } from "../../src/lib/domain";

test("subscription evidence separates read-only checks from deliberate reconnect", async ({ page }) => {
  const data = createWorkspace(true);
  data.demo = false;
  data.actor = { id: "user_recovery", memberId: data.members?.[0]?.id, role: "owner", name: "Owner", email: "owner@example.invalid", backend: "workos" };
  const connection = { id: uid(), service: "whatsapp" as const, status: "disconnected" as "disconnected" | "connected", externalId: "12345", label: "Recovery phone", updatedAt: new Date().toISOString(), metadata: { wabaId: "67890", subscriptionStatus: "disconnected_pending" } };
  data.connections = [connection];
  const operation = { reconciliation: "uncertain", dispatchedAt: new Date().toISOString(), confirmedAt: null, observedAt: null as string | null, appId: "321" };
  const actions: Record<string, unknown>[] = [];
  await page.route("**/api/events", route => route.abort());
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  await page.route("**/api/connections**", async route => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: new URL(route.request().url()).searchParams.get("type") === "templates" ? { templates: [] } : { operation } });
    }
    const action = route.request().postDataJSON(); actions.push(action);
    const checkOnly = action.type === "whatsapp.reconcile";
    operation.observedAt = new Date().toISOString(); operation.reconciliation = "present";
    if (!checkOnly) { connection.status = "connected"; connection.metadata.subscriptionStatus = "active"; }
    return route.fulfill({ json: { workspace: data, whatsapp: { connected: !checkOnly, message: checkOnly ? "Subscription observed; still disconnected." : "Deliberately reconnected." } } });
  });
  await page.goto("/integrations");
  const card = page.locator(".integration-card").filter({ has: page.getByRole("heading", { name: "WhatsApp Business", exact: true }) });
  await card.getByRole("button", { name: "Reconnect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Subscription evidence" })).toBeVisible();
  await expect(dialog).toContainText("A subscription dispatch was recorded and will never be repeated.");
  await expect(dialog).toContainText("Pending reconciliation · messaging disabled");
  await dialog.getByText("Already have Cloud API credentials?", { exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Phone-number ID", exact: true })).toHaveValue("12345");
  const token = dialog.getByLabel(/^Fresh access token(?:\s*\*)?$/);
  await token.fill("synthetic-browser-token");
  await dialog.getByRole("button", { name: "Check subscription only", exact: true }).click();
  await expect(token).toHaveValue("");
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ type: "whatsapp.reconcile", phoneNumberId: "12345", wabaId: "67890" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("current-state evidence, not proof of the original write");
  expect(connection.status).toBe("disconnected");
  await token.fill("synthetic-fresh-reconnect-token");
  await dialog.getByRole("button", { name: "Verify and reconnect", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(actions).toHaveLength(2);
  expect(actions[1]).toMatchObject({ service: "whatsapp", externalId: "12345", metadata: { wabaId: "67890" } });
  expect(connection.status).toBe("connected");
});
