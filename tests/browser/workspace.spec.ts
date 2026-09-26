import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { DatabaseSync } from "node:sqlite";
import type { Workspace, Lead } from "../../src/lib/domain";

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect.soft(pageErrors.get(page) || [], "uncaught browser errors").toEqual([]);
});

async function workspace(page: Page): Promise<Workspace> {
  const response = await page.request.get("/api/workspace");
  expect(response.ok()).toBe(true);
  return response.json();
}
async function openPage(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("#main-content h1")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  if (path === "/leads") await expect(page.locator(".leads-panel")).toHaveAttribute("aria-busy", "false");
}
async function expectNoPageOverflow(page: Page) {
  const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, path: location.pathname }));
  expect(size.width, `horizontal overflow on ${size.path} at ${size.viewport}px`).toBeLessThanOrEqual(size.viewport);
}
async function simulateIncoming(page: Page, body: string, echo = false): Promise<Workspace> {
  await page.getByRole("button", { name: "Try an incoming message" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Student message").fill(body);
  await dialog.getByRole("checkbox", { name: "Simulate a counsellor reply from the Business app" }).setChecked(echo);
  const response = page.waitForResponse(result => result.url().endsWith("/api/workspace") && result.request().method() === "POST" && result.request().postDataJSON().type === "message.simulate");
  await dialog.getByRole("button", { name: "Simulate message", exact: true }).click();
  const completed = await response;
  expect(completed.ok()).toBe(true);
  const result = await completed.json();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return result.workspace;
}

test("CSV → recovery → inbox → counselling → admission is persistent", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: /Your next chapter,/ })).toBeVisible();
  await page.screenshot({ path: "test-results/overview-1440.png", fullPage: true });
  await page.getByRole("button", { name: "Import enquiries", exact: true }).click();
  await page.getByLabel("Upload enquiry CSV").setInputFiles({ name: "pilot-leads.csv", mimeType: "text/csv", buffer: Buffer.from('name,phone,email,course,source,value,createdAt,consent,consentSource,notes\nPilot Student,+917001110001,pilot@example.com,NEET 2027,Website,65000,2026-01-01,opted_in,Enquiry form,"Asked about fees, weekend batch"\nDuplicate Student,7001110001,,NEET 2027,,,,,,\nInvalid Student,abc,,,,,,,,') });
  await page.getByRole("button", { name: "Review import" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Import enquiries", exact: true }).click();
  await expect(page.getByRole("heading", { name: "1 enquiries imported" })).toBeVisible();
  await expect(page.getByText("1 duplicates skipped · 1 rows need attention")).toBeVisible();
  await page.getByRole("button", { name: "View enquiries" }).click();
  await page.getByLabel("Search enquiries").fill("Pilot Student");
  await expect(page.getByRole("button", { name: /Pilot Student/ }).first()).toBeVisible();
  await page.locator('nav a[href="/recovery"]').click();
  await page.getByLabel("Select Pilot Student for recovery").check();
  await page.getByRole("button", { name: "Create recovery campaign" }).click();
  await page.getByLabel("Campaign name").fill("Pilot recovery");
  await expect(page.getByRole("button", { name: "Schedule demo campaign" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to message" }).click();
  await expect(page.getByRole("heading", { name: "Shape the next conversation" })).toBeFocused();
  await page.getByRole("button", { name: "Review campaign", exact: true }).click();
  await expect(page.getByRole("button", { name: "Schedule demo campaign" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed this simulated campaign/ }).check();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Review campaign", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /I reviewed this simulated campaign/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I reviewed this simulated campaign/ }).check();
  await page.getByRole("button", { name: "Schedule demo campaign" }).click();
  await expect(page.getByRole("heading", { name: "Pilot recovery", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run due jobs" }).click();
  await expect(page.getByRole("status")).toContainText("1 due follow-ups processed in demo mode");
  await page.locator('nav a[href="/inbox"]').click();
  await page.getByLabel("Search conversations").fill("Pilot Student");
  await page.locator(".conversation-row").filter({ hasText: "Pilot Student" }).click();
  await expect(page.locator(".message-thread")).toContainText("Demo · not delivered");
  await page.getByRole("button", { name: "Suggest reply" }).click();
  await expect(page.getByLabel("Message reply")).not.toHaveValue("");
  await page.getByLabel("Message reply").fill("Hi Pilot, would tomorrow suit you for counselling?");
  await page.getByRole("button", { name: "Send demo" }).click();
  await expect(page.locator(".message-thread")).toContainText("Hi Pilot, would tomorrow suit you for counselling?");
  await page.getByRole("button", { name: "Book counselling", exact: true }).click();
  await page.getByRole("button", { name: "Book session", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Full enquiry details" }).click();
  await expect(page.getByLabel("Pipeline stage")).toHaveValue("Counselling");
  await page.getByRole("button", { name: "Record admission", exact: true }).click();
  await page.getByLabel("Payment received (₹)").fill("12345");
  await page.getByLabel("Receipt or transaction reference").fill("PILOT-1001");
  await page.getByRole("button", { name: "Record admission", exact: true }).click();
  await expect(page.getByLabel("Pipeline stage")).toHaveValue("Admitted");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.locator('nav a[href="/analytics"]').click();
  await expect(page.getByRole("cell", { name: "PILOT-1001", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("cell", { name: "PILOT-1001", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("recovery chart data switches between exact collections and distinct paid students", async ({ page }) => {
  const state = await workspace(page);
  const [first, second] = state.leads;
  await page.clock.setFixedTime(new Date("2026-09-16T12:00:00+05:30"));
  const projected: Workspace = {
    ...state,
    revenue: [
      { id: "receipt-1", leadId: first.id, amount: 1250.5, recordedAt: "2026-09-14T10:00:00+05:30", campaignId: "campaign-1", reference: "REPORT-1" },
      { id: "receipt-2", leadId: first.id, amount: 749.75, recordedAt: "2026-09-15T10:00:00+05:30", campaignId: "campaign-2", reference: "REPORT-2" },
      { id: "receipt-3", leadId: second.id, amount: 200.2, recordedAt: "2026-09-16T10:00:00+05:30", campaignId: "campaign-2", reference: "REPORT-3" },
    ],
    refunds: [{ id: "refund-1", revenueId: "receipt-1", amount: 50.05, recordedAt: "2026-09-15T11:00:00+05:30", reference: "REFUND-1" }],
  };
  await page.route("**/api/workspace", route => route.fulfill({ json: projected }));
  await openPage(page, "/overview");
  await page.getByLabel("Report period").selectOption("7");
  await page.getByText("View chart data", { exact: true }).click();
  const revenue = page.getByRole("table", { name: "Recovery revenue by day" });
  await expect(revenue.locator("tbody tr").last().locator("td").nth(2)).toHaveText("₹2,150.40");
  await expect(page.locator(".chart-overview strong")).toHaveText("₹2,150.40");
  await page.getByRole("button", { name: "Admissions", exact: true }).click();
  const admissions = page.getByRole("table", { name: "Recovery admissions by day" });
  await expect(admissions.getByRole("columnheader")).toHaveText(["Date", "New paid students", "Cumulative paid students"]);
  await expect(admissions.locator("tbody tr td:nth-child(2)")).toHaveText(["0", "0", "0", "0", "1", "0", "1"]);
  await expect(admissions.locator("tbody tr td:nth-child(3)")).toHaveText(["0", "0", "0", "0", "1", "1", "2"]);
  await expect(admissions).not.toContainText("₹");
  await expect(page.locator(".chart-overview strong")).toHaveText("2");
  await page.getByRole("button", { name: "Revenue", exact: true }).click();
  await expect(revenue.locator("tbody tr").last().locator("td").nth(2)).toHaveText("₹2,150.40");
});

test("keyboard command search, empty states, and workspace configuration", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: /Your next chapter,/ })).toBeVisible();
  const trigger = page.getByRole("button", { name: "Search workspace", exact: true });
  await trigger.focus();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("combobox", { name: "Search pages and students" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search pages and students" }).fill("Knowledge");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/knowledge/);
  await page.getByRole("button", { name: "Add knowledge", exact: true }).click();
  await page.getByLabel("Source title").fill("Pilot refund policy");
  await page.getByLabel("Approved institute information").fill("Refund requests are reviewed by the institute owner within five working days.");
  await page.getByRole("button", { name: "Save knowledge" }).click();
  await expect(page.getByRole("heading", { name: "Pilot refund policy" })).toBeVisible();
  await page.locator('nav a[href="/leads"]').click();
  await page.getByLabel("Search enquiries").fill("no matching student at all");
  await expect(page.getByRole("heading", { name: "No enquiries in this view" })).toBeVisible();
  await page.locator('nav a[href="/automations"]').click();
  await page.getByRole("button", { name: "Recovery playbook", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Recovery sequences" })).toBeChecked();
  await page.getByRole("switch", { name: "Recovery sequences" }).click();
  await expect(page.getByRole("switch", { name: "Recovery sequences" })).not.toBeChecked();
  await page.reload();
  await page.getByRole("button", { name: "Recovery playbook", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Recovery sequences" })).not.toBeChecked();
});

test("server scopes IDs to sessions and rejects unauthenticated and cross-origin mutations", async ({ request, playwright }) => {
  const unauthenticated = await request.post("/api/workspace", { data: { type: "jobs.run" } });
  expect(unauthenticated.status()).toBe(401);
  const first = await (await request.get("/api/workspace")).json();
  const other = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3100" });
  const second = await (await other.get("/api/workspace")).json();
  expect(first.id).not.toBe(second.id);
  const foreign = await other.post("/api/workspace", { data: { type: "lead.update", id: first.leads[0].id, changes: { stage: "Lost" } } });
  expect(foreign.status()).toBe(404);
  expect((await foreign.json()).error).toBe("Enquiry not found in your workspace.");
  const crossOrigin = await request.post("/api/workspace", { headers: { origin: "https://unrelated.example" }, data: { type: "jobs.run" } });
  expect(crossOrigin.status()).toBe(403);
  expect((await request.post("/api/jobs", { timeout: 45000 })).status()).toBe(401);
  expect((await request.post("/api/webhooks/whatsapp", { form: { Body: "forged", AccountSid: "fake" } })).status()).toBe(403);
  await other.dispose();
});

test("account registration starts an empty workspace and sign-in restores its data", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  const email = `pilot-${Date.now()}@example.com`;
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Your name", exact: true }).fill("Pilot Owner");
  await dialog.getByRole("textbox", { name: "Institute name", exact: true }).fill("Pilot Academy");
  await dialog.getByRole("textbox", { name: "Email address", exact: true }).fill(email);
  await dialog.getByLabel("Password").fill("Test-Password-123");
  await dialog.getByRole("button", { name: "Create workspace", exact: true }).click();
  await expect(page.getByText("Institute workspace", { exact: true }).first()).toBeVisible();
  await page.locator('nav a[href="/leads"]').click();
  await expect(page.getByRole("heading", { name: "No enquiries in this view" })).toBeVisible();
  await page.locator('nav a[href="/settings"]').click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Email address").fill(email);
  await page.getByRole("dialog").getByLabel("Password").fill("Test-Password-123");
  await page.getByRole("dialog").getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Institute name", exact: true })).toHaveValue("Pilot Academy");
});

for (const width of [320, 375, 414, 768]) {
  test(`responsive workspace at ${width}px with reduced motion`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const route of ["/overview", "/leads", "/recovery", "/pipeline", "/inbox", "/appointments", "/analytics", "/knowledge", "/automations", "/team", "/integrations", "/settings"]) {
      await openPage(page, route);
      await expectNoPageOverflow(page);
      const location = await page.locator(".topbar-location").boundingBox();
      const tools = await page.locator(".topbar-tools").boundingBox();
      expect(location && tools && (location.x + location.width <= tools.x || location.y + location.height <= tools.y)).toBe(true);
      if (width === 375 && route === "/overview") await page.screenshot({ path: "test-results/overview-375.png", fullPage: true });
      if (route === "/leads") {
        await page.locator(".data-table-wrap").evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await expect(page.locator(".enquiries-table .row-open").first()).toBeInViewport();
        await expectNoPageOverflow(page);
      }
      if (route === "/pipeline") {
        await page.locator(".pipeline-board").evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await expect(page.getByRole("heading", { name: "Lost", exact: true })).toBeInViewport();
        await expectNoPageOverflow(page);
      }
      if (route === "/inbox") {
        await page.locator(".conversation-row").first().click();
        await expect(page.locator(".message-thread")).toBeVisible();
        await expect(page.getByLabel("Message reply", { exact: true })).toBeVisible();
        await expect(page.locator(".message-thread .message-bubble").last()).toBeInViewport({ ratio: 1 });
        await expectNoPageOverflow(page);
        if (width === 320 || width === 375) await page.screenshot({ path: `test-results/inbox-${width}.png`, fullPage: true });
        await page.getByRole("button", { name: "Back to conversations" }).click();
        await expect(page.getByLabel("Search conversations")).toBeVisible();
      }
    }
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("link", { name: /Enquiries/ }).click();
    await expect(page).toHaveURL(/leads/);
    await page.getByRole("button", { name: "Add enquiry", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel("Student name")).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
}

test("overview, enquiry form and inbox pass automated accessibility checks", async ({ page }) => {
  await openPage(page, "/overview");
  await expect(page.getByRole("heading", { name: /Your next chapter,/ })).toBeVisible();
  const overview = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(overview.violations).toEqual([]);
  await openPage(page, "/leads");
  await page.screenshot({ path: "test-results/enquiries-1440.png", fullPage: true });
  const add = page.getByRole("button", { name: "Add enquiry", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Student name")).toBeFocused();
  await dialog.getByRole("button", { name: "Add enquiry", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Add enquiry", exact: true })).toBeFocused();
  const form = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(form.violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await openPage(page, "/inbox");
  await expect(page.getByLabel("Message reply", { exact: true })).toBeVisible();
  const inbox = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(inbox.violations).toEqual([]);
  await page.screenshot({ path: "test-results/inbox-1440.png", fullPage: true });
});

test("demo autonomy answers from knowledge and Business-app takeover stops AI", async ({ page }) => {
  await openPage(page, "/leads");
  const initial = await workspace(page);
  const owner = initial.members!.find(member => member.status === "active" && member.role === "counsellor")!;
  await page.getByRole("button", { name: "Add enquiry", exact: true }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Student name").fill("Autonomy Student");
  await form.getByLabel("Phone number").fill("+917001110099");
  await form.getByLabel("Course of interest").fill("NEET 2027");
  await form.getByLabel("Assigned counsellor").selectOption(owner.id);
  await form.getByLabel("WhatsApp contact preference").selectOption("opted_in");
  await form.getByLabel("Opt-in source").fill("Demo enquiry form");
  await form.getByRole("button", { name: "Add enquiry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Autonomy Student", exact: true })).toBeVisible();
  const lead = (await workspace(page)).leads.find(item => item.name === "Autonomy Student")!;
  expect(lead.ownerId).toBe(owner.id);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.locator(".thread-context")).toContainText("Your assistant is handling");
  const answered = await simulateIncoming(page, "What are the NEET course fees?");
  const replies = answered.messages.filter(message => message.leadId === lead.id && message.author === "AdmitFlow AI");
  expect(replies).toHaveLength(1);
  expect(replies[0]).toMatchObject({ direction: "outbound", status: "demo" });
  expect(replies[0].providerId).toBeUndefined();
  expect(replies[0].body).toContain("NEET");
  expect(answered.articles.some(article => replies[0].body.includes(article.body.slice(0, 80)))).toBe(true);
  await expect(page.locator(".message-thread")).toContainText("Demo · not delivered");
  const takeover = await simulateIncoming(page, "I’m your counsellor. I’ll help with your next step.", true);
  expect(takeover.leads.find(item => item.id === lead.id)?.humanOwned).toBe(true);
  expect(takeover.connections?.some(connection => connection.metadata.coexistence === "verified")).toBe(false);
  await expect(page.locator(".thread-context")).toContainText(`With ${owner.name}`);
  await expect(page.getByRole("button", { name: "Enable AI", exact: true })).toBeVisible();
  const after = await simulateIncoming(page, "Thanks. Can the counsellor confirm the NEET fees?");
  expect(after.messages.filter(message => message.leadId === lead.id && message.author === "AdmitFlow AI")).toHaveLength(1);
  expect(after.messages.some(message => message.leadId === lead.id && message.direction === "inbound" && message.body.startsWith("Thanks."))).toBe(true);
});

test("an uncertain inbox request keeps its payload and UUID after reload and retry", async ({ page }) => {
  const initial = await workspace(page);
  const lead = initial.leads.find(item => item.consent === "opted_in" && !["Admitted", "Lost"].includes(item.stage) && (!item.isMinor || item.guardianConsent))!;
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/workspace", async route => {
    const request = route.request();
    if (request.method() === "POST" && request.postDataJSON().type === "message.send") {
      requests.push(request.postDataJSON());
      if (requests.length === 1) { await route.abort("failed"); return; }
    }
    await route.continue();
  });
  await openPage(page, `/inbox?conversation=${lead.id}`);
  const text = "Please confirm tomorrow’s counselling time — request identity check.";
  await page.getByLabel("Message reply", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send demo", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry same request" })).toBeVisible();
  await expect(page.getByLabel("Message reply", { exact: true })).toHaveAttribute("readonly", "");
  await page.reload();
  await expect(page.getByLabel("Message reply", { exact: true })).toHaveValue(text);
  await page.getByRole("button", { name: "Retry same request" }).click();
  await expect(page.locator(".message-bubble p").filter({ hasText: text })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Retry same request" })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/i);
  const sent = (await workspace(page)).messages.filter(message => message.body === text);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id: requests[0].requestId, leadId: lead.id, status: "demo" });
});

test("enquiry pagination, stable bulk owners and saved views use the server contract", async ({ page }) => {
  await openPage(page, "/leads");
  const initial = await workspace(page);
  const firstPage = await (await page.request.get("/api/leads?page=1&pageSize=25&sort=intent&view=all")).json() as { leads: Lead[]; total: number };
  const chosen = firstPage.leads.slice(0, 2);
  const owner = initial.members!.find(member => member.status === "active" && member.role === "counsellor" && member.id !== chosen[0].ownerId)!;
  await expect(page.locator(".enquiries-table tbody tr")).toHaveCount(25);
  for (const lead of chosen) await page.getByRole("checkbox", { name: `Select ${lead.name}`, exact: true }).check();
  await page.getByLabel("Bulk assign counsellor").selectOption(owner.id);
  const assignment = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.request().method() === "POST" && response.request().postDataJSON().type === "lead.bulk");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const assigned = await assignment;
  expect(assigned.ok()).toBe(true);
  expect(assigned.request().postDataJSON()).toMatchObject({ ownerId: owner.id, ids: chosen.map(lead => lead.id) });
  expect(assigned.request().postDataJSON()).not.toHaveProperty("owner");
  const state = await workspace(page);
  for (const lead of chosen) expect(state.leads.find(item => item.id === lead.id)?.ownerId).toBe(owner.id);
  await expect(page.locator(".bulk-toolbar")).toHaveCount(0);
  await page.getByRole("button", { name: "Next enquiry page" }).click();
  await expect(page.locator(".enquiries-table tbody tr")).toHaveCount(firstPage.total - 25);
  await expect(page.locator(".pagination > span")).toHaveText("2 / 2");
  await page.getByRole("button", { name: "Previous enquiry page" }).click();
  await expect(page.locator(".enquiries-table tbody tr")).toHaveCount(25);
  const sorted = page.waitForResponse(response => response.url().includes("/api/leads?") && new URL(response.url()).searchParams.get("sort") === "name");
  await page.getByLabel("Sort enquiries").selectOption("name");
  const sortedPage = await (await sorted).json() as { leads: Lead[] };
  await expect(page.locator(".enquiries-table .person-cell strong")).toHaveText(sortedPage.leads.map(lead => lead.name));
  await page.getByLabel("Search enquiries", { exact: true }).fill(chosen[0].name);
  await page.getByRole("combobox", { name: "Filter course", exact: true }).selectOption(chosen[0].course);
  await page.getByRole("combobox", { name: "Filter stage", exact: true }).selectOption(chosen[0].stage);
  await page.getByRole("combobox", { name: "Filter counsellor", exact: true }).selectOption(owner.id);
  await page.getByRole("button", { name: "High intent", exact: true }).click();
  await expect(page.locator(".enquiries-table .person-cell strong")).toHaveText([chosen[0].name]);
  await page.getByRole("button", { name: "Save view", exact: true }).click();
  await page.getByLabel("View name").fill("Assigned high intent");
  const saving = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.request().method() === "POST" && response.request().postDataJSON().type === "view.save");
  await page.getByRole("dialog").getByRole("button", { name: "Save view", exact: true }).click();
  const savedResponse = await saving;
  expect(savedResponse.ok()).toBe(true);
  expect(savedResponse.request().postDataJSON()).toMatchObject({ view: "high-intent", sort: "name" });
  expect((await savedResponse.json()).workspace.savedViews.find((view: { name: string }) => view.name === "Assigned high intent")).toMatchObject({ view: "high-intent", sort: "name" });
  await expect(page.getByRole("button", { name: "Assigned high intent", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const restored = page.waitForResponse(response => response.url().includes("/api/leads?") && new URL(response.url()).searchParams.get("q") === chosen[0].name);
  await page.getByRole("button", { name: "Assigned high intent", exact: true }).click();
  const params = new URL((await restored).url()).searchParams;
  expect(Object.fromEntries(params)).toMatchObject({ ownerId: owner.id, view: "high-intent", sort: "name", course: chosen[0].course, stage: chosen[0].stage, page: "1" });
  await expect(page.getByLabel("Search enquiries", { exact: true })).toHaveValue(chosen[0].name);
  await expect(page.getByRole("combobox", { name: "Filter counsellor", exact: true })).toHaveValue(owner.id);
  await expect(page.locator(".enquiries-table tbody tr")).toHaveCount(1);
  await page.route("**/api/leads?**", route => route.fulfill({ status: 503, json: { error: "Search temporarily unavailable." } }));
  await page.getByLabel("Search enquiries", { exact: true }).fill("Nobody in this view");
  await expect(page.getByRole("heading", { name: "This view couldn’t load" })).toBeVisible();
  await expect(page.locator(".enquiries-table tbody tr")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export current enquiry page" })).toBeDisabled();
  await page.unroute("**/api/leads?**");
  await page.getByRole("button", { name: "Retry enquiry search" }).click();
  await expect(page.getByRole("heading", { name: "No enquiries in this view" })).toBeVisible();
});

test("enquiry page cap preserves true totals and accessible table labels", async ({ page }) => {
  const state = await workspace(page);
  await page.route("**/api/leads?**", route => route.fulfill({ json: { leads: state.leads.slice(0, 25), total: 25001, page: 1, pageSize: 25, hasMore: true } }));
  await openPage(page, "/leads");
  const table = page.getByRole("table", { name: "Enquiries", exact: true });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Open enquiry", exact: true })).toBeVisible();
  await expect(page.locator(".pagination > span")).toHaveText("1 / 1000");
  await expect(page.locator(".table-footer strong")).toHaveText("25001");
  await expect(page.getByRole("status").filter({ hasText: "Refine your filters" })).toBeVisible();
  expect((await page.request.get("/api/leads?page=1001&pageSize=25")).status()).toBe(400);
});

test("demo integrations and billing expose configuration states without live actions", async ({ page }) => {
  await openPage(page, "/integrations");
  await expect(page.locator(".integration-card")).toHaveCount(6);
  await expect(page.locator(".integration-card > header .badge")).toHaveText(Array(6).fill("Not connected"));
  const whatsapp = page.locator(".integration-card").filter({ has: page.getByRole("heading", { name: "WhatsApp Business", exact: true }) });
  const connect = whatsapp.getByRole("button", { name: "Connect", exact: true });
  await connect.click();
  await expect(page.getByRole("button", { name: "Continue with Meta" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /I already use the WhatsApp Business app/ })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(connect).toBeFocused();
  await page.locator(".integration-card").filter({ has: page.getByRole("heading", { name: "Google Calendar", exact: true }) }).getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator('.google-connect a')).toHaveAttribute("href", "/settings");
  await expect(page.locator('a[href="/api/integrations/google/start"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openPage(page, "/settings");
  const billing = page.getByRole("region", { name: "AdmitFlow subscription" });
  await expect(billing).toContainText("Demo · no billing");
  await expect(billing.getByRole("button", { name: "Continue to Razorpay" })).toHaveCount(0);
  await expect(billing.getByRole("button", { name: "Cancel subscription now" })).toHaveCount(0);
  const state = await workspace(page);
  await page.route("**/api/billing", route => route.fulfill({ json: { mode: "setup", subscription: state.subscription, plans: [], canCancel: false, message: "Platform billing is not configured." } }));
  await billing.getByRole("button", { name: "Refresh billing" }).click();
  await expect(billing).toContainText("Setup required");
  await expect(billing).toContainText("No paid price is assumed");
  await expect(billing.getByRole("button", { name: "Continue to Razorpay" })).toHaveCount(0);
});

test("team entry reconciles members and demo invitations never become active assignees", async ({ page }) => {
  // Initial hydration precedes this fetch, so its budget must include navigation.
  const [entered] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/team") && response.request().method() === "GET", { timeout: 45_000 }),
    openPage(page, "/team"),
  ]);
  expect(entered.ok()).toBe(true);
  const state = await workspace(page);
  const member = state.members!.find(item => item.role === "counsellor" && item.status === "active")!;
  const row = page.locator(".data-table tbody tr").filter({ hasText: member.name });
  await page.getByRole("combobox", { name: `Role for ${member.name}`, exact: true }).selectOption("analyst");
  await expect.poll(async () => (await workspace(page)).members?.find(item => item.id === member.id)?.role).toBe("analyst");
  await page.getByRole("combobox", { name: `Role for ${member.name}`, exact: true }).selectOption("counsellor");
  await row.getByRole("button", { name: "Deactivate", exact: true }).click();
  await expect(row.locator(".badge")).toHaveText("inactive");
  await row.getByRole("button", { name: "Reactivate", exact: true }).click();
  await expect(row.locator(".badge")).toHaveText("active");
  await page.getByRole("button", { name: "Invite teammate" }).click();
  await page.getByLabel("Teammate name").fill("Invited Counsellor");
  const email = `invited-${Date.now()}@example.com`;
  await page.getByRole("dialog").getByLabel("Email address").fill(email);
  await page.getByLabel("Workspace role").selectOption("counsellor");
  const invitation = page.waitForResponse(response => response.url().endsWith("/api/team") && response.request().method() === "POST" && response.request().postDataJSON().type === "invite");
  await page.getByRole("button", { name: "Save demo invitation" }).click();
  const response = await invitation;
  expect(response.ok()).toBe(true);
  const invited = await response.json();
  expect(invited.emailSent).toBe(false);
  expect(invited.member.status).toBe("invited");
  await expect(page.locator(".toast")).toContainText(invited.message);
  expect(invited.message).toContain("No email was sent and no account access was granted");
  await expect(page.locator(".data-table tbody tr").filter({ hasText: email }).locator(".badge")).toHaveText("invited");
  await openPage(page, "/leads");
  await page.getByRole("button", { name: "Add enquiry", exact: true }).click();
  const values = await page.getByRole("dialog").getByLabel("Assigned counsellor").locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(values).toContain(member.id);
  expect(values).not.toContain(invited.member.id);
  await page.keyboard.press("Escape");
  await openPage(page, "/team");
  await expect(page.getByRole("button", { name: "Refresh team" })).toBeEnabled();
  const refreshed = page.waitForResponse(result => result.url().endsWith("/api/team") && result.request().method() === "GET");
  await page.getByRole("button", { name: "Refresh team" }).click();
  expect((await refreshed).ok()).toBe(true);
  const inviteRow = page.locator(".data-table tbody tr").filter({ hasText: email });
  await inviteRow.getByRole("button", { name: "Revoke invitation" }).click();
  await expect(inviteRow.locator(".badge")).toHaveText("inactive");
  await expect(inviteRow.getByRole("button", { name: "Revoke invitation" })).toHaveCount(0);
});

for (const role of ["analyst", "counsellor"] as const) {
  test(`${role} projection hides disallowed overview, ledger and enquiry actions`, async ({ page }) => {
    const state = await workspace(page);
    const member = state.members!.find(item => item.status === "active" && item.role === "counsellor")!;
    const leads = role === "counsellor" ? state.leads.filter(lead => lead.ownerId === member.id) : state.leads;
    const leadIds = new Set(leads.map(lead => lead.id));
    const projected: Workspace = {
      ...state, userName: member.name, leads,
      actor: { id: member.id, memberId: member.id, name: member.name, email: member.email, backend: "local", role },
      tasks: state.tasks?.filter(task => leadIds.has(task.leadId)),
      messages: state.messages.filter(message => leadIds.has(message.leadId)),
      appointments: state.appointments.filter(appointment => leadIds.has(appointment.leadId)),
      ...(role === "counsellor" ? { campaigns: [], jobs: [], revenue: [], refunds: [] } : {}),
    };
    // Exercise UI visibility against the same public projection shape used by authenticated roles.
    await page.route("**/api/workspace", route => route.fulfill({ json: projected }));
    await page.route("**/api/leads?**", route => route.fulfill({ json: { leads: leads.slice(0, 25), total: leads.length, page: 1, pageSize: 25, hasMore: leads.length > 25 } }));
    await openPage(page, "/overview");
    await expect(page.getByRole("button", { name: "Import enquiries", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Meet your assistant" })).toHaveCount(0);
    await expect(page.locator('nav a[href="/team"]')).toHaveCount(0);
    const openTasks = projected.tasks?.filter(task => task.status === "open").length || 0;
    await expect(page.locator(".task-check")).toHaveCount(role === "analyst" ? 0 : Math.min(3, openTasks));
    if (role === "analyst") {
      await openPage(page, "/analytics");
      await expect(page.getByRole("button", { name: "Refund", exact: true })).toHaveCount(0);
    }
    await openPage(page, `/leads?lead=${leads[0].id}`);
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("button", { name: "Record admission", exact: true })).toHaveCount(0);
    await expect(drawer.getByLabel("Counsellor", { exact: true })).toBeDisabled();
    if (role === "analyst") {
      await expect(drawer.getByLabel("Pipeline stage")).toBeDisabled();
      await expect(drawer.getByRole("button", { name: "Save details" })).toHaveCount(0);
      await expect(drawer.getByRole("button", { name: "Book session" })).toHaveCount(0);
    } else {
      await expect(drawer.getByLabel("Pipeline stage")).toBeEnabled();
      await expect(drawer.getByRole("button", { name: "Book session" })).toBeVisible();
    }
  });
}

test("onboarding local setup is readable and keyboard-accessible at narrow widths", async ({ page }) => {
  for (const width of [320, 375, 414, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: /Good to have you here/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "You’re in the local preview" })).toBeVisible();
    await expectNoPageOverflow(page);
    const settings = page.getByRole("link", { name: "Open workspace settings" });
    await settings.focus();
    await expect(settings).toBeFocused();
    await expect(settings).toHaveAttribute("href", "/settings");
  }
});

test("counselling reschedules by member ID, exports the new time and records cancellation", async ({ page }) => {
  const state = await workspace(page);
  const appointment = state.appointments.find(item => item.status === "scheduled");
  expect(appointment, "demo fixture must contain a scheduled session").toBeDefined();
  if (!appointment) throw new Error("Missing scheduled fixture");
  const missed = state.appointments.find(item => item.status === "scheduled" && item.leadId !== appointment.leadId);
  expect(missed, "demo fixture must contain a second student's session").toBeDefined();
  if (!missed) throw new Error("Missing outcome fixture");
  // Seed actual server state before opening the page; a browser-only clock cannot change server validation.
  if (process.env.ADMITFLOW_BROWSER_ISOLATED !== "1" || !process.env.ADMITFLOW_BROWSER_DB) throw new Error("Isolated browser database required");
  const db = new DatabaseSync(process.env.ADMITFLOW_BROWSER_DB, { timeout: 5000 });
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT data FROM workspaces WHERE id = ?").get(state.id) as { data: string };
    const fixture = JSON.parse(row.data) as Workspace;
    expect(fixture.demo).toBe(true);
    for (const item of fixture.appointments) {
      if (item.id === appointment.id) item.startsAt = new Date(Date.now() + 86_400_000).toISOString();
      if (item.id === missed.id) item.startsAt = new Date(Date.now() - 86_400_000).toISOString();
    }
    db.prepare("UPDATE workspaces SET data = ? WHERE id = ?").run(JSON.stringify(fixture), state.id);
    db.exec("COMMIT");
  } finally { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); }
  const lead = state.leads.find(item => item.id === appointment.leadId)!;
  const owner = state.members!.find(member => member.status === "active" && member.role === "counsellor" && member.id !== appointment.ownerId)!;
  await openPage(page, "/appointments");
  const card = page.locator(".appointment-card").filter({ hasText: lead.name });
  await expect(card.getByRole("button", { name: `Mark no-show for ${lead.name}` })).toBeDisabled();
  await card.getByRole("button", { name: "Reschedule", exact: true }).click();
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole("dialog").getByLabel("Session date").fill(day);
  await page.getByRole("dialog").getByLabel("Start time (IST)").fill("16:15");
  await page.getByRole("dialog").getByLabel("Counsellor", { exact: true }).selectOption(owner.id);
  const rescheduled = page.waitForResponse(response => response.url().endsWith("/api/workspace") && response.request().method() === "POST" && response.request().postDataJSON().type === "appointment.reschedule");
  await page.getByRole("button", { name: "Reschedule session", exact: true }).click();
  const result = await rescheduled;
  expect(result.ok()).toBe(true);
  expect(result.request().postDataJSON()).toMatchObject({ id: appointment.id, ownerId: owner.id, startsAt: `${day}T10:45:00.000Z` });
  expect(result.request().postDataJSON()).not.toHaveProperty("owner");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(card).toContainText(owner.name);
  await expect(card).toContainText("Demo · local session");
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: `Download calendar invite for ${lead.name}` }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`counselling-${appointment.id}.ics`);
  const stream = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const calendar = Buffer.concat(chunks).toString("utf8");
  expect(calendar).toContain(`DTSTART:${day.replaceAll("-", "")}T104500Z`);
  expect(calendar).toContain(`Counsellor: ${owner.name}`);
  await card.getByRole("button", { name: `Cancel appointment for ${lead.name}` }).click();
  await page.getByRole("button", { name: "All sessions", exact: true }).click();
  await expect(card.locator(":scope > .badge")).toHaveText("cancelled");
  expect((await workspace(page)).appointments.find(item => item.id === appointment.id)?.status).toBe("cancelled");
  const missedLead = state.leads.find(item => item.id === missed.leadId)!;
  await page.getByRole("button", { name: /^Needs outcome/ }).click();
  const missedCard = page.locator(".appointment-card").filter({ hasText: missedLead.name });
  await missedCard.getByRole("button", { name: `Mark no-show for ${missedLead.name}` }).click();
  await page.getByRole("button", { name: "All sessions", exact: true }).click();
  await expect(missedCard.locator(":scope > .badge")).toHaveText("No-show");
  expect((await workspace(page)).appointments.find(item => item.id === missed.id)?.status).toBe("no_show");
});
