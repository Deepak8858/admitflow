import { test, expect } from "@playwright/test";
import { createWorkspace } from "../../src/lib/seed";

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
