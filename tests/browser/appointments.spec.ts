import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";

for (const hasFutureSession of [false, true]) {
  test(`counselling rolls over at India midnight with future sessions: ${hasFutureSession}`, async ({ page }) => {
    const data = createWorkspace(true), now = new Date("2026-09-30T23:59:00+05:30");
    data.appointments = hasFutureSession ? data.appointments.slice(0, 1) : [];
    if (hasFutureSession) data.appointments[0].startsAt = "2026-10-02T10:00:00+05:30";
    await page.route("**/api/workspace", route => route.fulfill({ json: data }));
    await page.clock.install({ time: new Date(+now - 60_000) });
    await page.goto("/appointments");
    const firstDay = page.locator(".week-strip button").first();
    await expect(firstDay.locator("strong")).toHaveText("30");
    await page.clock.pauseAt(now);
    await page.clock.runFor(59_999);
    await expect(firstDay.locator("strong")).toHaveText("30");
    await page.clock.runFor(1);
    await expect(firstDay.locator("strong")).toHaveText("1");
    await expect(firstDay).toHaveClass(/today/);
    await expect(page.locator(".calendar-header h2")).toContainText("October 2026");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(firstDay).toHaveAttribute("aria-pressed", "true");
    await page.clock.fastForward(86_400_000);
    await expect(firstDay.locator("strong")).toHaveText("2");
    await expect(firstDay).toHaveClass(/today/);
  });
}

test("booking expires the selected start without interaction and recovers with a future selection", async ({ page }) => {
  const data = createWorkspace(true), now = new Date("2026-09-30T09:59:00+05:30");
  data.appointments = [];
  await page.route("**/api/workspace", route => route.fulfill({ json: data }));
  await page.clock.install({ time: new Date(+now - 60_000) });
  await page.goto("/appointments");
  await page.getByRole("button", { name: "Book a session", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Session date").fill("2026-09-30");
  await dialog.getByLabel("Start time (IST)").fill("10:00");
  const submit = dialog.getByRole("button", { name: "Book session", exact: true });
  const error = dialog.getByRole("alert");
  await expect(submit).toBeEnabled();
  await page.clock.pauseAt(now);
  await page.clock.runFor(59_999);
  await expect(submit).toBeEnabled();
  await expect(error).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(submit).toBeDisabled();
  await expect(error).toHaveText("Choose a future start time in India time.");

  await dialog.getByLabel("Start time (IST)").fill("10:01");
  await expect(submit).toBeEnabled();
  await expect(error).toHaveCount(0);
  await page.clock.runFor(60_000);
  await expect(submit).toBeDisabled();
  await expect(error).toHaveText("Choose a future start time in India time.");
});

for (const view of ["All sessions", "Upcoming"]) {
  test(`counselling updates ${view} at successive session starts without interaction`, async ({ page }) => {
    const data = createWorkspace(true), now = new Date();
    data.appointments = data.appointments.filter(appointment => appointment.status === "scheduled").slice(0, 2);
    expect(data.appointments).toHaveLength(2);
    data.appointments.forEach((appointment, index) => {
      appointment.startsAt = new Date(+now + (index + 1) * 60_000).toISOString();
    });
    await page.route("**/api/workspace", route => route.fulfill({ json: data }));
    await page.clock.install({ time: new Date(+now - 60_000) });
    await page.goto("/appointments");
    await page.getByRole("button", { name: view, exact: true }).click();
    // Let workspace loading finish before pausing its asynchronous callbacks.
    await page.clock.pauseAt(now);
    const cards = page.locator(".appointment-card");
    const complete = page.getByRole("button", { name: "Complete", exact: true });
    const noShow = page.getByRole("button", { name: /^Mark no-show for/ });
    const needsOutcome = page.getByRole("button", { name: /^Needs outcome/ });
    await expect(cards).toHaveCount(2);
    await expect(complete.nth(0)).toBeDisabled();
    await expect(complete.nth(1)).toBeDisabled();
    await expect(noShow.nth(0)).toBeDisabled();
    await expect(needsOutcome).toHaveText("Needs outcome");

    await page.clock.runFor(59_999);
    await expect(complete.nth(0)).toBeDisabled();
    await page.clock.runFor(1);
    await expect(needsOutcome).toHaveText("Needs outcome1");
    if (view === "All sessions") {
      await expect(complete.nth(0)).toBeEnabled();
      await expect(noShow.nth(0)).toBeEnabled();
      await expect(complete.nth(1)).toBeDisabled();
    } else {
      await expect(cards).toHaveCount(1);
      await expect(complete).toBeDisabled();
    }

    await page.clock.runFor(60_000);
    await expect(needsOutcome).toHaveText("Needs outcome2");
    if (view === "All sessions") {
      await expect(complete.nth(1)).toBeEnabled();
      await expect(noShow.nth(1)).toBeEnabled();
    } else {
      await expect(cards).toHaveCount(0);
    }
  });
}
