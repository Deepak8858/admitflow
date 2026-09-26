import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { unsealData } from "iron-session";
import { expect, test, type Page } from "@playwright/test";
import type { ProvisioningStatus } from "../../src/lib/provisioning-types";

const origin = "http://127.0.0.1:3101";
const authorizationPath = "/user_management/authorize";
const setupId = "f1c3bda1-78a2-4f29-93b7-c60abfc61c21";
const organizationId = "org_account_fixture";

interface Organization {
  id: string;
  name: string;
  role?: string;
}

interface OrganizationList {
  organizations: Organization[];
  current?: string;
  name: string;
  scope: string;
  provisioning: ProvisioningStatus | null;
}

interface MockReply {
  status: number;
  body: Record<string, unknown>;
}

function list(provisioning: ProvisioningStatus | null = null, organizations: Organization[] = [], current?: string): OrganizationList {
  return { organizations, current, name: "Test Owner", scope: "fixture-scope", provisioning };
}

function status(state: ProvisioningStatus["state"], requestId: string, name = "Northstar Academy"): ProvisioningStatus {
  return {
    id: setupId,
    requestId,
    name,
    state,
    message: state === "review_required"
      ? "Setup identity changed. Ask support to review this operation."
      : state === "ready"
        ? "Your institute was created. Open it to finish signing in."
        : state === "continue"
          ? "Continue to set up your owner membership."
          : "Setup is awaiting WorkOS confirmation.",
    acknowledged: false,
    ...(state === "ready" ? { organizationId } : {}),
  };
}

async function isolateBrowserNetwork(page: Page) {
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin ? route.continue() : route.abort();
  });
  await page.route(`https://api.workos.com${authorizationPath}**`, route =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><title>Fixture authorization</title><body>Fixture authorization</body></html>",
    }),
  );
  await page.route("**/overview", route =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><title>Fixture overview</title><body>Fixture overview</body></html>",
    }),
  );
}

async function mockOrganizations(
  page: Page,
  get: () => MockReply,
  post: (body: Record<string, unknown>) => MockReply | "abort",
) {
  await page.route("**/api/organizations**", route => {
    const request = route.request();
    if (request.method() === "GET") {
      const reply = get();
      return route.fulfill({ status: reply.status, json: reply.body });
    }
    if (request.method() === "POST") {
      const reply = post(request.postDataJSON() as Record<string, unknown>);
      return reply === "abort" ? route.abort("failed") : route.fulfill({ status: reply.status, json: reply.body });
    }
    return route.abort();
  });
}

function assertNoPrivateAccountCalls(page: Page) {
  let count = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === origin && /^\/api\/(?:workspace|organizations)(?:\/|$)/.test(url.pathname)) count++;
  });
  return () => expect(count).toBe(0);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth + 1,
  )).toBe(true);
}

async function expectNoSeriousAxeViolations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(result.violations.filter(violation => violation.impact === "critical" || violation.impact === "serious").map(violation => violation.id)).toEqual([]);
}

for (const entry of [
  { path: "/signup", screenHint: "sign-up", switchName: "Log in", switchPath: "/login" },
  { path: "/login", screenHint: "sign-in", switchName: "Create an account", switchPath: "/signup" },
]) {
  test(`${entry.path} validates email, submits by keyboard, and starts the expected AuthKit flow`, async ({ page }) => {
    await isolateBrowserNetwork(page);
    const noPrivateCalls = assertNoPrivateAccountCalls(page);
    let authorizationVisits = 0;
    let actionPosts = 0;
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.hostname === "api.workos.com" && url.pathname === authorizationPath) authorizationVisits++;
      if (url.origin === origin && url.pathname === entry.path && request.method() === "POST") actionPosts++;
    });

    const response = await page.goto(entry.path);
    expect(response?.status()).toBe(200);
    const email = page.getByLabel("Email address", { exact: true });
    const submit = page.locator(".account-entry-card form button[type=submit]");
    await expect(email).toBeVisible();
    await expect(email).toHaveAttribute("type", "email");
    await expect(email).toHaveAttribute("required", "");
    await expect(email).toHaveAttribute("maxlength", "254");
    await expect(submit).toBeEnabled();
    await expect(page.getByRole("link", { name: entry.switchName })).toHaveAttribute("href", entry.switchPath);

    await submit.click();
    expect(await email.evaluate(node => (node as HTMLInputElement).validity.valueMissing)).toBe(true);
    await email.fill("not-an-email");
    await email.press("Enter");
    expect(await email.evaluate(node => (node as HTMLInputElement).validity.typeMismatch)).toBe(true);
    await expect(page).toHaveURL(`${origin}${entry.path}`);
    expect(authorizationVisits).toBe(0);
    expect(actionPosts).toBe(0);

    const loginHint = "owner@example.invalid";
    await email.fill(loginHint);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**${entry.path}`, route =>
      route.request().method() === "POST" ? gate.then(() => route.continue()) : route.continue(),
    );
    const pressed = email.press("Enter");
    try {
      await expect(submit).toBeDisabled();
      await expect(email).toBeDisabled();
      await expect(page.locator(".account-entry-card form")).toHaveAttribute("aria-busy", "true");
    } finally {
      release();
      await pressed;
    }

    await expect(page).toHaveURL(/^https:\/\/api\.workos\.com\/user_management\/authorize\?/);
    const destination = new URL(page.url());
    expect(destination.searchParams.get("screen_hint")).toBe(entry.screenHint);
    expect(destination.searchParams.get("login_hint")).toBe(loginHint);
    expect(destination.searchParams.get("client_id")).toBe("client_account_fixture");
    expect(destination.searchParams.get("redirect_uri")).toBe(`${origin}/callback`);
    expect(destination.searchParams.get("code_challenge_method")).toBe("S256");
    expect(Boolean(destination.searchParams.get("state"))).toBe(true);
    expect(Boolean(destination.searchParams.get("code_challenge"))).toBe(true);
    const pkceCookies = (await page.context().cookies(origin)).filter(cookie => /^wos-auth-verifier-[0-9a-f]{8}$/.test(cookie.name));
    expect(pkceCookies).toHaveLength(1);
    expect(pkceCookies[0].httpOnly).toBe(true);
    expect(pkceCookies[0].value === destination.searchParams.get("state")).toBe(true);
    const sealed = await unsealData<{ returnPathname?: string; codeVerifier?: string }>(pkceCookies[0].value, {
      password: "account-flow-fixture-cookie-password-not-for-production",
    });
    expect(sealed.returnPathname).toBe("/onboarding");
    expect(Boolean(sealed.codeVerifier)).toBe(true);
    expect(createHash("sha256").update(sealed.codeVerifier!).digest("base64url") === destination.searchParams.get("code_challenge")).toBe(true);
    expect(authorizationVisits).toBe(1);
    expect(actionPosts).toBe(1);
    noPrivateCalls();
  });

  test(`${entry.path} fits mobile and desktop in both themes and has no serious accessibility findings`, async ({ page }) => {
    await isolateBrowserNetwork(page);
    const noPrivateCalls = assertNoPrivateAccountCalls(page);
    expect((await page.goto(entry.path))?.status()).toBe(200);
    for (const width of [320, 375, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["light", "dark"]) {
        await page.getByRole("combobox", { name: "Colour theme" }).selectOption(theme);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expectNoHorizontalOverflow(page);
        if (width === 1440) await expectNoSeriousAxeViolations(page);
      }
    }
    noPrivateCalls();
  });
}

test("onboarding retains the create intent through pending, reload, continuation, and ready until open succeeds", async ({ page }) => {
  await isolateBrowserNetwork(page);
  let currentStatus: ProvisioningStatus | null = null;
  const posts: Record<string, unknown>[] = [];
  await mockOrganizations(
    page,
    () => ({ status: 200, body: list(currentStatus) as unknown as Record<string, unknown> }),
    body => {
      posts.push(body);
      if (body.type === "create") currentStatus = status("pending", String(body.requestId), String(body.name));
      else if (body.type === "continue" && currentStatus?.state === "continue") currentStatus = status("ready", currentStatus.requestId, currentStatus.name);
      else if (body.type === "open") return { status: 200, body: { id: organizationId } };
      return { status: currentStatus?.state === "ready" ? 200 : 202, body: { provisioning: currentStatus } };
    },
  );

  expect((await page.goto("/onboarding"))?.status()).toBe(200);
  const name = page.getByLabel("Institute name", { exact: true });
  await expect(name).toBeVisible();
  await name.fill("  Northstar Academy  ");
  await page.getByRole("button", { name: "Create institute" }).click();
  await expect(page.getByRole("button", { name: "Check setup status" })).toBeVisible();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ type: "create", name: "Northstar Academy" });
  const requestId = posts[0].requestId;
  expect(typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)).toBe(true);
  await expect(name).toBeDisabled();
  await expect(page).toHaveURL(`${origin}/onboarding`);

  await page.reload();
  await expect(page.getByRole("button", { name: "Check setup status" })).toBeVisible();
  await expect(name).toHaveValue("Northstar Academy");
  await expect(name).toBeDisabled();
  await page.getByRole("button", { name: "Check setup status" }).click();
  await expect(page.getByRole("button", { name: "Check setup status" })).toBeVisible();
  expect(posts[1]).toEqual({ type: "continue", id: setupId });
  await expect(page).toHaveURL(`${origin}/onboarding`);

  currentStatus = status("continue", String(posts[0].requestId));
  await page.getByRole("button", { name: "Refresh institutes" }).click();
  await expect(page.getByRole("button", { name: "Continue setup" })).toBeVisible();
  await page.getByRole("button", { name: "Continue setup" }).click();
  await expect(page.getByRole("button", { name: "Open institute" })).toBeVisible();
  expect(posts[2]).toEqual({ type: "continue", id: setupId });
  await expect(page).toHaveURL(`${origin}/onboarding`);

  await page.getByRole("button", { name: "Open institute" }).click();
  await expect(page).toHaveURL(`${origin}/overview`);
  expect(posts[3]).toEqual({ type: "open", id: setupId });
});

test("a lost create response retries the same request ID and original name", async ({ page }) => {
  await isolateBrowserNetwork(page);
  const posts: Record<string, unknown>[] = [];
  await mockOrganizations(
    page,
    () => ({ status: 200, body: list() as unknown as Record<string, unknown> }),
    body => {
      posts.push(body);
      return posts.length === 1 ? "abort" : { status: 202, body: { provisioning: status("pending", String(body.requestId), String(body.name)) } };
    },
  );
  await page.goto("/onboarding");
  const name = page.getByLabel("Institute name", { exact: true });
  await name.fill("  Northstar Academy  ");
  await page.getByRole("button", { name: "Create institute" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Check your connection and retry");
  await expect(name).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check setup status" })).toBeVisible();
  await page.getByRole("button", { name: "Check setup status" }).click();
  await expect(page.getByText("We’re checking your institute")).toBeVisible();
  expect(posts).toHaveLength(2);
  expect(posts[1]).toEqual(posts[0]);
  expect(posts[1].name).toBe("Northstar Academy");
  await expect(page).toHaveURL(`${origin}/onboarding`);
});

test("review required blocks continuation and shows the review message", async ({ page }) => {
  await isolateBrowserNetwork(page);
  const requestId = "d7d48917-f0d0-4b70-9145-a6ebfca44b5f";
  let postCount = 0;
  await mockOrganizations(
    page,
    () => ({ status: 200, body: list(status("review_required", requestId)) as unknown as Record<string, unknown> }),
    () => { postCount++; return { status: 500, body: {} }; },
  );
  await page.goto("/onboarding");
  await expect(page.getByText("This setup needs a review")).toBeVisible();
  await page.getByText("Details for support", { exact: true }).click();
  await expect(page.getByText("Setup identity changed. Ask support to review this operation.")).toBeVisible();
  await expect(page.getByLabel("Institute name", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Setup needs review" })).toBeDisabled();
  expect(postCount).toBe(0);
  await expect(page).toHaveURL(`${origin}/onboarding`);
});

test("existing institute switch sends only the selected known ID and navigates after a successful response", async ({ page }) => {
  await isolateBrowserNetwork(page);
  const choices = [
    { id: "org_west_fixture", name: "West Institute", role: "member" },
    { id: "org_east_fixture", name: "East Institute", role: "owner" },
  ];
  const posts: Record<string, unknown>[] = [];
  await mockOrganizations(
    page,
    () => ({ status: 200, body: list(null, choices, choices[0].id) as unknown as Record<string, unknown> }),
    body => {
      posts.push(body);
      return posts.length === 1
        ? { status: 503, body: { error: "Sign-in could not be updated." } }
        : { status: 200, body: { id: choices[1].id } };
    },
  );
  await page.goto("/onboarding");
  await page.getByRole("radio", { name: /East Institute/ }).check();
  await page.getByRole("button", { name: "Open institute" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Sign-in could not be updated.");
  await expect(page).toHaveURL(`${origin}/onboarding`);
  await page.getByRole("button", { name: "Open institute" }).click();
  await expect(page).toHaveURL(`${origin}/overview`);
  expect(posts).toEqual([
    { type: "switch", organizationId: choices[1].id },
    { type: "switch", organizationId: choices[1].id },
  ]);
});

test("401 offers sign-in and a transient list failure offers a working refresh", async ({ page }) => {
  await isolateBrowserNetwork(page);
  let getReply: MockReply = { status: 503, body: { error: "Temporary fixture outage." } };
  await mockOrganizations(page, () => getReply, () => ({ status: 500, body: {} }));
  await page.goto("/onboarding");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Temporary fixture outage.");
  getReply = { status: 200, body: list() as unknown as Record<string, unknown> };
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByLabel("Institute name", { exact: true })).toBeVisible();
  getReply = { status: 401, body: { error: "Sign in to continue." } };
  await page.getByRole("button", { name: "Refresh institutes" }).click();
  await expect(page.getByRole("link", { name: "Sign in to continue" })).toHaveAttribute("href", "/login");
  await expect(page).toHaveURL(`${origin}/onboarding`);
});

test("onboarding fits mobile and desktop in both themes and has no serious accessibility findings", async ({ page }) => {
  await isolateBrowserNetwork(page);
  await mockOrganizations(page, () => ({ status: 200, body: list() as unknown as Record<string, unknown> }), () => ({ status: 500, body: {} }));
  expect((await page.goto("/onboarding"))?.status()).toBe(200);
  await expect(page.getByLabel("Institute name", { exact: true })).toBeVisible();
  for (const width of [320, 375, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.getByRole("combobox", { name: "Colour theme" }).selectOption(theme);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expectNoHorizontalOverflow(page);
      if (width === 1440) await expectNoSeriousAxeViolations(page);
    }
  }
});
