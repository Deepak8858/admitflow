import { z } from "zod";
import { type Workspace, type Lead, type Message, type Job, type Appointment, contactBlock, replyBlock, uid, isoNow, stopJobs, cancelUndispatchedJob, addActivity, latestInbound, laterTimestamp } from "./domain";
import { applyAction, findLead, appointmentProposal, type AppointmentProposal } from "./actions";
import { loadWorkspace, mutateWorkspace } from "./store";
import { connectionFor, credentials, validProviderKey } from "./connections";
import { storageConfigured, ingestDocument, saveGeneratedAudio, MAX_FILE_SIZE } from "./files";
import { workosConfigured, metaVersion } from "./config";
import { scopeWorkspace, authorizeRecordAction, assertMessageFile, actorOwnerId } from "./permissions";
import { AppError, assert } from "./errors";
import { generateReply } from "./providers/ai";
import { sendText, sendTemplate, graph, MetaRequestError, type BeforeDispatch } from "./providers/meta";
import { readLimitedBytes, readLimitedText } from "./http";
import { calendarBusy, overlapsBusy, calendarEventId, calendarSyncKey } from "./providers/calendar";
import { assertWorkspaceCapability, requirePaidCapability, workspaceCapabilities } from "./subscription-access";
import { SubscriptionRestricted, jobCapability } from "./subscription-policy";

type Actor = NonNullable<Workspace["actor"]>;
export function integrationStatus(workspace: Workspace) {
  const live = !workspace.demo;
  const provider = (service: "openai" | "elevenlabs", key?: string) => {
    const connection = workspace.connections?.find(item => item.service === service);
    return connection ? connection.status === "connected" && Boolean(connection.secret) : validProviderKey(service, key);
  };
  return { ai: live && provider("openai", process.env.OPENAI_API_KEY), whatsapp: live && Boolean(connectionFor(workspace, "whatsapp")), template: live && Boolean(connectionFor(workspace, "whatsapp")?.metadata.templateName), storage: live && storageConfigured(), speech: live && provider("elevenlabs", process.env.ELEVENLABS_API_KEY), calendar: live && Boolean(connectionFor(workspace, "google")), payments: live && Boolean(connectionFor(workspace, "razorpay")), auth: workosConfigured(), metaAppId: process.env.NEXT_PUBLIC_META_APP_ID || "", metaConfigId: process.env.NEXT_PUBLIC_META_CONFIG_ID || "", metaVersion: metaVersion() };
}
export function publicWorkspace(workspace: Workspace, actor?: Actor) {
  const scoped = scopeWorkspace(workspace, actor || workspace.actor || { id: workspace.id, name: workspace.userName, email: workspace.email, role: "owner", backend: "local" });
  delete scoped.trial;
  return { ...scoped, capabilities: workspaceCapabilities(workspace), integrations: integrationStatus(workspace) };
}
export async function suggestReply(workspace: Workspace, lead: Lead, question?: string, actor?: Actor) {
  if (actor) {
    authorizeRecordAction(workspace, actor, { type: "message.suggest", leadId: lead.id });
    const scoped = scopeWorkspace(workspace, actor);
    // Keep the credential binding server-side; the model only sees the scoped
    // lead/thread/articles and never receives any connection metadata.
    scoped.connections = workspace.connections;
    return generateReply(scoped, findLead(scoped, lead.id), question);
  }
  return generateReply(workspace, findLead(workspace, lead.id), question);
}

class DispatchBlocked extends AppError { constructor(message: string, public readonly deferred = false) { super(message, 409); } }
const RETRY_LIMIT = 3;
export const JOB_LOCK_MS = 5 * 60_000;
function jobMatches(current: Job | undefined, claim: Job) { return current?.status === "processing" && current.attempts === claim.attempts && current.lockedAt === claim.lockedAt; }
function messageUncertain(message?: Message) { return Boolean(message && !message.providerId && message.dispatchedAt && message.dispatchState !== "rejected"); }
function errorText(error: unknown) { return error instanceof AppError ? error.message : "The provider operation could not be confirmed. Check the connection and job details."; }
function transient(error: unknown) {
  if (error instanceof MetaRequestError) return error.retryable;
  if (error instanceof AppError) return [429, 500, 502, 503, 504].includes(error.status);
  if (error instanceof Error && ["TimeoutError", "AbortError", "APIConnectionError", "APIConnectionTimeoutError", "TypeError"].includes(error.name)) return true;
  const status = (error as { status?: number })?.status;
  return status === 429 || Boolean(status && status >= 500);
}
function usedAiMessages(workspace: Workspace) {
  return workspace.messages.filter(message => message.author === "AdmitFlow AI" && message.direction === "outbound" && message.status !== "draft" && message.createdAt.slice(0, 10) === isoNow().slice(0, 10)).length;
}
function reservedAiReplies(workspace: Workspace) {
  return workspace.jobs.filter(job => job.kind === "ai.reply" && job.status === "processing" && !workspace.messages.some(message => message.id === job.messageId)).length;
}
function checkReply(workspace: Workspace, lead: Lead, autonomous: boolean, sourceMessageId?: string) {
  const block = workspace.demo ? lead.consent === "opted_out" ? "This student has opted out of messages." : lead.isMinor && !lead.guardianConsent ? "Guardian consent needs attention." : null : replyBlock(lead);
  if (block) throw new DispatchBlocked(block);
  if (autonomous && (lead.humanOwned || workspace.ai?.mode !== "autonomous")) throw new DispatchBlocked("AI paused or a counsellor took over before dispatch.");
  if (sourceMessageId !== undefined && latestInbound(workspace, lead)?.id !== sourceMessageId) throw new DispatchBlocked("A newer student message arrived. Prepare a reply to the latest message.");
}
function checkFollowup(workspace: Workspace, job: Job, lead: Lead) {
  const campaign = workspace.campaigns.find(item => item.id === job.campaignId);
  if (!workspace.sequence.enabled || campaign?.status === "paused") throw new DispatchBlocked("Recovery is paused; this job will wait for resume.", true);
  if (!campaign || campaign.status !== "active" || !campaign.leadIds.includes(lead.id) || contactBlock(lead) || lead.humanOwned || (lead.lastInboundAt && Date.parse(lead.lastInboundAt) >= Date.parse(campaign.createdAt))) throw new DispatchBlocked("This enquiry is no longer eligible for the recovery campaign.");
  const previous = workspace.jobs.find(item => item.campaignId === job.campaignId && item.leadId === job.leadId && item.step === job.step - 1);
  if (previous && !["sent", "demo"].includes(previous.status)) throw new DispatchBlocked("Waiting for the previous step's signed send status.", true);
}

interface ReplyOptions { author?: string; actor?: Actor; fileId?: string; autonomous?: boolean; sourceMessageId?: string; source?: string; job?: Job; voiceAudio?: boolean; voiceFallback?: string }
function dispatchGuard(workspaceId: string, snapshot: Workspace, leadSnapshot: Lead, requestId: string, options: ReplyOptions, inboundId: string | undefined, followup = false): BeforeDispatch {
  return async prepared => {
    await mutateWorkspace(workspaceId, current => {
      const lead = findLead(current, leadSnapshot.id), message = current.messages.find(item => item.id === requestId);
      assert(message && message.leadId === lead.id && message.direction === "outbound", "The outbound message is unavailable.", 409);
      if (message.status !== "queued") throw new DispatchBlocked("This message was already completed, recovered or cancelled.");
      if (options.job && !jobMatches(current.jobs.find(item => item.id === options.job!.id), options.job)) throw new DispatchBlocked("The job was cancelled or another worker recovered it.");
      if (options.actor) authorizeRecordAction(current, options.actor, { type: "message.send", leadId: lead.id, ...(message.fileId ? { fileId: message.fileId } : {}) });
      assertWorkspaceCapability(current);
      if (followup) checkFollowup(current, options.job!, lead);
      else checkReply(current, lead, Boolean(options.autonomous), options.sourceMessageId);
      if (latestInbound(current, lead)?.id !== inboundId) throw new DispatchBlocked("A newer incoming message arrived before dispatch.");
      if (options.autonomous && usedAiMessages(current) > current.ai!.dailyLimit) throw new DispatchBlocked("The institute's daily AI reply limit has been reached.");
      if (message.fileId) assertMessageFile(current, lead.id, message.fileId, options.actor);
      const before = connectionFor(snapshot, "whatsapp"), after = connectionFor(current, "whatsapp");
      if (current.demo !== snapshot.demo || (!current.demo && (!after || after.id !== before?.id || after.externalId !== before.externalId || after.updatedAt !== before.updatedAt))) throw new DispatchBlocked("The WhatsApp connection changed before dispatch.");
      if (lead.phone !== leadSnapshot.phone || lead.whatsappId !== leadSnapshot.whatsappId || lead.ownerId !== leadSnapshot.ownerId) throw new DispatchBlocked("The enquiry identity or assignment changed before dispatch.");
      assert(!message.providerId && (!message.dispatchedAt || message.dispatchState === "rejected"), "This message has already been dispatched; reconcile its status.", 409);
      message.body = prepared.body; message.mediaType = prepared.mediaType;
      if (!current.demo) { message.dispatchedAt = isoNow(); message.dispatchState = "dispatching"; }
      if (options.job) current.jobs.find(item => item.id === options.job!.id)!.dispatchedAt = message.dispatchedAt || null;
    });
  };
}

async function recordAccepted(workspaceId: string, leadId: string, requestId: string, providerId?: string) {
  return (await mutateWorkspace(workspaceId, workspace => {
    const message = workspace.messages.find(item => item.id === requestId)!;
    if (providerId) {
      assert(!message.providerId || message.providerId === providerId, "Provider message IDs differ. Reconcile this send.", 409);
      message.providerId = providerId; message.dispatchState = "accepted";
    }
    // Acceptance is not a signed 'sent' event. A callback may already have won
    // this race, including a failed delivery; keep that verified outcome.
    if (!message.statusAt) message.status = workspace.demo ? "demo" : "accepted";
    if (workspace.demo) {
      const lead = findLead(workspace, leadId); lead.lastContactAt = laterTimestamp(lead.lastContactAt, isoNow());
      if (lead.stage === "New") lead.stage = "Contacted";
    }
    for (const job of workspace.jobs.filter(item => item.messageId === requestId)) { job.status = message.status === "demo" ? "demo" : message.status === "failed" ? "failed" : ["sent", "delivered", "read"].includes(message.status) ? "sent" : "accepted"; job.lockedAt = null; job.error = message.error; }
    addActivity(workspace, workspace.demo ? "Demo reply saved · no external delivery" : "WhatsApp accepted the message · awaiting signed delivery status", "message", leadId);
  })).workspace;
}
async function recordSendError(workspaceId: string, requestId: string, error: unknown, claim?: Job) {
  await mutateWorkspace(workspaceId, workspace => {
    if (claim && workspace.jobs.find(job => job.id === claim.id)?.attempts !== claim.attempts) return;
    const message = workspace.messages.find(item => item.id === requestId);
    if (!message || message.providerId || message.statusAt) return;
    const rejected = error instanceof MetaRequestError && error.rejected;
    const uncertain = Boolean(message.dispatchedAt && !rejected);
    message.status = uncertain ? "reconcile" : "failed";
    if (message.dispatchedAt) message.dispatchState = rejected ? "rejected" : "uncertain";
    message.error = uncertain ? "Acceptance is uncertain. Await signed WhatsApp status; this request will not be resent automatically." : errorText(error);
  });
}

export async function sendReply(workspaceId: string, leadId: string, body: string, requestId: string, options: ReplyOptions = {}) {
  if (options.actor) authorizeRecordAction(await loadWorkspace(workspaceId), options.actor, { type: "message.send", leadId, ...(options.fileId ? { fileId: options.fileId } : {}) });
  await requirePaidCapability(workspaceId);
  const claim = await mutateWorkspace(workspaceId, workspace => {
    const lead = findLead(workspace, leadId);
    if (options.actor) authorizeRecordAction(workspace, options.actor, { type: "message.send", leadId, ...(options.fileId ? { fileId: options.fileId } : {}) });
    const existing = workspace.messages.find(message => message.id === requestId);
    if (existing) {
      assert(existing.leadId === leadId && existing.body === body && existing.fileId === options.fileId && existing.direction === "outbound" && (!existing.authorId || existing.authorId === options.actor?.id || options.autonomous), "This requestId is already bound to a different message.", 409);
      if (!options.job || existing.providerId || messageUncertain(existing)) return false;
    }
    assertWorkspaceCapability(workspace);
    checkReply(workspace, lead, Boolean(options.autonomous), options.sourceMessageId);
    if (options.job && !jobMatches(workspace.jobs.find(item => item.id === options.job!.id), options.job)) throw new DispatchBlocked("The reply job is no longer active.");
    if (options.fileId) assertMessageFile(workspace, leadId, options.fileId, options.actor);
    if (!existing) {
      workspace.messages = workspace.messages.filter(message => !(message.leadId === leadId && message.status === "draft"));
      workspace.messages.push({ id: requestId, leadId, body, direction: "outbound", author: options.actor?.name || options.author || workspace.userName, authorId: options.actor?.id, status: "queued", createdAt: isoNow(), fileId: options.fileId, source: options.source, voiceFallback: options.voiceFallback });
    } else { existing.status = "queued"; existing.error = undefined; }
    if (!options.autonomous) { lead.humanOwned = true; stopJobs(workspace, leadId); }
    lead.unread = false;
    return true;
  });
  if (!claim.result) return claim.workspace;
  const snapshot = claim.workspace, lead = findLead(snapshot, leadId), message = snapshot.messages.find(item => item.id === requestId)!;
  const guard = dispatchGuard(workspaceId, snapshot, lead, requestId, options, latestInbound(snapshot, lead)?.id);
  try {
    let providerId: string | undefined;
    if (snapshot.demo) await guard({ body });
    else {
      try { providerId = await sendText(snapshot, lead, message, guard); }
      catch (error) {
        const current = await loadWorkspace(workspaceId), stored = current.messages.find(item => item.id === requestId)!;
        if (!options.voiceAudio || !message.fileId || stored.dispatchedAt || stored.providerId || error instanceof DispatchBlocked || error instanceof SubscriptionRestricted) throw error;
        // Media upload/STT/TTS failures occur before /messages. Falling back here
        // is safe; a timeout after /messages must never cause a second send.
        await mutateWorkspace(workspaceId, workspace => {
          const item = workspace.messages.find(item => item.id === requestId)!;
          item.fileId = undefined; item.mediaType = undefined; item.voiceFallback = `Voice attachment unavailable; text fallback prepared. ${errorText(error)}`;
          addActivity(workspace, "Voice attachment failed before dispatch · using text fallback", "message", leadId);
        });
        const fallback = { ...message, fileId: undefined, mediaType: undefined };
        providerId = await sendText(snapshot, lead, fallback, guard);
      }
    }
    return await recordAccepted(workspaceId, leadId, requestId, providerId);
  } catch (error) { await recordSendError(workspaceId, requestId, error, options.job); throw error; }
}

export async function transcribeMessage(workspace: Workspace, message: Message) {
  assert(!workspace.demo, "Demo workspaces do not download provider media.", 409);
  if (message.mediaType !== "audio") return message.body;
  await requirePaidCapability(workspace.id);
  assert(message.providerMediaId && /^\d+$/.test(message.providerMediaId), "The voice note has no valid downloadable media ID.");
  const token = (await credentials(workspace, "whatsapp")).accessToken;
  const media = await graph<{ url: string; mime_type: string; file_size: number }>(message.providerMediaId, token);
  const url = new URL(media.url);
  const mime = media.mime_type?.split(";")[0].trim().toLowerCase();
  assert(url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") && [".facebook.com", ".fbcdn.net", ".fbsbx.com"].some(host => url.hostname.endsWith(host)) && Number.isSafeInteger(media.file_size) && media.file_size > 0 && media.file_size <= MAX_FILE_SIZE && mime?.startsWith("audio/"), "Voice note is not available for automatic transcription.");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(20000) });
  assert(response.ok, "The voice note could not be downloaded.", 502);
  const bytes = await readLimitedBytes(response, Math.min(media.file_size, MAX_FILE_SIZE));
  assert(bytes.length === media.file_size, "The voice note size does not match its metadata.");
  const { transcribe } = await import("./providers/speech");
  return transcribe(workspace, bytes, mime);
}

class CalendarConflict extends AppError { constructor() { super("That time is busy in the connected Google calendar. Choose another slot.", 409); } }
function calendarBinding(workspace: Workspace) {
  const connection = connectionFor(workspace, "google");
  return connection ? JSON.stringify([connection.id, connection.externalId, connection.updatedAt, connection.metadata.calendarId || "primary", connection.secret]) : "";
}
function appointmentVersion(appointment: Appointment) { return JSON.stringify([calendarSyncKey(appointment), appointment.externalId || calendarEventId(appointment.id)]); }
const googleEventTime = z.object({ dateTime: z.iso.datetime({ offset: true }).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const googleEventPage = z.object({ nextPageToken: z.string().max(4000).optional(), items: z.array(z.object({
  id: z.string(), status: z.string().optional(), transparency: z.string().optional(), start: googleEventTime.optional(), end: googleEventTime.optional(),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
})).max(250).default([]) });

/** Free/busy merges intervals and has no event IDs. Never subtract an old local
 * range: a different event could occupy the same time. Read the bounded event
 * window and exclude only the exact, tenant/appointment-bound Google event. */
async function onlyExistingAppointmentIsBusy(workspace: Workspace, proposal: AppointmentProposal, appointment: Appointment) {
  assert(!workspace.demo, "Demo workspaces do not query live calendar events.", 409);
  const connection = connectionFor(workspace, "google");
  assert(connection && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET, "Google Calendar is not configured.", 503);
  const { refreshToken } = await credentials(workspace, "google");
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
  assert(tokenResponse.ok, "Google Calendar authorization could not be refreshed. Reconnect or retry.", tokenResponse.status >= 500 || tokenResponse.status === 429 ? 503 : 409);
  const { access_token: token } = z.object({ access_token: z.string().min(1) }).parse(JSON.parse(await readLimitedText(tokenResponse, 64000)));
  const expectedId = appointment.externalId || calendarEventId(appointment.id);
  const end = new Date(Date.parse(proposal.startsAt) + proposal.duration * 60000).toISOString();
  let pageToken: string | undefined, foundExisting = false;
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({ timeMin: proposal.startsAt, timeMax: end, singleEvents: "true", showDeleted: "false", maxResults: "250", fields: "items(id,status,transparency,start,end,extendedProperties),nextPageToken", ...(pageToken ? { pageToken } : {}) });
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.metadata.calendarId || "primary")}/events?${params}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
    assert(response.ok, "Google event availability could not be verified. Retry before rescheduling.", 502);
    const result = googleEventPage.parse(JSON.parse(await readLimitedText(response, 1_000_000)));
    for (const event of result.items) {
      if (event.status === "cancelled" || event.transparency === "transparent") continue;
      let overlaps: boolean;
      if (event.start?.dateTime && event.end?.dateTime) {
        assert(Date.parse(event.end.dateTime) > Date.parse(event.start.dateTime), "Google returned an invalid busy interval.", 502);
        overlaps = overlapsBusy(proposal.startsAt, proposal.duration, [{ start: event.start.dateTime, end: event.end.dateTime }]);
      } else if (event.start?.date && event.end?.date) {
        assert(event.end.date > event.start.date, "Google returned an invalid all-day interval.", 502);
        overlaps = true; // Google filtered this all-day event into the requested window.
      }
      else throw new AppError("Google did not return enough event data to exclude this conflict safely.", 502);
      if (!overlaps) continue;
      const binding = event.extendedProperties?.private;
      if (event.id === expectedId && binding?.admitflowWorkspaceId === workspace.id && binding.admitflowAppointmentId === appointment.id) { foundExisting = true; continue; }
      return false;
    }
    pageToken = result.nextPageToken;
    if (!pageToken) return foundExisting;
  }
  throw new AppError("This calendar window has too many events to verify safely. Review the calendar before rescheduling.", 502);
}

const aiBookingPlan = z.object({ booking: z.object({ startsAt: z.iso.datetime(), owner: z.string().min(1).max(100), ownerId: z.string().min(1).max(200).optional() }), handoff: z.boolean().optional() });
function aiBookingContext(workspace: Workspace, job: Job) {
  assertWorkspaceCapability(workspace);
  const parent = workspace.jobs.find(item => item.id === job.payload?.replyJobId && item.kind === "ai.reply" && item.leadId === job.leadId && item.sourceMessageId === job.sourceMessageId);
  assert(parent?.payload?.replyPlan, "The proposed booking no longer has a valid reply context.", 409);
  const message = workspace.messages.find(item => item.id === parent.messageId && item.leadId === job.leadId);
  if (!message || !["accepted", "sent", "delivered", "read", "demo"].includes(message.status)) throw new DispatchBlocked("The booking proposal's reply has not been accepted.");
  checkReply(workspace, findLead(workspace, job.leadId), true, job.sourceMessageId);
  return { parent, plan: aiBookingPlan.parse(JSON.parse(parent.payload.replyPlan)) };
}

interface BookingOptions { actor?: Actor; job?: Job; snapshot?: Workspace }
/** Async orchestration only: provider reads happen outside the synchronous
 * aggregate transaction. Authorization, claim/version checks and local clashes
 * are checked again under the organization lock before accepting the slot. */
export async function bookAppointment(workspaceId: string, action: Record<string, unknown>, options: BookingOptions) {
  assert(options.actor || options.job?.kind === "appointment.book", "A booking actor or authorized automation job is required.", 403);
  const snapshot = options.snapshot || await loadWorkspace(workspaceId);
  assert(snapshot.id === workspaceId, "Workspace mismatch.", 403);
  const request = { ...action };
  if (options.actor?.role === "counsellor" && request.type === "appointment.create" && request.owner === undefined && request.ownerId === undefined) request.ownerId = actorOwnerId(snapshot, options.actor);
  function authorize(workspace: Workspace) {
    if (options.actor) authorizeRecordAction(workspace, options.actor, request);
    if (options.job) {
      const stored = workspace.jobs.find(job => job.id === options.job!.id);
      if (!jobMatches(stored, options.job)) throw new DispatchBlocked("This booking job was cancelled or recovered by another worker.");
      const { plan } = aiBookingContext(workspace, stored!);
      assert(request.type === "appointment.create" && request.leadId === stored!.leadId && request.startsAt === plan.booking.startsAt && request.owner === plan.booking.owner && request.ownerId === plan.booking.ownerId && request.duration === 30 && request.kind === "Counselling", "The booking does not match the accepted proposal.", 409);
    }
  }
  authorize(snapshot);
  let proposal: AppointmentProposal;
  try { proposal = appointmentProposal(snapshot, request); }
  catch (error) { if (error instanceof z.ZodError || error instanceof AppError) throw error; throw new AppError((error as Error).message); }
  const existing = proposal.id ? snapshot.appointments.find(appointment => appointment.id === proposal.id)! : undefined;
  const priorVersion = existing ? appointmentVersion(existing) : undefined;
  const binding = calendarBinding(snapshot), usesGoogle = !snapshot.demo && Boolean(binding);
  let checkedAt = isoNow(), excludedExistingEvent = false;
  if (usesGoogle) {
    const end = new Date(Date.parse(proposal.startsAt) + proposal.duration * 60000).toISOString();
    const availability = await calendarBusy(workspaceId, proposal.startsAt, end);
    assert(availability.connected, "The calendar connection changed while checking availability. Retry the booking.", 409);
    if (overlapsBusy(proposal.startsAt, proposal.duration, availability.busy)) {
      if (!existing || !(await onlyExistingAppointmentIsBusy(snapshot, proposal, existing))) throw new CalendarConflict();
      excludedExistingEvent = true;
    }
    checkedAt = isoNow();
  }
  const normalized = request.type === "appointment.create" ? { type: request.type, ...proposal } : { type: request.type, id: proposal.id, startsAt: proposal.startsAt, owner: proposal.owner, ownerId: proposal.ownerId };
  return mutateWorkspace(workspaceId, current => {
    authorize(current);
    assert(current.demo === snapshot.demo && calendarBinding(current) === binding, "The calendar connection changed. Check the slot again.", 409);
    if (usesGoogle) assert(Date.now() - Date.parse(checkedAt) < 30_000, "The calendar availability check expired. Check the slot again.", 409);
    if (existing) {
      const appointment = current.appointments.find(item => item.id === existing.id);
      assert(appointment && appointmentVersion(appointment) === priorVersion, "The appointment changed while availability was checked. Refresh and retry.", 409);
    }
    const previousActor = current.actor;
    if (options.actor) current.actor = options.actor;
    try {
      // Complete this claim atomically with the appointment so stopJobs cannot
      // cancel the booking itself when the conversation becomes human-owned.
      const bookingJob = options.job ? current.jobs.find(job => job.id === options.job!.id)! : undefined;
      if (bookingJob) { bookingJob.status = current.demo ? "demo" : "sent"; bookingJob.lockedAt = null; }
      const result = applyAction(current, normalized) as { appointmentId?: string };
      const appointmentId = result?.appointmentId || proposal.id!;
      const appointment = current.appointments.find(item => item.id === appointmentId)!;
      appointment.syncStatus = usesGoogle ? "pending" : "local";
      if (bookingJob) {
        bookingJob.payload = { ...bookingJob.payload, appointmentId, availabilityCheckedAt: checkedAt };
        const parent = current.jobs.find(job => job.id === bookingJob.payload!.replyJobId)!;
        parent.payload = { ...parent.payload, bookingState: "booked", bookingAppointmentId: appointmentId };
      }
      return { appointmentId, syncStatus: appointment.syncStatus, availability: { source: usesGoogle ? "google" : "local", checkedAt, excludedExistingEvent } };
    } catch (error) { if (error instanceof z.ZodError || error instanceof AppError) throw error; throw new AppError((error as Error).message); }
    finally { current.actor = previousActor; }
  });
}

function applyReplyPlan(workspace: Workspace, job: Job) {
  if (job.kind !== "ai.reply" || !job.payload?.replyPlan || job.payload.planApplied === "true") return;
  const message = workspace.messages.find(item => item.id === job.messageId);
  if (!message || !["accepted", "sent", "delivered", "read", "demo"].includes(message.status)) return;
  job.payload.planApplied = "true";
  const lead = findLead(workspace, job.leadId);
  if (!workspaceCapabilities(workspace).allowed) { lead.humanOwned = true; stopJobs(workspace, lead.id); return; }
  if (lead.humanOwned || workspace.ai?.mode !== "autonomous" || latestInbound(workspace, lead)?.id !== job.sourceMessageId || lead.consent === "opted_out") return;
  const plan = JSON.parse(job.payload.replyPlan) as Awaited<ReturnType<typeof generateReply>>;
  lead.nextAction = plan.nextAction;
  if (plan.qualified && ["New", "Contacted"].includes(lead.stage)) lead.stage = "Qualified";
  if (plan.booking) {
    const bookingJob = { id: uid(), leadId: lead.id, campaignId: "", kind: "appointment.book" as const, sourceMessageId: job.sourceMessageId, step: 0, dueAt: isoNow(), status: "pending" as const, payload: { replyJobId: job.id } };
    workspace.jobs.push(bookingJob);
    job.payload.bookingState = "pending"; job.payload.bookingJobId = bookingJob.id;
    lead.nextAction = "Checking the requested counselling slot";
    addActivity(workspace, "AI booking proposed · awaiting calendar availability", "appointment", lead.id);
    return;
  }
  if (plan.handoff) { lead.humanOwned = true; lead.nextAction = "Counsellor review requested by assistant"; stopJobs(workspace, lead.id); }
}

export async function processJob(workspaceId: string, jobId: string) {
  const snapshot = await loadWorkspace(workspaceId), candidate = snapshot.jobs.find(item => item.id === jobId);
  let subscriptionError: unknown;
  if (candidate?.status === "pending" && jobCapability(candidate)) {
    try { await requirePaidCapability(workspaceId); } catch (error) { subscriptionError = error; }
  }
  const claim = await mutateWorkspace(workspaceId, workspace => {
    const job = workspace.jobs.find(item => item.id === jobId);
    if (!job || job.status !== "pending" || Date.parse(job.dueAt) > Date.now()) return null;
    const existing = workspace.messages.find(message => message.id === job.messageId);
    if (existing?.providerId || messageUncertain(existing)) { job.status = existing?.providerId ? "accepted" : "reconcile"; return null; }
    if (jobCapability(job) && (subscriptionError || !workspaceCapabilities(workspace).allowed)) {
      job.status = "failed"; job.lockedAt = null; job.error = subscriptionError ? errorText(subscriptionError) : workspaceCapabilities(workspace).message;
      job.payload = { ...job.payload, blockedReason: "subscription" };
      if (existing && !existing.dispatchedAt) { existing.status = "failed"; existing.error = job.error; }
      return null;
    }
    try {
      if (!job.kind || ["followup", "reminder"].includes(job.kind)) checkFollowup(workspace, job, findLead(workspace, job.leadId));
      if (job.kind === "ai.reply") {
        checkReply(workspace, findLead(workspace, job.leadId), true, job.sourceMessageId);
        if (!existing && usedAiMessages(workspace) + reservedAiReplies(workspace) >= workspace.ai!.dailyLimit) { job.status = "failed"; job.error = "The institute's daily AI reply limit has been reached."; return null; }
      }
      if (job.kind === "appointment.book") aiBookingContext(workspace, job);
    } catch (error) {
      if (!(error instanceof DispatchBlocked)) {
        if (job.kind !== "appointment.book") throw error;
        job.status = "failed"; job.error = "The proposed booking details are no longer valid. Ask a counsellor to confirm the slot.";
        const parent = workspace.jobs.find(item => item.id === job.payload?.replyJobId);
        if (parent?.payload) parent.payload.bookingState = "failed";
        return null;
      }
      if (!error.deferred) cancelUndispatchedJob(workspace, job);
      job.error = error.message;
      if (job.kind === "appointment.book") { const parent = workspace.jobs.find(item => item.id === job.payload?.replyJobId); if (parent?.payload) parent.payload.bookingState = "cancelled"; }
      return null;
    }
    if (existing?.dispatchState === "rejected") { existing.dispatchedAt = undefined; existing.dispatchState = undefined; job.dispatchedAt = null; }
    job.status = "processing"; job.lockedAt = isoNow(); job.attempts = (job.attempts || 0) + 1;
    return structuredClone(job);
  });
  const job = claim.result;
  if (!job) return false;
  try {
    let workspace = claim.workspace;
    if (job.kind === "appointment.book") {
      const { plan } = aiBookingContext(workspace, job);
      await bookAppointment(workspaceId, { type: "appointment.create", leadId: job.leadId, ...plan.booking, duration: 30, kind: "Counselling" }, { job, snapshot: workspace });
    } else if (["file.ingest", "calendar.sync", "knowledge.index"].includes(job.kind || "")) {
      if (!workspace.demo) {
        if (job.kind === "file.ingest") await ingestDocument(workspaceId, job.payload!.fileId);
        else if (job.kind === "calendar.sync") { const { syncAppointment } = await import("./providers/calendar"); await syncAppointment(workspaceId, job.payload!.appointmentId); }
        else {
          const { indexKnowledgeEmbeddings } = await import("./db/knowledge");
          const result = await indexKnowledgeEmbeddings(workspaceId, job.payload!.articleId);
          await mutateWorkspace(workspaceId, current => { const stored = current.jobs.find(item => item.id === jobId)!; if (jobMatches(stored, job)) stored.payload = { ...stored.payload, retrievalMode: result.retrievalMode, ...(result.retrievalNote ? { retrievalNote: result.retrievalNote } : {}) }; });
        }
      }
      await mutateWorkspace(workspaceId, current => {
        const stored = current.jobs.find(item => item.id === jobId);
        if (jobMatches(stored, job)) {
          stored!.status = current.demo ? "demo" : "sent"; stored!.lockedAt = null; stored!.error = undefined;
          if (current.demo && job.kind === "calendar.sync") { const appointment = current.appointments.find(item => item.id === job.payload?.appointmentId); if (appointment) appointment.syncStatus = "local"; }
        }
      });
    } else if (job.kind === "ai.reply") {
      const lead = findLead(workspace, job.leadId), incoming = workspace.messages.find(message => message.id === job.sourceMessageId && message.leadId === lead.id && message.direction === "inbound");
      assert(incoming, "Incoming message is no longer available.");
      const requestId = job.messageId || job.id;
      let message = workspace.messages.find(item => item.id === requestId);
      if (!message) {
        let question = incoming.body, transcriptionError: unknown;
        if (!workspace.demo && incoming.mediaType === "audio") {
          try { question = await transcribeMessage(workspace, incoming); }
          catch (error) { if (error instanceof SubscriptionRestricted) throw error; transcriptionError = error; }
        }
        if (question !== incoming.body) await mutateWorkspace(workspaceId, current => { const stored = current.messages.find(item => item.id === incoming.id); if (stored) stored.body = question; });
        const draft = transcriptionError ? { body: "I couldn't read your voice note clearly. Could you send your question as text? A counsellor can also help.", source: "Voice transcription unavailable", sourceIds: [], handoff: true, nextAction: "Review the student's voice note", qualified: false, booking: null, mode: "Text fallback" } : await generateReply(workspace, lead, question);
        await mutateWorkspace(workspaceId, current => {
          const stored = current.jobs.find(item => item.id === jobId);
          if (!jobMatches(stored, job)) throw new DispatchBlocked("The reply job is no longer active.");
          assertWorkspaceCapability(current);
          checkReply(current, findLead(current, lead.id), true, incoming.id);
          stored!.messageId = requestId; stored!.payload = { ...stored!.payload, replyPlan: JSON.stringify(draft) };
          current.messages.push({ id: requestId, leadId: lead.id, body: draft.body, source: draft.source, direction: "outbound", author: "AdmitFlow AI", status: "queued", createdAt: isoNow(), ...(transcriptionError ? { voiceFallback: `Transcription unavailable; text fallback prepared. ${errorText(transcriptionError)}` } : {}) });
        });
        if (!workspace.demo && incoming.mediaType === "audio" && workspace.ai?.voiceReplies && !transcriptionError) {
          try {
            const { synthesize } = await import("./providers/speech");
            const bytes = await synthesize(workspace, draft.body);
            const file = await saveGeneratedAudio(workspaceId, lead.id, bytes, requestId);
            await mutateWorkspace(workspaceId, current => {
              if (!jobMatches(current.jobs.find(item => item.id === jobId), job)) throw new DispatchBlocked("Voice processing was superseded by a newer worker or incoming message.");
              const stored = current.messages.find(item => item.id === requestId)!;
              assert(!stored.dispatchedAt, "This message has already been dispatched.", 409);
              stored.fileId = file.id; stored.mediaType = "audio";
            });
          } catch (error) {
            if (error instanceof DispatchBlocked || error instanceof SubscriptionRestricted) throw error;
            await mutateWorkspace(workspaceId, current => {
              if (!jobMatches(current.jobs.find(item => item.id === jobId), job)) throw new DispatchBlocked("Voice processing is no longer active.");
              current.messages.find(item => item.id === requestId)!.voiceFallback = `Voice generation unavailable; text fallback prepared. ${errorText(error)}`; addActivity(current, "Voice generation failed · using text fallback", "message", lead.id);
            });
          }
        }
        workspace = await loadWorkspace(workspaceId); message = workspace.messages.find(item => item.id === requestId)!;
      } else if (!workspace.demo && incoming.mediaType === "audio" && workspace.ai?.voiceReplies && !message.fileId && !message.voiceFallback) {
        const audio = workspace.files?.find(file => file.id === requestId && file.leadId === lead.id && file.status === "ready" && file.mime === "audio/mpeg");
        await mutateWorkspace(workspaceId, current => {
          if (!jobMatches(current.jobs.find(item => item.id === jobId), job)) throw new DispatchBlocked("The reply job is no longer active.");
          const stored = current.messages.find(item => item.id === requestId)!;
          if (audio) { stored.fileId = audio.id; stored.mediaType = "audio"; }
          else stored.voiceFallback = "Voice processing was interrupted before dispatch; text fallback prepared.";
        });
        message = (await loadWorkspace(workspaceId)).messages.find(item => item.id === requestId)!;
      }
      await sendReply(workspaceId, lead.id, message.body, requestId, { author: "AdmitFlow AI", autonomous: true, sourceMessageId: incoming.id, source: message.source, fileId: message.fileId, voiceAudio: message.mediaType === "audio", voiceFallback: message.voiceFallback, job });
      await mutateWorkspace(workspaceId, current => applyReplyPlan(current, current.jobs.find(item => item.id === jobId)!));
    } else {
      const lead = findLead(workspace, job.leadId), campaign = workspace.campaigns.find(item => item.id === job.campaignId)!;
      const requestId = job.messageId || job.id;
      const body = campaign.message.replaceAll("{name}", lead.name.split(" ")[0]).replaceAll("{course}", lead.course).replaceAll("{institute}", workspace.name);
      await mutateWorkspace(workspaceId, current => {
        const stored = current.jobs.find(item => item.id === jobId);
        if (!jobMatches(stored, job)) throw new DispatchBlocked("The campaign job is no longer active.");
        checkFollowup(current, stored!, findLead(current, lead.id));
        stored!.messageId = requestId;
        const message = current.messages.find(item => item.id === requestId);
        if (!message) current.messages.push({ id: requestId, leadId: lead.id, body, direction: "outbound", author: "AdmitFlow AI", createdAt: isoNow(), status: "queued" });
        else { assert(message.leadId === lead.id && !message.dispatchedAt && !message.providerId, "The existing message cannot be retried.", 409); message.status = "queued"; message.error = undefined; }
      });
      const guard = dispatchGuard(workspaceId, workspace, lead, requestId, { job }, latestInbound(workspace, lead)?.id, true);
      let providerId: string | undefined;
      try {
        if (workspace.demo) await guard({ body });
        else providerId = (await sendTemplate(workspace, lead, campaign.templateName || connectionFor(workspace, "whatsapp")?.metadata.templateName || "", campaign.templateLanguage || connectionFor(workspace, "whatsapp")?.metadata.templateLanguage || "en", requestId, guard)).providerId;
        await recordAccepted(workspaceId, lead.id, requestId, providerId);
      } catch (error) { await recordSendError(workspaceId, requestId, error, job); throw error; }
    }
    return true;
  } catch (error) {
    await mutateWorkspace(workspaceId, current => {
      const stored = current.jobs.find(item => item.id === jobId)!;
      if (stored.attempts !== job.attempts || ["sent", "demo", "accepted"].includes(stored.status)) return;
      const message = current.messages.find(item => item.id === stored.messageId);
      if (message?.providerId) stored.status = message.status === "failed" ? "failed" : ["sent", "delivered", "read"].includes(message.status) ? "sent" : "accepted";
      else if (messageUncertain(message)) stored.status = "reconcile";
      else if (stored.status === "cancelled") { stored.lockedAt = null; }
      else if (error instanceof SubscriptionRestricted) { stored.status = "failed"; stored.payload = { ...stored.payload, blockedReason: "subscription" }; }
      else if (error instanceof DispatchBlocked) { stored.status = error.deferred ? "pending" : "cancelled"; if (error.deferred) stored.dueAt = new Date(Date.now() + 30_000).toISOString(); }
      else if ((stored.attempts || 0) < RETRY_LIMIT && transient(error)) { stored.status = "pending"; stored.dueAt = new Date(Date.now() + 5000 * 2 ** ((stored.attempts || 1) - 1)).toISOString(); stored.dispatchedAt = null; }
      else stored.status = "failed";
      if (message && !message.dispatchedAt && !message.providerId && ["cancelled", "failed"].includes(stored.status)) { message.status = "failed"; message.error = errorText(error); }
      stored.error = message?.status === "reconcile" ? message.error : errorText(error); stored.lockedAt = null;
      if (job.kind === "ai.reply" && stored.status === "failed") findLead(current, job.leadId).nextAction = "Assistant needs attention";
      if (job.kind === "file.ingest") { const file = current.files?.find(item => item.id === job.payload?.fileId); if (file) file.error = stored.error; }
      if (job.kind === "appointment.book") {
        const parent = current.jobs.find(item => item.id === job.payload?.replyJobId);
        if (parent?.payload) parent.payload.bookingState = stored.status === "pending" ? "pending" : stored.status === "cancelled" ? "cancelled" : error instanceof CalendarConflict ? "conflict" : "failed";
        if (stored.status === "failed") {
          const lead = findLead(current, job.leadId); lead.humanOwned = true;
          lead.nextAction = error instanceof CalendarConflict ? "Requested slot is busy; choose another counselling time" : "Counsellor to confirm the requested appointment";
          stopJobs(current, lead.id);
          addActivity(current, `AI booking needs attention · ${stored.error}`, "appointment", lead.id);
        }
      }
    });
    return false;
  }
}

/** Queue state is disposable; this recovery uses only the durable outbox. */
export function recoverWorkspaceJobs(workspace: Workspace, now = Date.now()) {
  let recovered = 0;
  for (const job of workspace.jobs) {
    applyReplyPlan(workspace, job);
    if (job.status !== "processing" || (job.lockedAt && Number.isFinite(Date.parse(job.lockedAt)) && now - Date.parse(job.lockedAt) < JOB_LOCK_MS)) continue;
    const message = workspace.messages.find(item => item.id === job.messageId);
    if (message?.providerId || message?.statusAt) job.status = message.status === "failed" ? "failed" : ["sent", "delivered", "read"].includes(message.status) ? "sent" : "accepted";
    else if (messageUncertain(message) || (job.dispatchedAt && message?.dispatchState !== "rejected")) { job.status = "reconcile"; if (message) { message.status = "reconcile"; message.dispatchState = "uncertain"; } }
    else if (jobCapability(job) && !workspaceCapabilities(workspace).allowed) { job.status = "failed"; job.payload = { ...job.payload, blockedReason: "subscription" }; }
    else if ((job.attempts || 0) < RETRY_LIMIT) { job.status = "pending"; job.dueAt = new Date(now).toISOString(); job.dispatchedAt = null; }
    else job.status = "failed";
    job.error = job.status === "reconcile" ? "Worker interrupted after dispatch. Await signed provider status; no automatic resend." : job.status === "pending" ? "Worker interrupted before dispatch; safely re-enqueued." : job.status === "failed" ? job.payload?.blockedReason === "subscription" ? "Subscription access is restricted. Review before explicitly retrying." : "The bounded retry limit was reached." : undefined;
    if (job.kind === "appointment.book" && job.status === "failed") {
      const parent = workspace.jobs.find(item => item.id === job.payload?.replyJobId);
      if (parent?.payload) parent.payload.bookingState = "failed";
      const lead = workspace.leads.find(item => item.id === job.leadId);
      if (lead) { lead.humanOwned = true; lead.nextAction = "Counsellor to confirm the requested appointment"; }
    }
    job.lockedAt = null; recovered++;
  }
  // A web process can also stop midway through a manual send. Never strand an
  // ambiguous request as 'queued', and never silently replay it on refresh.
  for (const message of workspace.messages) if (message.status === "queued" && now - Date.parse(message.createdAt) >= JOB_LOCK_MS && !workspace.jobs.some(job => job.messageId === message.id && ["pending", "processing"].includes(job.status))) {
    message.status = messageUncertain(message) ? "reconcile" : "failed";
    message.error = message.status === "reconcile" ? "Web process interrupted after dispatch. Await signed WhatsApp status." : "Web process interrupted before dispatch. Prepare a new request to send.";
  }
  return recovered;
}
export async function processJobs(workspaceId: string) {
  const { workspace } = await mutateWorkspace(workspaceId, current => recoverWorkspaceJobs(current));
  const due = workspace.jobs.filter(job => job.status === "pending" && Date.parse(job.dueAt) <= Date.now()).slice(0, 25);
  let processed = 0;
  for (const job of due) if (await processJob(workspaceId, job.id)) processed++;
  return { processed };
}
