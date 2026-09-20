import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspace } from "../src/lib/seed";
import { applyAction } from "../src/lib/actions";
import { normalizePhone, recoverableLeads, contactBlock, metrics, appointmentClashes, calendarFile, exportLeads, DAY, uid, hydrateWorkspace, replyBlock, currency, revenueReport, revenueSeries, reportingWindow, resolveSavedViewPreferences, type RevenueEvent, type Refund } from "../src/lib/domain";

test("phone normalisation preserves one identity across Indian and E.164 imports", () => {
  assert.equal(normalizePhone("98765 43210"), "+919876543210");
  assert.equal(normalizePhone("+91 (98765) 43210"), "+919876543210");
  assert.equal(normalizePhone("919876543210"), "+919876543210");
  assert.equal(normalizePhone("'+919876543210"), "+919876543210");
  assert.equal(normalizePhone("not a number"), null);
  assert.equal(normalizePhone("+0123456789"), null);
});

test("CSV intake skips duplicates and rejects invalid rows without inventing opt-in", () => {
  const w = createWorkspace(false);
  const result = applyAction(w, { type: "lead.import", rows: [
    { name: "Ananya", phone: "9876543210", notes: "Fees, weekend batch", course: "NEET", createdAt: "2026-01-01" },
    { name: "Duplicate", phone: "+919876543210" },
    { name: "Invalid", phone: "abc" },
    { name: "Missing source", phone: "9876543211", consent: "opted_in" },
  ] }) as { imported: number; duplicates: number; errors: unknown[] };
  assert.equal(result.imported, 1); assert.equal(result.duplicates, 1); assert.equal(result.errors.length, 2);
  assert.equal(w.leads[0].notes, "Fees, weekend batch");
  assert.equal(w.leads[0].consent, "unknown");
  assert.equal(recoverableLeads(w).length, 0);
  assert.match(exportLeads(w.leads), /'\+919876543210/);
});

test("recovery excludes unknown consent, opt-outs, minors without guardian consent and closed enquiries", () => {
  const w = createWorkspace();
  const leads = recoverableLeads(w);
  assert.ok(leads.length > 0);
  for (const lead of leads) { assert.equal(contactBlock(lead), null); assert.equal(lead.consent, "opted_in"); assert.ok(Date.now() - new Date(lead.lastContactAt || lead.createdAt).getTime() >= 7 * DAY); }
  assert.ok(!leads.some(l => l.name === "Arnav Jain"));
  assert.ok(!leads.some(l => ["unknown", "opted_out"].includes(l.consent)));
});

test("campaign audience is revalidated and duplicate enrolment is prevented", () => {
  const w = createWorkspace();
  const lead = recoverableLeads(w)[0];
  const action = { type: "campaign.create", name: "Recovery", course: "All courses", message: "Hi {name}", leadIds: [lead.id, lead.id] };
  applyAction(w, action);
  assert.equal(w.campaigns[0].leadIds.length, 1);
  assert.equal(w.jobs.filter(j => j.leadId === lead.id).length, 3);
  assert.throws(() => applyAction(w, action), /no longer eligible/);
  applyAction(w, { type: "lead.update", id: lead.id, changes: { humanOwned: true } });
  assert.ok(w.jobs.filter(j => j.leadId === lead.id).every(j => j.status === "cancelled"));
});

test("a stage change does not create revenue; a receipt does, and cannot be duplicated", () => {
  const w = createWorkspace();
  const lead = recoverableLeads(w)[0];
  const before = metrics(w, 90).totalRevenue;
  applyAction(w, { type: "lead.update", id: lead.id, changes: { stage: "Admitted" } });
  assert.equal(metrics(w, 90).totalRevenue, before);
  assert.throws(() => applyAction(w, { type: "revenue.record", leadId: lead.id, amount: 1000, reference: "R1", campaignId: w.campaigns[0].id }), /must belong/);
  applyAction(w, { type: "revenue.record", leadId: lead.id, amount: 1000, reference: "R1", campaignId: null });
  assert.equal(metrics(w, 90).totalRevenue, before + 1000);
  assert.throws(() => applyAction(w, { type: "revenue.record", leadId: lead.id, amount: 1000, reference: "R1", campaignId: null }), /already been recorded/);
  assert.throws(() => applyAction(w, { type: "revenue.record", leadId: lead.id, amount: -1, reference: "R2", campaignId: null }));
});

test("appointments reject overlaps for the same counsellor but allow adjacent or different-owner slots", () => {
  const w = createWorkspace();
  const lead = w.leads[0];
  const start = new Date(Date.now() + 5 * DAY).toISOString();
  applyAction(w, { type: "appointment.create", leadId: lead.id, owner: "Priya Sharma", startsAt: start, duration: 30, kind: "Counselling" });
  assert.equal(appointmentClashes(w, "Priya Sharma", start, 30), true);
  assert.equal(appointmentClashes(w, "Arjun Mehta", start, 30), false);
  assert.equal(appointmentClashes(w, "Priya Sharma", new Date(new Date(start).getTime() + 30 * 60000).toISOString(), 30), false);
  assert.throws(() => applyAction(w, { type: "appointment.create", leadId: lead.id, owner: "Priya Sharma", startsAt: start, duration: 30, kind: "Counselling" }), /already has an appointment/);
  const calendar = calendarFile(w.appointments.at(-1)!, "Student, Name", "Apex; Academy");
  assert.match(calendar, /BEGIN:VEVENT/); assert.match(calendar, /Student\\, Name/); assert.match(calendar, /DTSTART:\d{8}T\d{6}Z/);
});

test("cross-workspace IDs are never resolved by domain mutations", () => {
  const first = createWorkspace(), second = createWorkspace();
  assert.throws(() => applyAction(first, { type: "lead.update", id: second.leads[0].id, changes: { stage: "Lost" } }), /not found in your workspace/);
  assert.throws(() => applyAction(first, { type: "article.save", id: uid(), title: "Wrong", category: "FAQs", body: "Foreign source" }), /not found/);
});

test("legacy hydration preserves original IDs and stable label mappings without claiming WorkOS members by name", () => {
  const original = createWorkspace();
  const leadId = original.leads[0].id;
  delete original.members;
  original.leads.forEach(lead => { delete lead.ownerId; });
  const first = hydrateWorkspace(structuredClone(original)), second = hydrateWorkspace(structuredClone(original));
  assert.equal(first.leads[0].id, leadId);
  assert.deepEqual(first.members, second.members);
  assert.equal(first.leads[0].ownerId, first.members![0].id);
  first.members![0].workosId = "user_real";
  delete first.leads[0].ownerId;
  hydrateWorkspace(first);
  assert.equal(first.leads[0].ownerId, null, "a name match cannot grant a WorkOS user ownership");
  first.leads[0].ownerId = "user_real";
  hydrateWorkspace(first);
  assert.equal(first.leads[0].ownerId, first.members![0].id, "an explicit identity ID is safely normalized");
});

test("assignments require active stable members, distinguish same-name counsellors, and bulk updates validate all IDs first", () => {
  const workspace = createWorkspace(false);
  workspace.members = [
    { id: "membership_a", workosId: "user_a", name: "Same Name", email: "a@example.com", role: "counsellor", status: "active" },
    { id: "membership_b", workosId: "user_b", name: "Same Name", email: "b@example.com", role: "counsellor", status: "active" },
    { id: "membership_c", workosId: "user_c", name: "Inactive", email: "c@example.com", role: "counsellor", status: "inactive" },
  ];
  workspace.team = ["Same Name"];
  assert.throws(() => applyAction(workspace, { type: "lead.create", lead: { name: "Student", phone: "9876543210", owner: "Same Name" } }), /ownerId/);
  applyAction(workspace, { type: "lead.create", lead: { name: "Student", phone: "9876543210", ownerId: "user_a" } });
  const lead = workspace.leads[0];
  assert.equal(lead.ownerId, "membership_a"); assert.equal(lead.owner, "Same Name");
  assert.throws(() => applyAction(workspace, { type: "lead.update", id: lead.id, changes: { ownerId: "membership_c" } }), /active member/);
  assert.throws(() => applyAction(workspace, { type: "lead.bulk", ids: [lead.id, uid()], ownerId: "membership_b" }), /not found/);
  assert.equal(lead.ownerId, "membership_a");
  applyAction(workspace, { type: "lead.bulk", ids: [lead.id], ownerId: "membership_b" });
  assert.equal(lead.ownerId, "membership_b");
  applyAction(workspace, { type: "lead.update", id: lead.id, changes: { ownerId: null } });
  assert.equal(lead.ownerId, null);
});

test("reply windows reject invalid/future timestamps and manual refunds reject sub-paise amounts", () => {
  const workspace = createWorkspace(), lead = workspace.leads[1];
  lead.lastInboundAt = "invalid"; assert.match(replyBlock(lead)!, /window is closed/);
  lead.lastInboundAt = new Date(Date.now() + DAY).toISOString(); assert.match(replyBlock(lead)!, /window is closed/);
  assert.throws(() => applyAction(workspace, { type: "revenue.refund", revenueId: workspace.revenue[0].id, amount: 0.001, reference: "BAD-PAISE" }), /two decimal/);
});

test("INR formatting retains paise and signs while compact figures remain explicit approximations", () => {
  assert.equal(currency(1250.5), "₹1,250.50");
  assert.equal(currency(1250.01), "₹1,250.01");
  assert.equal(currency(-12.34), "-₹12.34");
  assert.equal(currency(1250), "₹1,250");
  assert.equal(currency(0.1 + 0.2), "₹0.30");
  assert.equal(currency(1.005), "₹1.01");
  assert.equal(currency(-0), "₹0");
  assert.equal(currency(1250.5, true), "₹1.3k");
  assert.equal(currency(-1250.5, true), "-₹1.3k");
  assert.equal(currency(2000, true), "₹2k");
  assert.equal(currency(999.5, true), "₹999.50");
  assert.equal(currency(99999.99, true), "₹1.0L");
});

test("cancelling a synced appointment immediately exposes pending synchronization", () => {
  const workspace = createWorkspace(false);
  applyAction(workspace, { type: "lead.create", lead: { name: "Student", phone: "9876543210" } });
  const result = applyAction(workspace, { type: "appointment.create", leadId: workspace.leads[0].id, startsAt: new Date(Date.now() + DAY).toISOString(), duration: 30, kind: "Counselling" }) as { appointmentId: string };
  const appointment = workspace.appointments[0];
  appointment.syncStatus = "synced"; appointment.externalId = "google-event";
  applyAction(workspace, { type: "appointment.status", id: result.appointmentId, status: "cancelled" });
  assert.equal(appointment.status, "cancelled"); assert.equal(appointment.syncStatus, "pending");
  assert.equal(workspace.jobs.at(-1)!.kind, "calendar.sync"); assert.equal(workspace.jobs.at(-1)!.status, "pending");
  assert.equal(workspace.jobs.at(-1)!.payload!.appointmentId, appointment.id);
});

function receipt(leadId: string, amount: number, recordedAt: string, campaignId: string | null = null): RevenueEvent {
  const id = uid(); return { id, leadId, amount, recordedAt, campaignId, reference: `receipt-${id}` };
}
function refund(revenueId: string, amount: number, recordedAt: string): Refund {
  const id = uid(); return { id, revenueId, amount, recordedAt, reference: `refund-${id}` };
}

test("paid-student series deduplicates instalments cumulatively across days and campaigns within the period", () => {
  const workspace = createWorkspace(false), first = uid(), second = uid(), campaignA = uid(), campaignB = uid();
  const now = Date.parse("2026-09-12T12:00:00+05:30");
  workspace.revenue = [
    receipt(first, 749.75, "2026-09-11T12:00:00+05:30", campaignB),
    receipt(second, 200.2, "2026-09-12T08:00:00+05:30", campaignB),
    receipt(first, 500, "2026-08-01T10:00:00+05:30", uid()),
    receipt(first, 1250.5, "2026-09-10T10:00:00+05:30", campaignA),
    receipt(second, 100.1, "2026-09-10T11:00:00+05:30"),
  ];
  const before = structuredClone(workspace), report = revenueReport(workspace, 3, now);
  assert.deepEqual(report.series.map(point => point.count), [1, 1, 2]);
  assert.deepEqual(report.series.map(point => point.newRecoveredAdmissions), [1, 0, 1]);
  assert.deepEqual(report.series.map(point => point.cumulativeAdmissions), [2, 2, 2]);
  assert.deepEqual(report.series.map(point => point.valuePaise), [125050, 74975, 20020]);
  assert.deepEqual(report.series.map(point => point.cumulativePaise), [125050, 200025, 220045]);
  assert.equal(report.totals.grossRevenue, 2300.55); assert.equal(report.totals.recoveredRevenue, 2200.45);
  assert.equal(report.totals.admissions, 2); assert.equal(report.totals.recoveredAdmissions, 2);
  const headline = metrics(workspace, 3, now), chart = revenueSeries(workspace, 3, now);
  assert.equal(chart.at(-1)!.count, headline.recoveredAdmissions);
  assert.equal(chart.at(-1)!.cumulative, headline.recoveredRevenue);
  assert.deepEqual(workspace, before, "reporting must not change payment records or their INR values");
});

test("refund-date cash flow keeps daily net values and headlines consistent, including older receipts", () => {
  const workspace = createWorkspace(false), campaign = uid(), now = Date.parse("2026-09-12T12:00:00+05:30");
  const previous = receipt(uid(), 100.5, "2026-09-09T23:59:59.999+05:30", campaign);
  const recovered = receipt(uid(), 200.25, "2026-09-10T12:00:00+05:30", campaign);
  const direct = receipt(uid(), 80.1, "2026-09-11T12:00:00+05:30");
  workspace.revenue = [previous, recovered, direct];
  workspace.refunds = [
    refund(previous.id, 25.25, "2026-09-10T08:00:00+05:30"),
    refund(recovered.id, 50.05, "2026-09-11T08:00:00+05:30"),
    refund(direct.id, 10.01, "2026-09-12T08:00:00+05:30"),
    refund(recovered.id, 20, new Date(now + 1).toISOString()),
    refund(recovered.id, 1, "2026-09-09T23:59:59.999+05:30"),
    refund(uid(), 9.99, "2026-09-12T08:00:00+05:30"),
  ];
  const report = revenueReport(workspace, 3, now), headline = metrics(workspace, 3, now);
  assert.equal(report.money.grossPaise, 28035); assert.equal(report.money.refundsPaise, 8531); assert.equal(report.money.netPaise, 19504);
  assert.equal(headline.totalRefunds, 85.31); assert.equal(headline.totalRevenue, 195.04); assert.equal(headline.recoveredRevenue, 124.95);
  assert.deepEqual(report.series.map(point => point.valuePaise), [17500, -5005, 0]);
  assert.deepEqual(report.series.map(point => point.netPaise), [17500, 3005, -1001]);
  assert.equal(report.series.reduce((sum, point) => sum + point.netPaise, 0), report.money.netPaise);
  assert.equal(report.series.at(-1)!.cumulativePaise, 12495);
  assert.equal(report.series.at(-1)!.cumulative, headline.recoveredRevenue);
  assert.deepEqual(report.series.map(point => point.count), [1, 1, 1]);
  assert.equal(headline.admissions, 2); assert.equal(report.refunds.length, 3);
});

test("report windows use Indian calendar days and exclude future events, even later in the same day", () => {
  const workspace = createWorkspace(false), campaign = uid(), now = Date.parse("2026-09-12T00:15:00+05:30");
  const window = reportingWindow(2, now);
  assert.equal(window.timeZone, "Asia/Kolkata");
  assert.equal(window.start, "2026-09-10T18:30:00.000Z"); assert.equal(window.end, "2026-09-11T18:45:00.000Z");
  const before = receipt(uid(), 91, new Date(window.startMs - 1).toISOString(), campaign);
  const future = receipt(uid(), 99, new Date(now + 1).toISOString(), campaign);
  workspace.revenue = [
    before, future,
    receipt(uid(), 0.1, window.start, campaign),
    receipt(uid(), 0.2, "2026-09-11T23:59:59.999+05:30", campaign),
    receipt(uid(), 0.3, "2026-09-12T00:00:00+05:30", campaign),
    receipt(uid(), 0.4, window.end, campaign),
    receipt(uid(), 0.05, "2026-09-10T19:30:00+01:00", campaign),
    receipt(uid(), 500, new Date(now + DAY).toISOString(), campaign),
    receipt(uid(), 500, "invalid", campaign),
  ];
  workspace.refunds = [refund(before.id, 0.02, window.start), refund(future.id, 0.01, window.end), refund(before.id, 0.01, new Date(now + 1).toISOString())];
  workspace.appointments = [window.startMs - 1, window.startMs, now, now + 1].map(start => ({ id: uid(), leadId: uid(), owner: "Counsellor", startsAt: new Date(start).toISOString(), duration: 30, kind: "Counselling", status: "scheduled" }));
  const report = revenueReport(workspace, 2, now), headline = metrics(workspace, 2, now);
  assert.deepEqual(report.series.map(point => point.date), ["2026-09-10T18:30:00.000Z", "2026-09-11T18:30:00.000Z"]);
  assert.deepEqual(report.series.map(point => point.grossPaise), [35, 70]);
  assert.deepEqual(report.series.map(point => point.count), [3, 5]);
  assert.equal(report.payments.length, 5); assert.equal(report.refunds.length, 1);
  assert.equal(headline.grossRevenue, 1.05); assert.equal(headline.totalRefunds, 0.02); assert.equal(headline.totalRevenue, 1.03);
  assert.equal(headline.recoveredAdmissions, 5); assert.equal(headline.appointments, 2);
  assert.equal(report.series.at(-1)!.cumulativePaise, 103);
  assert.equal(report.series.at(-1)!.cumulative, headline.recoveredRevenue);
  assert.equal(reportingWindow(1, Date.parse("2026-01-01T00:00:00+05:30")).start, "2025-12-31T18:30:00.000Z");
  assert.equal(reportingWindow(2, Date.parse("2024-03-01T00:30:00+05:30")).start, "2024-02-28T18:30:00.000Z");
});

test("refund-only periods can be net negative without inventing admissions, and full refunds do not duplicate students", () => {
  const workspace = createWorkspace(false), now = Date.parse("2026-09-12T12:00:00+05:30");
  const payment = receipt(uid(), 1250.5, "2026-09-01T12:00:00+05:30", uid());
  workspace.revenue = [payment]; workspace.refunds = [refund(payment.id, 1250.5, "2026-09-12T09:00:00+05:30")];
  const short = revenueReport(workspace, 1, now), full = revenueReport(workspace, 30, now);
  assert.equal(short.totals.totalRevenue, -1250.5); assert.equal(short.series[0].cumulativePaise, -125050); assert.equal(short.series[0].count, 0);
  assert.equal(full.totals.totalRevenue, 0); assert.equal(full.totals.admissions, 1); assert.equal(full.series.at(-1)!.count, 1);
  assert.equal(full.money.grossPaise, 125050); assert.equal(full.money.refundsPaise, 125050);
});

test("saved views validate server preferences and preserve legacy browser fallback without overriding saved values", () => {
  const workspace = createWorkspace(false);
  const result = applyAction(workspace, { type: "view.save", name: "Priority by name", query: "Student", course: "NEET", stage: "Qualified", owner: "member-1", view: "high-intent", sort: "name" }) as { viewId: string; view: string; sort: string };
  const saved = workspace.savedViews![0];
  assert.equal(result.viewId, saved.id); assert.equal(result.view, "high-intent"); assert.equal(result.sort, "name");
  assert.deepEqual(resolveSavedViewPreferences(saved, { view: "admitted", sort: "newest" }), { view: "high-intent", sort: "name" });
  applyAction(workspace, { type: "view.save", name: "Old record", owner: "Old counsellor" });
  const old = workspace.savedViews![1];
  assert.equal(old.view, undefined); assert.equal(old.sort, undefined);
  assert.deepEqual(resolveSavedViewPreferences(old, { view: "needs-followup", sort: "newest" }), { view: "needs-followup", sort: "newest" });
  assert.deepEqual(resolveSavedViewPreferences(old), { view: "all", sort: "intent" });
  assert.deepEqual(resolveSavedViewPreferences({ view: "admitted" }, { view: "high-intent", sort: "name" }), { view: "admitted", sort: "name" });
  assert.deepEqual(resolveSavedViewPreferences(old, null), { view: "all", sort: "intent" });
  assert.deepEqual(resolveSavedViewPreferences(old, { view: "__proto__", sort: ["name"] }), { view: "all", sort: "intent" });
  const count = workspace.savedViews!.length;
  assert.throws(() => applyAction(workspace, { type: "view.save", name: "Invalid view", view: "not-a-view" }));
  assert.throws(() => applyAction(workspace, { type: "view.save", name: "Invalid sort", sort: "not-a-sort" }));
  assert.equal(workspace.savedViews!.length, count);
});
