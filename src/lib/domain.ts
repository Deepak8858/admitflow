export const STAGES = ["New", "Contacted", "Qualified", "Counselling", "Demo", "Negotiation", "Admitted", "Lost"] as const;
export type Stage = (typeof STAGES)[number];
export type Consent = "opted_in" | "unknown" | "opted_out";
export const LEAD_VIEWS = ["all", "high-intent", "needs-followup", "admitted"] as const;
export const LEAD_SORTS = ["intent", "newest", "name"] as const;
export type LeadView = (typeof LEAD_VIEWS)[number];
export type LeadSort = (typeof LEAD_SORTS)[number];
/** Shared by domain scoring and the SQL query expressions. */
export const LEAD_RULES = {
  highIntent: 70, staleDays: 7, recentInboundDays: 14,
  points: { base: 10, course: 15, qualified: 20, budget: 15, visit: 15, recentInbound: 20, pastInbound: 10, directSource: 5 },
  qualifiedStages: ["Qualified", "Counselling", "Demo", "Negotiation"] as readonly Stage[],
  closedStages: ["Admitted", "Lost"] as readonly Stage[],
  directSources: ["Referral", "Website"] as readonly string[],
  budgetPattern: "fee|price|budget|scholarship", visitPattern: "visit|demo|batch|schedule|classroom",
} as const;
const budgetSignals = new RegExp(LEAD_RULES.budgetPattern, "i"), visitSignals = new RegExp(LEAD_RULES.visitPattern, "i");

export interface Lead {
  id: string; name: string; phone: string; email: string; course: string; source: string;
  stage: Stage; owner: string; ownerId?: string | null; value: number; notes: string; nextAction: string;
  createdAt: string; lastContactAt: string | null; lastInboundAt: string | null;
  consent: Consent; consentSource: string; consentAt: string | null;
  isMinor: boolean; guardianConsent: boolean; humanOwned: boolean;
  nextActionAt?: string | null; tags?: string[]; customFields?: Record<string, string>;
  whatsappId?: string; unread?: boolean; lastInboundMessageId?: string;
  intakePending?: boolean; // Derived from the server inbox, never a client-editable preference.
}
export interface Message {
  id: string; leadId: string; body: string; direction: "inbound" | "outbound" | "internal";
  author: string; status: "received" | "draft" | "queued" | "accepted" | "sent" | "delivered" | "read" | "failed" | "reconcile" | "demo";
  createdAt: string; providerId?: string; source?: string;
  fileId?: string; mediaType?: string; providerMediaId?: string; error?: string;
  authorId?: string; receivedAt?: string; statusAt?: string; dispatchedAt?: string;
  dispatchState?: "dispatching" | "accepted" | "rejected" | "uncertain";
  voiceFallback?: string;
}
export interface Campaign {
  id: string; name: string; course: string; status: "active" | "paused" | "completed";
  message: string; leadIds: string[]; createdAt: string; delays: number[];
  templateName?: string; templateLanguage?: string;
}
export interface Job {
  id: string; campaignId: string; leadId: string; step: number; dueAt: string;
  status: "pending" | "processing" | "accepted" | "sent" | "demo" | "cancelled" | "failed" | "reconcile";
  error?: string; messageId?: string;
  kind?: "followup" | "ai.reply" | "appointment.book" | "calendar.sync" | "file.ingest" | "knowledge.index" | "reminder";
  sourceMessageId?: string; attempts?: number; lockedAt?: string | null;
  dispatchedAt?: string | null; retryGeneration?: number;
  payload?: Record<string, string>;
}
export interface Appointment {
  id: string; leadId: string; owner: string; ownerId?: string | null; startsAt: string; duration: number;
  kind: "Counselling" | "Demo class" | "Campus visit"; status: "scheduled" | "completed" | "cancelled" | "no_show";
  externalId?: string; meetingUrl?: string; syncStatus?: "local" | "pending" | "synced" | "failed";
}
export interface RevenueEvent {
  id: string; leadId: string; amount: number; recordedAt: string; campaignId: string | null;
  reference: string;
  origin?: "manual" | "razorpay"; providerId?: string;
}
export interface Article { id: string; title: string; category: string; body: string; updatedAt: string; version?: number; fileId?: string }
export interface Activity { id: string; leadId: string | null; text: string; createdAt: string; kind: "lead" | "message" | "revenue" | "campaign" | "appointment" }
export type Role = "owner" | "admin" | "counsellor" | "analyst";
export interface Member { id: string; name: string; email: string; role: Role; status: "active" | "invited" | "inactive"; workosId?: string }
export interface FollowupTask { id: string; leadId: string; title: string; owner: string; ownerId?: string | null; dueAt: string; status: "open" | "completed" }
export interface Refund { id: string; revenueId: string; amount: number; reference: string; recordedAt: string }
export interface WorkspaceFile { id: string; name: string; mime: string; size: number; purpose: "knowledge" | "attachment" | "receipt" | "import"; status: "pending" | "ready" | "failed"; createdAt: string; error?: string; objectKey?: string; leadId?: string; etag?: string; finalizedAt?: string; uploadedBy?: string }
export interface Connection { id: string; service: "whatsapp" | "openai" | "elevenlabs" | "google" | "razorpay" | "meta_leads"; status: "connected" | "unverified" | "error"; externalId: string; label: string; updatedAt: string; metadata: Record<string, string>; secret?: string }
export interface AiSettings { mode: "autonomous" | "assisted" | "paused"; model: string; language: "auto" | "en" | "hi"; instructions: string; voiceReplies: boolean; dailyLimit: number; voiceId: string }
export interface SavedView { id: string; name: string; query: string; course: string; stage: string; owner: string; view?: LeadView; sort?: LeadSort }
export interface SubscriptionLimits { members: number | null; leads: number | null }
export interface SubscriptionEntitlements {
  version: 1; subscriptionId: string; planId: string; providerPlanId: string; limits: SubscriptionLimits;
}
export interface Subscription {
  status: "trial" | "active" | "past_due" | "cancelled"; plan: string; providerId?: string; renewsAt?: string;
  planId?: string; providerPlanId?: string; entitlements?: SubscriptionEntitlements;
  providerStatus?: "created" | "authenticated" | "active" | "pending" | "halted" | "paused" | "cancelled" | "completed" | "expired";
  verifiedAt?: string; currentPeriodEnd?: string;
}
export interface Workspace {
  id: string; name: string; demo: boolean; userName: string; email: string;
  team: string[]; courses: string[]; leads: Lead[]; messages: Message[];
  campaigns: Campaign[]; jobs: Job[]; appointments: Appointment[];
  revenue: RevenueEvent[]; articles: Article[]; activities: Activity[];
  sequence: { delays: number[]; enabled: boolean };
  integrations?: { ai: boolean; whatsapp: boolean; template: boolean; storage?: boolean; speech?: boolean; calendar?: boolean; payments?: boolean; auth?: boolean; metaAppId?: string; metaConfigId?: string; metaVersion?: string };
  ai?: AiSettings; members?: Member[]; tasks?: FollowupTask[]; refunds?: Refund[];
  files?: WorkspaceFile[]; connections?: Connection[]; savedViews?: SavedView[];
  actor?: { id: string; memberId?: string; name: string; email: string; role: Role; backend: "local" | "workos" };
  workosOrganizationId?: string;
  subscription?: Subscription; revision?: number; timezone?: string;
  trial?: import("./subscription-policy").TrialGrant;
  capabilities?: import("./subscription-policy").CapabilitySummary;
}

export const DEFAULT_AI: AiSettings = { mode: "autonomous", model: "gpt-4.1-mini", language: "auto", instructions: "Be warm, concise and helpful. Help students find the right course and a counselling time.", voiceReplies: false, dailyLimit: 250, voiceId: "" };

/** Server preferences win; only missing fields consult an older browser record. */
export function resolveSavedViewPreferences(saved: Pick<SavedView, "view" | "sort">, legacy?: unknown): { view: LeadView; sort: LeadSort } {
  const previous = legacy && typeof legacy === "object" && !Array.isArray(legacy) ? legacy as Record<string, unknown> : {};
  const view = saved.view ?? previous.view, sort = saved.sort ?? previous.sort;
  return { view: typeof view === "string" && LEAD_VIEWS.includes(view as LeadView) ? view as LeadView : "all", sort: typeof sort === "string" && LEAD_SORTS.includes(sort as LeadSort) ? sort as LeadSort : "intent" };
}

/** Adds versioned defaults to existing pilot data without replacing customer records. */
export function hydrateWorkspace(workspace: Workspace): Workspace {
  workspace.ai = { ...DEFAULT_AI, ...workspace.ai };
  workspace.tasks ||= []; workspace.refunds ||= []; workspace.files ||= [];
  workspace.connections ||= []; workspace.savedViews ||= [];
  // Deterministic IDs also make read-only hydration of old SQLite records stable.
  // A display-name match must NEVER claim an enquiry for a WorkOS identity.
  workspace.members ||= workspace.team.map((name, index) => ({ id: `legacy:${workspace.id}:${index}`, name, email: "", role: "counsellor", status: "active" }));
  if (!workspace.workosOrganizationId && !workspace.members.some(member => member.workosId)) {
    for (const name of workspace.team) if (!workspace.members.some(member => member.name === name)) workspace.members.push({ id: `legacy:${workspace.id}:extra:${workspace.members.length}`, name, email: "", role: "counsellor", status: "active" });
  }
  for (const record of [...workspace.leads, ...workspace.tasks, ...workspace.appointments]) {
    if (record.ownerId !== undefined) {
      // Accept an explicit WorkOS user ID from intake adapters, then normalize to
      // the member foreign key. This is an ID mapping, never a name-based grant.
      if (record.ownerId && !workspace.members.some(member => member.id === record.ownerId)) {
        const match = workspace.members.filter(member => member.workosId === record.ownerId);
        if (match.length === 1) record.ownerId = match[0].id;
      }
      continue;
    }
    const matches = workspace.members.filter(member => member.name === record.owner && member.status === "active");
    record.ownerId = matches.length === 1 && !matches[0].workosId ? matches[0].id : null;
  }
  workspace.subscription ||= { status: "trial", plan: "Pilot" };
  workspace.timezone ||= "Asia/Kolkata";
  workspace.revision ||= 0;
  return workspace;
}

/** Canonical assignments use the immutable member record ID, never a display name. */
export function resolveOwner(workspace: Workspace, input: { owner?: string; ownerId?: string | null } = {}) {
  const members = (workspace.members || []).filter(member => member.status === "active" && ["owner", "admin", "counsellor"].includes(member.role) && (!workspace.workosOrganizationId || Boolean(member.workosId)));
  if (input.ownerId === null) return { ownerId: null, owner: "Unassigned" };
  const matches = input.ownerId ? members.filter(member => member.id === input.ownerId || member.workosId === input.ownerId)
    : input.owner ? members.filter(member => member.name === input.owner) : [members.find(member => member.name === workspace.team[0]) || members[0]].filter((member): member is Member => Boolean(member));
  if (matches.length !== 1) throw new Error(matches.length > 1 ? "More than one member has this name. Choose an ownerId." : "Choose an active member of your institute.");
  const member = matches[0];
  if (input.ownerId && input.owner && input.owner !== member.name) throw new Error("The owner name does not match the selected member.");
  return { ownerId: member.id, owner: member.name };
}

export function latestInbound(workspace: Workspace, lead: Lead) {
  const messages = workspace.messages.filter(message => message.leadId === lead.id && message.direction === "inbound");
  return messages.find(message => message.id === lead.lastInboundMessageId)
    || messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.receivedAt || a.createdAt).localeCompare(b.receivedAt || b.createdAt) || a.id.localeCompare(b.id)).at(-1);
}

export function laterTimestamp(first: string | null | undefined, second: string) {
  return first && Date.parse(first) > Date.parse(second) ? first : second;
}

/** User-initiated service replies do not confer permission for future campaigns. */
export function replyBlock(lead: Lead, now = Date.now()): string | null {
  if (lead.intakePending) return "Deferred messages need administrator review before sending to this student.";
  if (lead.consent === "opted_out") return "This student has opted out of messages.";
  if (lead.isMinor && !lead.guardianConsent) return "Guardian consent needs attention.";
  const inbound = Date.parse(lead.lastInboundAt || "");
  if (!Number.isFinite(inbound) || inbound > now + 60_000 || now - inbound >= 24 * HOUR) return "The 24-hour reply window is closed. Use an approved template.";
  if (["Admitted", "Lost"].includes(lead.stage)) return "This enquiry is closed.";
  return null;
}

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const uid = () => crypto.randomUUID();
export const isoNow = () => new Date().toISOString();

export function normalizePhone(value: string): string | null {
  let digits = value.replace(/[\s().-]/g, "");
  if (/^'\+?\d/.test(digits)) digits = digits.slice(1);
  if (/^\d{10}$/.test(digits)) digits = `+91${digits}`;
  else if (/^91\d{10}$/.test(digits)) digits = `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export function scoreLead(lead: Lead, now = Date.now()) {
  const points = LEAD_RULES.points;
  const reasons: { label: string; points: number }[] = [{ label: "Valid enquiry", points: points.base }];
  if (lead.course && lead.course !== "Undecided") reasons.push({ label: "Specific course interest", points: points.course });
  if (LEAD_RULES.qualifiedStages.includes(lead.stage)) reasons.push({ label: "Qualified by a counsellor", points: points.qualified });
  if (budgetSignals.test(lead.notes)) reasons.push({ label: "Discussed fees or budget", points: points.budget });
  if (visitSignals.test(lead.notes)) reasons.push({ label: "Asked about a visit or batch", points: points.visit });
  if (lead.lastInboundAt) {
    const age = (now - new Date(lead.lastInboundAt).getTime()) / DAY;
    reasons.push({ label: age <= LEAD_RULES.recentInboundDays ? "Replied in the last 14 days" : "Has replied before", points: age <= LEAD_RULES.recentInboundDays ? points.recentInbound : points.pastInbound });
  }
  if (LEAD_RULES.directSources.includes(lead.source)) reasons.push({ label: "Direct or referral enquiry", points: points.directSource });
  return { score: Math.min(100, reasons.reduce((sum, reason) => sum + reason.points, 0)), reasons };
}

export function contactBlock(lead: Lead): string | null {
  if (lead.intakePending) return "Deferred messages need administrator review";
  if (lead.consent === "opted_out") return "Opted out of messages";
  if (lead.consent !== "opted_in") return "WhatsApp opt-in not recorded";
  if (lead.isMinor && !lead.guardianConsent) return "Guardian consent not recorded";
  if (["Admitted", "Lost"].includes(lead.stage)) return "Enquiry is closed";
  return null;
}

export function isStale(lead: Lead, now = Date.now()) {
  return !LEAD_RULES.closedStages.includes(lead.stage) && now - new Date(lead.lastContactAt || lead.createdAt).getTime() >= LEAD_RULES.staleDays * DAY;
}

export function leadMatchesView(lead: Lead, view: LeadView = "all", now = Date.now()) {
  switch (view) {
    case "all": return true;
    case "high-intent": return scoreLead(lead, now).score >= LEAD_RULES.highIntent;
    case "needs-followup": return isStale(lead, now);
    case "admitted": return lead.stage === "Admitted";
    default: throw new Error("Unsupported enquiry view.");
  }
}
function codePointOrder(left: string, right: string) {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
const leadNameKey = (name: string) => name.replace(/[A-Z]/g, letter => letter.toLowerCase());
/** Deterministic tie-breaks match the paginated SQL order. Does not mutate input. */
export function sortLeads(leads: Lead[], sort: LeadSort = "newest", now = Date.now()) {
  if (!LEAD_SORTS.includes(sort)) throw new Error("Unsupported enquiry sort.");
  const scores = sort === "intent" ? new Map(leads.map(lead => [lead.id, scoreLead(lead, now).score])) : undefined;
  return [...leads].sort((a, b) => (sort === "intent" ? scores!.get(b.id)! - scores!.get(a.id)! : sort === "name" ? codePointOrder(leadNameKey(a.name), leadNameKey(b.name)) : 0)
    || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function recoverableLeads(workspace: Workspace, now = Date.now()) {
  const enrolled = new Set(workspace.campaigns.filter(c => c.status !== "completed").flatMap(c => c.leadIds));
  return workspace.leads.filter(lead => isStale(lead, now) && !contactBlock(lead) && !enrolled.has(lead.id))
    .sort((a, b) => scoreLead(b, now).score - scoreLead(a, now).score);
}

export function stopJobs(workspace: Workspace, leadId: string) {
  workspace.jobs.forEach(job => { if (job.leadId === leadId && !["calendar.sync", "file.ingest", "knowledge.index"].includes(job.kind || "followup")) cancelUndispatchedJob(workspace, job); });
}
export function cancelUndispatchedJob(workspace: Workspace, job: Job) {
  if (!["pending", "processing"].includes(job.status) || job.dispatchedAt) return;
  job.status = "cancelled"; job.lockedAt = null;
  if (job.kind === "appointment.book") {
    const parent = workspace.jobs.find(item => item.id === job.payload?.replyJobId && item.leadId === job.leadId);
    if (parent?.payload) parent.payload.bookingState = "cancelled";
    const lead = workspace.leads.find(item => item.id === job.leadId);
    if (lead?.nextAction === "Checking the requested counselling slot") lead.nextAction = "Counsellor to confirm a counselling time";
  }
}

export function addActivity(workspace: Workspace, text: string, kind: Activity["kind"], leadId: string | null = null) {
  workspace.activities.unshift({ id: uid(), leadId, text, kind, createdAt: isoNow() });
  workspace.activities = workspace.activities.slice(0, 1000);
}

export const REPORTING_TIME_ZONE = "Asia/Kolkata";
const REPORTING_OFFSET = 5.5 * HOUR; // The product's explicit Indian calendar-day reporting convention.
export interface ReportingWindow { timeZone: typeof REPORTING_TIME_ZONE; days: number; start: string; end: string; startMs: number; endMs: number }
export function reportingWindow(days: number, now = Date.now()): ReportingWindow {
  const endMs = new Date(now).getTime();
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isFinite(endMs)) throw new RangeError("Choose a positive whole-day reporting period and valid cutoff.");
  const startMs = Math.floor((endMs + REPORTING_OFFSET) / DAY) * DAY - REPORTING_OFFSET - (days - 1) * DAY;
  return { timeZone: REPORTING_TIME_ZONE, days, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startMs, endMs };
}
export function inReportingWindow(value: string, window: ReportingWindow) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= window.startMs && time <= window.endMs;
}
export interface RevenueSeriesPoint {
  date: string; value: number; cumulative: number; count: number;
  valuePaise: number; cumulativePaise: number;
  grossPaise: number; refundsPaise: number; netPaise: number;
  recoveredGrossPaise: number; recoveredRefundsPaise: number;
  newAdmissions: number; cumulativeAdmissions: number; newRecoveredAdmissions: number;
}

/** Cash-flow report: all money is summed in integer paise. Paid-student counts
 * reset at the window start and count each lead once, regardless of instalment
 * count or number of campaigns. Refunds affect cash, not the student counters. */
export function revenueReport(workspace: Pick<Workspace, "revenue" | "refunds">, days: number, now = Date.now()) {
  const window = reportingWindow(days, now);
  const buckets = Array.from({ length: days }, (_, index) => ({
    date: new Date(window.startMs + index * DAY).toISOString(), grossPaise: 0, refundsPaise: 0, recoveredGrossPaise: 0, recoveredRefundsPaise: 0,
    students: new Set<string>(), recoveredStudents: new Set<string>(),
  }));
  const recorded = new Map<string, { payment: RevenueEvent; time: number; paise: number }>();
  for (const payment of workspace.revenue) {
    const time = Date.parse(payment.recordedAt), paise = Math.round((payment.amount + Number.EPSILON) * 100);
    if (Number.isFinite(time) && time <= window.endMs && Number.isSafeInteger(paise) && paise > 0) recorded.set(payment.id, { payment, time, paise });
  }
  const payments: RevenueEvent[] = [], refunds: Refund[] = [];
  for (const { payment, time, paise } of recorded.values()) {
    if (time < window.startMs) continue;
    const bucket = buckets[Math.floor((time - window.startMs) / DAY)];
    payments.push(payment); bucket.grossPaise += paise; bucket.students.add(payment.leadId);
    if (payment.campaignId) { bucket.recoveredGrossPaise += paise; bucket.recoveredStudents.add(payment.leadId); }
  }
  const refundIds = new Set<string>();
  for (const refund of workspace.refunds || []) {
    const receipt = recorded.get(refund.revenueId), paise = Math.round((refund.amount + Number.EPSILON) * 100);
    if (!receipt || refundIds.has(refund.id) || !inReportingWindow(refund.recordedAt, window) || !Number.isSafeInteger(paise) || paise <= 0) continue;
    refundIds.add(refund.id); refunds.push(refund);
    const bucket = buckets[Math.floor((Date.parse(refund.recordedAt) - window.startMs) / DAY)];
    bucket.refundsPaise += paise;
    if (receipt.payment.campaignId) bucket.recoveredRefundsPaise += paise;
  }
  let grossPaise = 0, refundsPaise = 0, recoveredGrossPaise = 0, recoveredRefundsPaise = 0;
  const students = new Set<string>(), recoveredStudents = new Set<string>();
  const series: RevenueSeriesPoint[] = buckets.map(bucket => {
    const before = students.size, recoveredBefore = recoveredStudents.size;
    bucket.students.forEach(id => students.add(id)); bucket.recoveredStudents.forEach(id => recoveredStudents.add(id));
    grossPaise += bucket.grossPaise; refundsPaise += bucket.refundsPaise;
    recoveredGrossPaise += bucket.recoveredGrossPaise; recoveredRefundsPaise += bucket.recoveredRefundsPaise;
    const valuePaise = bucket.recoveredGrossPaise - bucket.recoveredRefundsPaise, cumulativePaise = recoveredGrossPaise - recoveredRefundsPaise;
    return { date: bucket.date, value: valuePaise / 100, cumulative: cumulativePaise / 100, count: recoveredStudents.size, valuePaise, cumulativePaise,
      grossPaise: bucket.grossPaise, refundsPaise: bucket.refundsPaise, netPaise: bucket.grossPaise - bucket.refundsPaise,
      recoveredGrossPaise: bucket.recoveredGrossPaise, recoveredRefundsPaise: bucket.recoveredRefundsPaise,
      newAdmissions: students.size - before, cumulativeAdmissions: students.size, newRecoveredAdmissions: recoveredStudents.size - recoveredBefore };
  });
  return { window, payments, refunds, series,
    money: { grossPaise, refundsPaise, netPaise: grossPaise - refundsPaise, recoveredGrossPaise, recoveredRefundsPaise, recoveredNetPaise: recoveredGrossPaise - recoveredRefundsPaise },
    totals: { grossRevenue: grossPaise / 100, totalRefunds: refundsPaise / 100, totalRevenue: (grossPaise - refundsPaise) / 100,
      recoveredRevenue: (recoveredGrossPaise - recoveredRefundsPaise) / 100, admissions: students.size, recoveredAdmissions: recoveredStudents.size } };
}

export function metrics(workspace: Workspace, days: number, now = Date.now()) {
  const report = revenueReport(workspace, days, now);
  return { ...report.totals,
    appointments: workspace.appointments.filter(a => a.status !== "cancelled" && inReportingWindow(a.startsAt, report.window)).length,
    recoverable: recoverableLeads(workspace, now).length,
    pipelineValue: workspace.leads.filter(l => !["Admitted", "Lost"].includes(l.stage)).reduce((sum, lead) => sum + lead.value, 0),
  };
}

export function revenueSeries(workspace: Workspace, days: number, now = Date.now()) {
  return revenueReport(workspace, days, now).series;
}

export function currency(value: number, compact = false) {
  const paise = Math.round((Math.abs(value) + Number.EPSILON) * 100);
  const rounded = paise === 0 ? 0 : Math.sign(value) * paise / 100;
  const magnitude = Math.abs(rounded), prefix = rounded < 0 ? "-₹" : "₹";
  if (compact && (magnitude >= 100000 || (magnitude >= 1000 && Number((magnitude / 1000).toFixed(1)) >= 100))) return `${prefix}${(magnitude / 100000).toFixed(1)}L`;
  if (compact && magnitude >= 1000) return `${prefix}${(magnitude / 1000).toFixed(paise % 100000 ? 1 : 0)}k`;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(rounded);
}
export function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...options }).format(new Date(value));
}
export function relativeTime(value: string) {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60000) return "Just now";
  if (delta < HOUR) return `${Math.floor(delta / 60000)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}
export function initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join("").toUpperCase(); }

export function appointmentClashes(workspace: Workspace, owner: string, startsAt: string, duration: number, ownerId?: string | null) {
  const start = new Date(startsAt).getTime(), end = start + duration * 60000;
  return workspace.appointments.some(a => (ownerId && a.ownerId ? a.ownerId === ownerId : a.owner === owner) && a.status === "scheduled" && start < new Date(a.startsAt).getTime() + a.duration * 60000 && end > new Date(a.startsAt).getTime());
}

export function calendarFile(appointment: Appointment, leadName: string, institute: string) {
  const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/[,;]/g, match => `\\${match}`);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = new Date(appointment.startsAt);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AdmitFlow//Counselling//EN", "BEGIN:VEVENT", `UID:${appointment.id}@admitflow.local`, `DTSTAMP:${stamp(new Date())}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(new Date(start.getTime() + appointment.duration * 60000))}`, `SUMMARY:${escape(`${appointment.kind}: ${leadName}`)}`, `DESCRIPTION:${escape(`${institute} · Counsellor: ${appointment.owner}`)}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

export function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportLeads(leads: Lead[]) {
  const fields: (keyof Lead)[] = ["name", "phone", "email", "course", "source", "stage", "owner", "value", "consent", "consentSource", "createdAt", "notes"];
  return [fields.join(","), ...leads.map(lead => fields.map(field => csvCell(lead[field])).join(","))].join("\r\n");
}
