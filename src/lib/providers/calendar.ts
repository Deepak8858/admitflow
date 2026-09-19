import { createHash } from "node:crypto";
import { z } from "zod";
import { loadWorkspace, mutateWorkspace } from "../store";
import { connectionFor, credentials } from "../connections";
import { assert } from "../errors";
import { appUrl } from "../config";
import { isoNow, uid, type Appointment, type Workspace } from "../domain";

export function calendarEventId(id: string) {
  const compact = id.toLowerCase().replaceAll("-", "");
  return /^[0-9a-f]{32}$/.test(compact) ? compact : createHash("sha256").update(id).digest("hex");
}
export function calendarSyncKey(appointment: Appointment) {
  return JSON.stringify([appointment.id, appointment.leadId, appointment.ownerId, appointment.owner, appointment.startsAt, appointment.duration, appointment.kind, appointment.status]);
}
export function overlapsBusy(start: string, duration: number, busy: { start: string; end: string }[]) {
  const from = Date.parse(start), to = from + duration * 60000;
  assert(Number.isFinite(from) && Number.isFinite(duration) && duration > 0, "Choose a valid appointment time.");
  return busy.some(slot => from < Date.parse(slot.end) && to > Date.parse(slot.start));
}
async function accessToken(workspace: Workspace) {
  assert(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET, "Google Calendar application credentials are not configured.", 503);
  const secret = await credentials(workspace, "google");
  assert(secret.refreshToken, "Reconnect Google Calendar to grant offline access.", 409);
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: secret.refreshToken }), signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
  assert(response.ok, response.status >= 500 || response.status === 429 ? "Google is temporarily unavailable. Retry calendar synchronization." : "Reconnect Google Calendar to continue synchronization.", response.status >= 500 || response.status === 429 ? 503 : 409);
  return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
}

/** Availability is queried live; events changed in Google are not imported into AdmitFlow. */
export async function calendarBusy(workspaceId: string, timeMin: string, timeMax: string) {
  const from = Date.parse(timeMin), to = Date.parse(timeMax);
  assert(Number.isFinite(from) && Number.isFinite(to) && to > from && to - from <= 31 * 86400_000, "Choose an availability window of up to 31 days.");
  const workspace = await loadWorkspace(workspaceId), connection = connectionFor(workspace, "google");
  if (workspace.demo || !connection) return { connected: false, busy: [] as { start: string; end: string }[], checkedAt: isoNow() };
  const calendarId = connection.metadata.calendarId || "primary";
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", headers: { Authorization: `Bearer ${await accessToken(workspace)}`, "Content-Type": "application/json" }, body: JSON.stringify({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), items: [{ id: calendarId }] }), signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
  assert(response.ok, "Google availability could not be checked. Retry before booking.", 502);
  const result = z.object({ calendars: z.record(z.string(), z.object({ busy: z.array(z.object({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) })).optional(), errors: z.array(z.unknown()).optional() })) }).parse(await response.json());
  const calendar = result.calendars[calendarId];
  assert(calendar && !calendar.errors?.length && calendar.busy, "The connected calendar did not return availability. Check Google permissions.", 502);
  return { connected: true, busy: calendar.busy, checkedAt: isoNow() };
}

export async function syncAppointment(workspaceId: string, appointmentId: string) {
  const workspace = await loadWorkspace(workspaceId), appointment = workspace.appointments.find(item => item.id === appointmentId);
  assert(appointment, "Appointment not found.", 404);
  const connection = connectionFor(workspace, "google"), snapshot = calendarSyncKey(appointment);
  if (workspace.demo || !connection) {
    await mutateWorkspace(workspaceId, current => { const item = current.appointments.find(item => item.id === appointmentId); if (item && calendarSyncKey(item) === snapshot) item.syncStatus = "local"; });
    return;
  }
  try {
    const token = await accessToken(workspace), calendar = encodeURIComponent(connection.metadata.calendarId || "primary");
    const eventId = appointment.externalId || calendarEventId(appointment.id);
    const base = `https://www.googleapis.com/calendar/v3/calendars/${calendar}/events`;
    const eventUrl = `${base}/${encodeURIComponent(eventId)}`;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const call = (url: string, method: string, body?: unknown) => fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000), cache: "no-store", redirect: "error" });
    if (appointment.status === "cancelled") {
      const response = await call(eventUrl, "DELETE");
      assert(response.ok || [404, 410].includes(response.status), "Google Calendar cancellation failed. Retry synchronization.", 502);
    } else {
      const lead = workspace.leads.find(item => item.id === appointment.leadId);
      assert(lead, "The appointment's enquiry no longer exists.", 409);
      const body = { status: "confirmed", summary: `${appointment.kind} · ${lead.name}`, description: `${workspace.name}\nCounsellor: ${appointment.owner}\nCourse: ${lead.course}\n${appUrl()}/leads?lead=${lead.id}`, start: { dateTime: appointment.startsAt, timeZone: workspace.timezone }, end: { dateTime: new Date(Date.parse(appointment.startsAt) + appointment.duration * 60000).toISOString(), timeZone: workspace.timezone }, extendedProperties: { private: { admitflowWorkspaceId: workspaceId, admitflowAppointmentId: appointmentId } } };
      let response = await call(eventUrl, "PATCH", body);
      if (response.status === 404) {
        response = await call(base, "POST", { id: eventId, ...body });
        // A concurrent worker or a response lost after insertion must not create another event.
        if (response.status === 409) response = await call(eventUrl, "PATCH", body);
      }
      assert(response.ok, response.status === 410 ? "Google permanently removed this event. Book a new session to create a new calendar event." : "Google Calendar could not save this session. Retry synchronization.", 502);
    }
    await mutateWorkspace(workspaceId, current => {
      const item = current.appointments.find(item => item.id === appointmentId);
      if (!item) return;
      const sameConnection = connectionFor(current, "google");
      if (sameConnection?.id !== connection.id || sameConnection.externalId !== connection.externalId || sameConnection.updatedAt !== connection.updatedAt) { item.syncStatus = sameConnection ? "pending" : "local"; return; }
      item.externalId = eventId;
      if (calendarSyncKey(item) === snapshot) item.syncStatus = "synced";
      else {
        item.syncStatus = "pending";
        // An older in-flight PATCH may have overtaken a newer job. Always reconcile the latest version.
        if (!current.jobs.some(job => job.kind === "calendar.sync" && job.status === "pending" && job.payload?.appointmentId === appointmentId)) current.jobs.push({ id: uid(), leadId: item.leadId, campaignId: "", kind: "calendar.sync", step: 0, status: "pending", dueAt: isoNow(), payload: { appointmentId } });
      }
    });
  } catch (error) {
    await mutateWorkspace(workspaceId, current => { const item = current.appointments.find(item => item.id === appointmentId); if (item && calendarSyncKey(item) === snapshot) item.syncStatus = "failed"; });
    throw error;
  }
}
