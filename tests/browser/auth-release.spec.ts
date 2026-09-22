import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";

const origin = "http://127.0.0.1:3100";

test("GET and HEAD logout cannot terminate a session; local settings still logs out by POST", async ({ page }) => {
  const response = await page.request.post("/api/auth", {
    headers: { origin },
    data: { type: "register", name: "Logout Owner", institute: "Logout Fixture", email: `logout-${crypto.randomUUID()}@example.invalid`, password: "Synthetic-test-password-123" },
  });
  expect(response.status()).toBe(200);
  const registered = await response.json();
  expect(registered.demo).toBe(false);
  const cookie = (await page.context().cookies()).find(item => item.name === "admitflow_session");
  expect(Boolean(cookie)).toBe(true);
  for (const method of ["GET", "HEAD"]) {
    const rejected = await page.request.fetch("/logout", { method, maxRedirects: 0, headers: { "sec-fetch-site": "cross-site" } });
    expect(rejected.status()).toBe(404);
    expect(rejected.headers()["set-cookie"]).toBeUndefined();
    const current = await (await page.request.get("/api/workspace")).json();
    expect(current.id).toBe(registered.id);
    expect(current.demo).toBe(false);
    expect((await page.context().cookies()).find(item => item.name === "admitflow_session")?.value === cookie?.value).toBe(true);
  }
  await page.goto("/settings");
  const logout = page.waitForResponse(result => result.url().endsWith("/api/auth") && result.request().method() === "POST");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const completed = await logout;
  expect(completed.request().postDataJSON()).toEqual({ type: "logout" });
  expect(completed.status()).toBe(200);
  expect((await completed.json()).demo).toBe(true);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  const oldSession = await page.request.get("/api/workspace", { headers: { cookie: `admitflow_session=${cookie!.value}` } });
  const current = await oldSession.json();
  expect(current.id).not.toBe(registered.id);
  expect(current.demo).toBe(true);
});

test("hosted settings submits a server-action POST and Next rejects cross-origin action requests", async ({ page }) => {
  // Only the client workspace is mocked; no hosted credentials or provider requests are used.
  const data = createWorkspace(true);
  data.demo = false;
  data.actor = { id: "user_logout_fixture", memberId: data.members?.[0]?.id, role: "owner", name: "Owner", email: "owner@example.invalid", backend: "workos" };
  await page.route("**/api/events", route => route.abort());
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  await page.goto("/settings");
  const button = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(button).toHaveAttribute("type", "submit");
  await expect(page.locator("form").filter({ has: button })).toHaveCount(1);
  const posted = page.waitForRequest(request => new URL(request.url()).pathname === "/settings" && request.method() === "POST");
  // Stop the UI request; replay the real action ID below against the credential-free server.
  await page.route("**/settings", route => route.request().method() === "POST" ? route.abort() : route.continue());
  await button.click();
  const request = await posted;
  const actionId = request.headers()["next-action"];
  expect(actionId).toBeTruthy();
  const headers = { "next-action": actionId!, "content-type": request.headers()["content-type"]! };
  const crossOrigin = await page.request.post("/settings", { headers: { ...headers, origin: "https://foreign.invalid" }, data: request.postData()!, maxRedirects: 0 });
  expect(crossOrigin.status()).toBe(500);
  expect(await crossOrigin.text()).toContain("Invalid Server Actions request");
  expect(crossOrigin.headers()["set-cookie"]).toBeUndefined();
  // Matching origin reaches our action and fails closed because hosted auth is not configured.
  const sameOrigin = await page.request.post("/settings", { headers: { ...headers, origin }, data: request.postData()!, maxRedirects: 0 });
  expect(sameOrigin.status()).toBe(500);
  expect(await sameOrigin.text()).toContain("Hosted sign-out is not configured.");
  expect(sameOrigin.headers()["set-cookie"]).toBeUndefined();
});
