import { z } from "zod";
import { type Workspace, type Lead, type Consent, type Appointment, STAGES, LEAD_VIEWS, LEAD_SORTS, uid, isoNow, normalizePhone, recoverableLeads, stopJobs, cancelUndispatchedJob, addActivity, appointmentClashes, HOUR, hydrateWorkspace, resolveOwner } from "./domain";

const text = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 2000) => z.string().trim().max(max).default("");
const consent = z.enum(["opted_in", "unknown", "opted_out"]);
const leadInput = z.object({
  name: text(100), phone: text(30), email: z.union([z.email(), z.literal("")]).default(""),
  course: optionalText(100), source: optionalText(100), owner: optionalText(100), ownerId: z.string().min(1).max(200).nullable().optional(),
  value: z.coerce.number().int().min(0).max(10000000).default(0), notes: optionalText(5000),
  consent: consent.default("unknown"), consentSource: optionalText(200),
  isMinor: z.boolean().default(false), guardianConsent: z.boolean().default(false),
});
export function findLead(workspace: Workspace, id: string) {
  const lead = workspace.leads.find(item => item.id === id);
  if (!lead) throw new Error("This enquiry was not found in your workspace. Refresh the page.");
  return lead;
}

function buildLead(workspace: Workspace, input: z.infer<typeof leadInput>): Lead {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error("Phone number is invalid. Use 10 Indian digits or an international +country code.");
  if (input.consent === "opted_in" && !input.consentSource) throw new Error("Add where and how WhatsApp opt-in was obtained.");
  const course = input.course || "Undecided";
  if (!workspace.courses.includes(course) && course !== "Undecided") workspace.courses.push(course);
  return { ...input, ...resolveOwner(workspace, input), phone, id: uid(), course, source: input.source || "Manual", stage: "New", nextAction: "Make first contact", createdAt: isoNow(), lastContactAt: null, lastInboundAt: null, humanOwned: workspace.ai?.mode !== "autonomous", consentAt: input.consent !== "unknown" ? isoNow() : null };
}

const appointmentCreateInput = z.object({ leadId: z.uuid(), owner: text(100).optional(), ownerId: z.string().min(1).max(200).optional(), startsAt: z.iso.datetime(), duration: z.number().int().min(15).max(120), kind: z.enum(["Counselling", "Demo class", "Campus visit"]) });
const appointmentRescheduleInput = z.object({ id: z.uuid(), startsAt: z.iso.datetime(), owner: text(100).optional(), ownerId: z.string().min(1).max(200).optional() });
export type AppointmentProposal = Pick<Appointment, "leadId" | "owner" | "ownerId" | "startsAt" | "duration" | "kind"> & { id?: string };
/** Pure local validation shared with the async API/worker calendar preflight. */
export function appointmentProposal(workspace: Workspace, action: Record<string, unknown>): AppointmentProposal {
  let proposal: AppointmentProposal;
  if (action.type === "appointment.create") {
    const input = appointmentCreateInput.parse(action);
    proposal = { ...input, ...resolveOwner(workspace, input) };
  } else if (action.type === "appointment.reschedule") {
    const input = appointmentRescheduleInput.parse(action);
    const appointment = workspace.appointments.find(item => item.id === input.id);
    if (!appointment) throw new Error("Appointment not found.");
    const assignment = resolveOwner(workspace, input.owner !== undefined || input.ownerId !== undefined ? input : { ownerId: appointment.ownerId || undefined, owner: appointment.owner });
    proposal = { id: appointment.id, leadId: appointment.leadId, kind: appointment.kind, duration: appointment.duration, startsAt: input.startsAt, ...assignment };
  } else throw new Error("Unsupported appointment action.");
  findLead(workspace, proposal.leadId);
  if (!Number.isFinite(Date.parse(proposal.startsAt)) || Date.parse(proposal.startsAt) <= Date.now()) throw new Error("Choose an appointment time in the future.");
  const others = proposal.id ? { ...workspace, appointments: workspace.appointments.filter(item => item.id !== proposal.id) } : workspace;
  if (appointmentClashes(others, proposal.owner, proposal.startsAt, proposal.duration, proposal.ownerId)) throw new Error(`${proposal.owner} already has an appointment then. Choose another time.`);
  return proposal;
}

export function applyAction(workspace: Workspace, action: Record<string, unknown>): unknown {
  hydrateWorkspace(workspace);
  return applyHydratedAction(workspace, action);
}

/** Internal dispatch only: the public boundary hydrates exactly once. */
function applyHydratedAction(workspace: Workspace, action: Record<string, unknown>): unknown {
  switch (action.type) {
    case "lead.create": {
      const input = leadInput.parse(action.lead);
      const phone = normalizePhone(input.phone);
      if (workspace.leads.some(lead => lead.phone === phone)) throw new Error("This phone number already exists. Open the existing enquiry instead.");
      const lead = buildLead(workspace, input);
      workspace.leads.unshift(lead);
      addActivity(workspace, `${lead.name} added to enquiries`, "lead", lead.id);
      return { leadId: lead.id };
    }
    case "lead.import": {
      const rows = z.array(z.record(z.string(), z.unknown())).min(1).max(1000).parse(action.rows);
      const phones = new Set(workspace.leads.map(lead => lead.phone));
      const errors: { row: number; error: string }[] = [];
      let imported = 0, duplicates = 0;
      for (const [index, raw] of rows.entries()) {
        try {
          const input = leadInput.parse(raw);
          const phone = normalizePhone(input.phone);
          if (phone && phones.has(phone)) { duplicates++; continue; }
          const lead = buildLead(workspace, input);
          // Preserve a valid enquiry timestamp for recovery; never turn a future date into an old lead.
          if (typeof raw.createdAt === "string" && raw.createdAt.trim()) {
            const date = new Date(raw.createdAt);
            if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now()) throw new Error("Enquiry date must be a valid date in the past.");
            lead.createdAt = date.toISOString();
          }
          workspace.leads.unshift(lead); phones.add(lead.phone); imported++;
        } catch (error) {
          errors.push({ row: index + 2, error: error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : (error as Error).message });
        }
      }
      addActivity(workspace, `${imported} enquiries imported; ${duplicates} duplicates skipped`, "lead");
      return { imported, duplicates, errors };
    }
    case "lead.update": {
      const id = z.uuid().parse(action.id);
      const changes = z.object({ stage: z.enum(STAGES).optional(), owner: text(100).optional(), ownerId: z.string().min(1).max(200).nullable().optional(), notes: z.string().max(5000).optional(), nextAction: z.string().max(500).optional(), nextActionAt: z.iso.datetime().nullable().optional(), tags: z.array(z.string().max(30)).max(10).optional(), consent: consent.optional(), consentSource: z.string().max(200).optional(), guardianConsent: z.boolean().optional(), isMinor: z.boolean().optional(), humanOwned: z.boolean().optional() }).parse(action.changes);
      const lead = findLead(workspace, id);
      if (changes.consent === "opted_in" && !(changes.consentSource || lead.consentSource)) throw new Error("Record the WhatsApp opt-in source first.");
      const previousStage = lead.stage;
      const previousConsent = lead.consent;
      const assignment = changes.owner !== undefined || changes.ownerId !== undefined ? resolveOwner(workspace, changes) : {};
      Object.assign(lead, changes, assignment);
      if (changes.consent && changes.consent !== previousConsent) {
        lead.consentAt = isoNow();
        addActivity(workspace, `Contact preference changed to ${changes.consent.replaceAll("_", " ")} · ${lead.consentSource || "Counsellor update"}`, "lead", id);
      }
      if (["Admitted", "Lost"].includes(lead.stage) || lead.consent === "opted_out" || lead.humanOwned) stopJobs(workspace, id);
      if (changes.stage && previousStage !== changes.stage) addActivity(workspace, `${lead.name} moved to ${changes.stage}`, "lead", id);
      else if (changes.humanOwned !== undefined) addActivity(workspace, changes.humanOwned ? `${lead.owner} took over the conversation` : "Conversation returned to the recovery queue", "message", id);
      else if (changes.notes !== undefined) addActivity(workspace, "Counsellor notes updated", "lead", id);
      return { leadId: id };
    }
    case "campaign.create": {
      const input = z.object({ name: text(100), course: text(100), message: text(1500), leadIds: z.array(z.uuid()).min(1).max(1000) }).parse(action);
      if (!workspace.sequence.enabled) throw new Error("Enable recovery sequences in Automations before scheduling a campaign.");
      const eligible = new Set(recoverableLeads(workspace).map(lead => lead.id));
      const leadIds = [...new Set(input.leadIds)];
      if (leadIds.some(id => !eligible.has(id))) throw new Error("Some enquiries are no longer eligible. Refresh the audience and try again.");
      const template = z.object({ templateName: z.string().max(100).optional(), templateLanguage: z.string().max(20).optional() }).parse(action);
      const campaign = { ...template, id: uid(), name: input.name, course: input.course, message: input.message, leadIds, createdAt: isoNow(), status: "active" as const, delays: [...workspace.sequence.delays] };
      workspace.campaigns.unshift(campaign);
      for (const leadId of leadIds) {
        findLead(workspace, leadId).humanOwned = false;
        campaign.delays.forEach((delay, step) => workspace.jobs.push({ id: uid(), campaignId: campaign.id, leadId, step, dueAt: new Date(Date.now() + delay * HOUR).toISOString(), status: "pending" }));
      }
      addActivity(workspace, `${campaign.name} scheduled for ${leadIds.length} enquiries`, "campaign");
      return { campaignId: campaign.id };
    }
    case "campaign.toggle": {
      const campaign = workspace.campaigns.find(c => c.id === z.uuid().parse(action.id));
      if (!campaign || campaign.status === "completed") throw new Error("Only an active or paused campaign can be changed.");
      campaign.status = campaign.status === "active" ? "paused" : "active";
      addActivity(workspace, `${campaign.name} ${campaign.status === "paused" ? "paused" : "resumed"}`, "campaign");
      return null;
    }
    case "message.draft": {
      const input = z.object({ leadId: z.uuid(), body: text(4000), source: z.string().max(200).optional() }).parse(action);
      findLead(workspace, input.leadId);
      const existing = workspace.messages.find(m => m.leadId === input.leadId && m.status === "draft");
      if (existing) { existing.body = input.body; existing.source = input.source; }
      else workspace.messages.push({ id: uid(), leadId: input.leadId, body: input.body, source: input.source, direction: "outbound", author: workspace.actor?.name || workspace.userName, authorId: workspace.actor?.id, status: "draft", createdAt: isoNow() });
      return null;
    }
    case "appointment.create": {
      const input = appointmentProposal(workspace, action);
      const lead = findLead(workspace, input.leadId);
      const appointment = { ...input, id: uid(), status: "scheduled" as const, syncStatus: "pending" as const };
      workspace.appointments.push(appointment);
      lead.stage = input.kind === "Demo class" ? "Demo" : "Counselling";
      lead.nextAction = `${input.kind} booked`; lead.humanOwned = true;
      stopJobs(workspace, lead.id);
      addActivity(workspace, `${input.kind} booked with ${lead.name}`, "appointment", lead.id);
      workspace.jobs.push({ id: uid(), campaignId: "", leadId: lead.id, kind: "calendar.sync", step: 0, dueAt: isoNow(), status: "pending", payload: { appointmentId: appointment.id } });
      return { appointmentId: appointment.id };
    }
    case "appointment.status": {
      const input = z.object({ id: z.uuid(), status: z.enum(["completed", "cancelled", "no_show"]) }).parse(action);
      const appointment = workspace.appointments.find(a => a.id === input.id);
      if (!appointment) throw new Error("Appointment not found.");
      appointment.status = input.status;
      if (input.status === "cancelled") {
        appointment.syncStatus = "pending";
        workspace.jobs.push({ id: uid(), campaignId: "", leadId: appointment.leadId, kind: "calendar.sync", step: 0, dueAt: isoNow(), status: "pending", payload: { appointmentId: appointment.id } });
      }
      addActivity(workspace, `Appointment ${input.status}`, "appointment", appointment.leadId);
      return null;
    }
    case "revenue.record": {
      const input = z.object({ leadId: z.uuid(), amount: z.coerce.number().int().min(1).max(10000000), reference: text(100), campaignId: z.uuid().nullable() }).parse(action);
      const lead = findLead(workspace, input.leadId);
      if (workspace.revenue.some(event => event.reference.toLowerCase() === input.reference.toLowerCase())) throw new Error("That receipt reference has already been recorded.");
      if (input.campaignId && !workspace.campaigns.some(c => c.id === input.campaignId && c.leadIds.includes(lead.id))) throw new Error("The lead must belong to the selected recovery campaign.");
      workspace.revenue.push({ ...input, id: uid(), recordedAt: isoNow() });
      lead.stage = "Admitted"; lead.nextAction = "Admission recorded";
      stopJobs(workspace, lead.id);
      addActivity(workspace, `${lead.name} · admission payment recorded`, "revenue", lead.id);
      return null;
    }
    case "article.save": {
      const input = z.object({ id: z.uuid().optional(), title: text(150), category: text(50), body: text(15000) }).parse(action);
      if (input.id) {
        const article = workspace.articles.find(a => a.id === input.id);
        if (!article) throw new Error("Knowledge article not found.");
        Object.assign(article, input, { updatedAt: isoNow(), version: (article.version || 1) + 1 });
      } else { input.id = uid(); workspace.articles.unshift({ ...input, id: input.id, updatedAt: isoNow(), version: 1 }); }
      if (!workspace.demo) workspace.jobs.push({ id: uid(), leadId: "", campaignId: "", kind: "knowledge.index", status: "pending", step: 0, dueAt: isoNow(), payload: { articleId: input.id! } });
      return null;
    }
    case "article.delete": {
      const id = z.uuid().parse(action.id);
      if (!workspace.articles.some(article => article.id === id)) throw new Error("Knowledge article not found.");
      workspace.articles = workspace.articles.filter(article => article.id !== id);
      workspace.jobs.filter(job => job.kind === "knowledge.index" && job.payload?.articleId === id && job.status === "pending").forEach(job => { job.status = "cancelled"; });
      return null;
    }
    case "sequence.save": {
      const input = z.object({ enabled: z.boolean(), delays: z.array(z.number().int().min(0).max(720)).min(1).max(4) }).parse(action);
      if (input.delays[0] !== 0 || input.delays.some((delay, i) => i > 0 && delay <= input.delays[i - 1])) throw new Error("Start at 0 hours and use increasing follow-up delays.");
      workspace.sequence = input;
      return null;
    }
    case "settings.save": {
      const input = z.object({ name: text(100), userName: text(100), team: z.array(text(100)).min(1).max(20), courses: z.array(text(100)).max(50) }).parse(action);
      if (workspace.workosOrganizationId) {
        workspace.name = input.name; workspace.courses = [...new Set(input.courses)];
        workspace.team = [...new Set(workspace.members!.filter(member => member.status === "active").map(member => member.name))];
      } else {
        Object.assign(workspace, input, { team: [...new Set(input.team)], courses: [...new Set(input.courses)] });
        for (const name of workspace.team) if (!workspace.members!.some(member => member.name === name)) workspace.members!.push({ id: uid(), name, email: "", role: "counsellor", status: "active" });
      }
      return null;
    }
    case "lead.bulk": {
      const input = z.object({ ids: z.array(z.uuid()).min(1).max(1000), owner: text(100).optional(), ownerId: z.string().min(1).max(200).nullable().optional(), stage: z.enum(STAGES).optional() }).parse(action);
      const assignment = input.owner !== undefined || input.ownerId !== undefined ? resolveOwner(workspace, input) : {};
      const ids = [...new Set(input.ids)];
      ids.forEach(id => findLead(workspace, id));
      for (const id of ids) applyHydratedAction(workspace, { type: "lead.update", id, changes: { ...assignment, ...(input.stage ? { stage: input.stage } : {}) } });
      return { updated: ids.length };
    }
    case "message.read": {
      findLead(workspace, z.uuid().parse(action.id)).unread = false; return {};
    }
    case "message.note": {
      const input = z.object({ leadId: z.uuid(), body: text(4000) }).parse(action);
      findLead(workspace, input.leadId);
      workspace.messages.push({ ...input, id: uid(), direction: "internal", author: workspace.actor?.name || workspace.userName, authorId: workspace.actor?.id, status: "received", createdAt: isoNow() });
      addActivity(workspace, `${workspace.actor?.name || workspace.userName} added an internal note`, "message", input.leadId);
      return {};
    }
    case "task.save": {
      const input = z.object({ id: z.uuid().optional(), leadId: z.uuid(), title: text(200), owner: text(100).optional(), ownerId: z.string().min(1).max(200).optional(), dueAt: z.iso.datetime() }).parse(action);
      const lead = findLead(workspace, input.leadId);
      const assignment = resolveOwner(workspace, input);
      const existing = workspace.tasks!.find(task => task.id === input.id);
      if (input.id && !existing) throw new Error("Task not found.");
      if (existing) Object.assign(existing, input, assignment); else workspace.tasks!.push({ ...input, ...assignment, id: uid(), status: "open" });
      lead.nextAction = input.title; lead.nextActionAt = input.dueAt;
      return {};
    }
    case "task.complete": {
      const task = workspace.tasks!.find(task => task.id === z.uuid().parse(action.id));
      if (!task) throw new Error("Task not found.");
      task.status = "completed";
      addActivity(workspace, `Completed: ${task.title}`, "lead", task.leadId); return {};
    }
    case "ai.save": {
      workspace.ai = z.object({ mode: z.enum(["autonomous", "assisted", "paused"]), model: text(100), language: z.enum(["auto", "en", "hi"]), instructions: z.string().max(4000), voiceReplies: z.boolean(), dailyLimit: z.number().int().min(1).max(10000), voiceId: z.string().max(100) }).parse(action.settings);
      if (workspace.ai.mode !== "autonomous") workspace.jobs.filter(job => ["ai.reply", "appointment.book"].includes(job.kind || "")).forEach(job => cancelUndispatchedJob(workspace, job));
      addActivity(workspace, `AI assistant set to ${workspace.ai.mode}`, "message"); return {};
    }
    case "view.save": {
      const input = z.object({ name: text(40), query: z.string().max(100).default(""), course: z.string().max(100).default(""), stage: z.string().max(30).default(""), owner: z.string().max(100).default(""), view: z.enum(LEAD_VIEWS).optional(), sort: z.enum(LEAD_SORTS).optional() }).parse(action);
      if (workspace.savedViews!.length >= 20) throw new Error("Use up to 20 saved views.");
      const saved = { ...input, id: uid() };
      workspace.savedViews!.push(saved); return { viewId: saved.id, view: saved.view, sort: saved.sort };
    }
    case "appointment.reschedule": {
      const input = appointmentProposal(workspace, action);
      const appointment = workspace.appointments.find(item => item.id === input.id)!;
      Object.assign(appointment, { startsAt: input.startsAt, owner: input.owner, ownerId: input.ownerId, status: "scheduled", syncStatus: "pending" });
      workspace.jobs.push({ id: uid(), leadId: appointment.leadId, campaignId: "", kind: "calendar.sync", status: "pending", step: 0, dueAt: isoNow(), payload: { appointmentId: appointment.id } });
      addActivity(workspace, "Counselling session rescheduled", "appointment", appointment.leadId); return {};
    }
    case "revenue.refund": {
      const input = z.object({ revenueId: z.uuid(), amount: z.number().positive().max(10000000), reference: text(100) }).parse(action);
      if (!Number.isSafeInteger(Math.round(input.amount * 100)) || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001 || Math.round(input.amount * 100) < 1) throw new Error("Use a positive amount with at most two decimal places.");
      const payment = workspace.revenue.find(item => item.id === input.revenueId);
      if (!payment) throw new Error("Payment not found.");
      if (payment.origin === "razorpay") throw new Error("Refund provider payments through Razorpay; the verified webhook updates this ledger.");
      const previous = workspace.refunds!.filter(refund => refund.revenueId === payment.id).reduce((sum, item) => sum + item.amount, 0);
      if (Math.round((previous + input.amount) * 100) > Math.round(payment.amount * 100)) throw new Error("The refund exceeds the remaining payment.");
      if (workspace.refunds!.some(item => item.reference === input.reference)) throw new Error("This refund reference already exists.");
      workspace.refunds!.push({ ...input, id: uid(), recordedAt: isoNow() });
      addActivity(workspace, "Offline refund recorded", "revenue", payment.leadId); return {};
    }
    case "job.retry": {
      const job = workspace.jobs.find(item => item.id === z.uuid().parse(action.id));
      if (!job || !["failed", "reconcile"].includes(job.status)) throw new Error("Only failed or unresolved jobs can be retried.");
      const message = workspace.messages.find(item => item.id === job.messageId);
      if (job.status === "reconcile" || message?.providerId || (job.dispatchedAt && message?.dispatchState !== "rejected")) throw new Error("Delivery may have been accepted. A manual confirmation cannot safely resend this message; await signed provider reconciliation.");
      if (message?.dispatchedAt && message.dispatchState !== "rejected") throw new Error("This message needs provider reconciliation before retrying.");
      if (message) { message.status = "queued"; message.error = undefined; }
      Object.assign(job, { status: "pending", dueAt: isoNow(), error: undefined, lockedAt: null, dispatchedAt: null, retryGeneration: (job.retryGeneration || 0) + 1 }); return {};
    }
    default: throw new Error("This action is not supported.");
  }
}

export function parseConsent(value: string): Consent {
  if (["yes", "true", "opted_in", "consented"].includes(value.toLowerCase().trim())) return "opted_in";
  if (["opted_out", "stop", "unsubscribed"].includes(value.toLowerCase().trim())) return "opted_out";
  return "unknown";
}
