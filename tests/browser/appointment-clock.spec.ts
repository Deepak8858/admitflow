import { test, expect, type Page } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";
import { DAY, HOUR, type Workspace } from "../../src/lib/domain";

const start = Date.parse("2026-09-30T10:00:00+05:30");

function fixture(starts: number[]): Workspace {
  const workspace = createWorkspace();
  workspace.jobs = [];
  workspace.appointments = starts.map((startsAt, index) => ({
    id: `clock-session-${index}`,
    leadId: workspace.leads[index].id,
    owner: workspace.leads[index].owner,
    ownerId: workspace.leads[index].ownerId,
    startsAt: new Date(startsAt).toISOString(),
    duration: 30,
    kind: "Counselling",
    status: "scheduled",
  }));
  return workspace;
}

async function openCalendar(page: Page, current: () => Workspace, time = start) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && /hydrat/i.test(message.text())) errors.push(message.text());
  });
  // Intercept every API request: this clock-only regression never mutates a live workspace.
  await page.route("**/api/**", route => {
    if (route.request().method() === "GET" && new URL(route.request().url()).pathname === "/api/workspace") {
      return route.fulfill({ json: current() });
    }
    return route.fulfill({ status: 503, json: { error: "Clock regression uses fixture reads only." } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Let hydration/animations settle with running timers, then pause before the tested boundary.
  await page.clock.install({ time: new Date(time - HOUR) });
  await page.goto("/appointments");
  await expect(page.getByRole("heading", { name: "Make the next conversation count." })).toBeVisible();
  await expect(page.locator("#main-content")).toHaveCSS("opacity", "1");
  await page.clock.pauseAt(new Date(time));
  return errors;
}

test("session outcome controls enable at the start time while All sessions stays open", async ({ page }) => {
  const workspace = fixture([start + 1_000]);
  const errors = await openCalendar(page, () => workspace);
  await page.getByRole("button", { name: "All sessions", exact: true }).click();
  const card = page.locator(".appointment-card");
  const complete = card.getByRole("button", { name: "Complete", exact: true });
  const noShow = card.getByRole("button", { name: `Mark no-show for ${workspace.leads[0].name}` });
  await expect(complete).toBeDisabled();
  await expect(noShow).toBeDisabled();
  await page.clock.runFor(999);
  await expect(complete).toBeDisabled();
  await expect(noShow).toBeDisabled();
  await page.clock.runFor(1);
  // No click, refresh or data response may trigger the update after time advances.
  await expect(complete).toBeEnabled();
  await expect(noShow).toBeEnabled();
  await expect(page.getByRole("button", { name: /^Needs outcome/ }).locator("span")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("open Upcoming and Needs outcome lists update as their next sessions start", async ({ page }) => {
  const workspace = fixture([start + 1_000, start + 2_000]);
  const errors = await openCalendar(page, () => workspace);
  const cards = page.locator(".appointment-card");
  await expect(cards).toHaveCount(2);
  await page.clock.runFor(1_000);
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(workspace.leads[1].name);
  await page.getByRole("button", { name: /^Needs outcome/ }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards).toContainText(workspace.leads[0].name);
  await page.clock.runFor(1_000);
  await expect(cards).toHaveCount(2);
  await expect(page.getByRole("button", { name: /^Needs outcome/ }).locator("span")).toHaveText("2");
  expect(errors).toEqual([]);
});

test("a refreshed appointment time replaces the next clock boundary", async ({ page }) => {
  let workspace = fixture([start + 40 * DAY]);
  const errors = await openCalendar(page, () => workspace);
  await page.getByRole("button", { name: "All sessions", exact: true }).click();
  const card = page.locator(".appointment-card");
  await expect(card.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  workspace = {
    ...workspace,
    appointments: workspace.appointments.map(appointment => ({
      ...appointment, startsAt: new Date(start + 60_000).toISOString(),
    })),
  };
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/workspace"),
    page.getByRole("button", { name: "Refresh counselling sessions" }).click(),
  ]);
  await response.finished();
  // React Query batches notifications on a timer, which must run after the fixture refresh.
  await page.clock.runFor(100);
  await expect(card).toContainText("10:01");
  await page.clock.runFor(59_899);
  await expect(card.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  await page.clock.runFor(1);
  await expect(card.getByRole("button", { name: "Complete", exact: true })).toBeEnabled();
  await expect(card.getByRole("button", { name: `Mark no-show for ${workspace.leads[0].name}` })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("Indian midnight updates today and the rolling week even with a distant session", async ({ page }) => {
  const midnight = Date.parse("2026-10-01T00:00:00+05:30");
  const workspace = fixture([midnight + 40 * DAY]);
  const errors = await openCalendar(page, () => workspace, midnight - 1_000);
  await expect(page.locator(".week-strip .today strong")).toHaveText("30");
  await expect(page.locator(".calendar-header h2")).toContainText("September");
  await page.clock.runFor(1_000);
  await expect(page.locator(".week-strip .today strong")).toHaveText("1");
  await expect(page.locator(".week-strip > button").first().locator("strong")).toHaveText("1");
  await expect(page.locator(".calendar-header h2")).toContainText("October");
  await expect(page.locator(".appointment-card").getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});
