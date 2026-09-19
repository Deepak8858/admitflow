import { config } from "dotenv";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Client, type Pool } from "pg";
import { WorkOS } from "@workos-inc/node";
import { eq, getTableColumns, inArray, or, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { z } from "zod";
import { database } from "../src/lib/db/client";
import { createPostgresWorkspace, loadPostgresWorkspace } from "../src/lib/db/repository";
import * as tables from "../src/lib/db/schema";
import { hydrateWorkspace, normalizePhone, STAGES, type Workspace, type Member } from "../src/lib/domain";
import { MigrationError, migrationPlan, safeMigrationError, unpooledDatabaseUrl, verifyMigrationHistory } from "../infra/migration-support";

type TenantTable = PgTable & { id: AnyPgColumn; organizationId: AnyPgColumn };
export const COLLECTIONS = {
  leads: tables.leads, messages: tables.messages, campaigns: tables.campaigns, jobs: tables.jobs,
  appointments: tables.appointments, revenue: tables.payments, refunds: tables.refunds,
  articles: tables.articles, activities: tables.activities, tasks: tables.tasks, members: tables.members,
  files: tables.files, connections: tables.connections, savedViews: tables.savedViews,
} satisfies Record<string, TenantTable>;
type Collection = keyof typeof COLLECTIONS;
type RecordData = Record<string, unknown> & { id: string };
const collectionNames = Object.keys(COLLECTIONS) as Collection[];
const record = z.record(z.string(), z.unknown());
const text = z.string(), nonempty = z.string().min(1), uuid = z.uuid().refine(value => value === value.toLowerCase());
const stringMap = z.record(z.string(), z.string());
const role = z.enum(["owner", "admin", "counsellor", "analyst"]);

const workspaceSchema = z.object({
  id: uuid, name: nonempty, userName: nonempty, email: text, demo: z.boolean(), team: z.array(text), courses: z.array(text),
  leads: z.array(record), messages: z.array(record), campaigns: z.array(record), jobs: z.array(record),
  appointments: z.array(record), revenue: z.array(record), articles: z.array(record), activities: z.array(record),
  refunds: z.array(record).default([]), tasks: z.array(record).default([]), members: z.array(record).default([]),
  files: z.array(record).default([]), connections: z.array(record).default([]), savedViews: z.array(record).default([]),
  sequence: z.object({ enabled: z.boolean(), delays: z.array(z.number().nonnegative()) }).strict(),
  ai: z.object({ mode: z.enum(["autonomous", "assisted", "paused"]), model: nonempty, language: z.enum(["auto", "en", "hi"]), instructions: text, voiceReplies: z.boolean(), dailyLimit: z.number().int().nonnegative(), voiceId: text }).partial().optional(),
  subscription: z.object({ status: z.enum(["trial", "active", "past_due", "cancelled"]), plan: nonempty, providerId: text.optional(), renewsAt: text.optional() }).strict().optional(),
  timezone: text.optional(), revision: z.number().int().nonnegative().optional(), workosOrganizationId: text.optional(),
  // These are response/session projections, not persisted business or authentication records.
  actor: z.unknown().optional(), integrations: z.unknown().optional(),
}).strict();

export const mappingSchema = z.object({
  version: z.literal(1),
  workspaces: z.array(z.object({
    workspaceId: uuid, workosOrganizationId: z.string().regex(/^org_[A-Za-z0-9]+$/),
    ownerWorkosUserId: z.string().regex(/^user_[A-Za-z0-9]+$/),
    historicalOwnerLabels: z.array(nonempty).default([]),
    members: z.array(z.object({
      legacyMemberId: nonempty.optional(),
      workosUserId: z.string().regex(/^user_[A-Za-z0-9]+$/), workosMembershipId: z.string().regex(/^om_[A-Za-z0-9]+$/),
      name: nonempty, email: z.email(), role, status: z.enum(["active", "inactive"]),
      ownerLabels: z.array(nonempty), legacyEmails: z.array(z.email()).default([]),
    }).strict()).min(1),
  }).strict()),
}).strict();
export type WorkspaceMapping = z.infer<typeof mappingSchema>["workspaces"][number];

export interface WorkspaceReport {
  workspaceId: string;
  classification: "demo" | "registered" | "unregistered" | "invalid";
  action: "excluded" | "blocked" | "ready" | "imported" | "skipped-identical" | "verification-failed";
  issues: string[];
  unresolvedOwnerLabels: string[];
  counts?: Record<string, number>;
  money?: { currency: "INR"; grossPaise: string; refundPaise: string; netPaise: string };
  changes?: { heldJobIds: string[]; heldMessageIds: string[]; pausedCampaignIds: string[]; canonicalReceiptIds: string[]; previousSequenceEnabled: boolean; previousAiMode: string; assignedRecordIds: string[] };
  fingerprint?: string;
}
export interface PreparedWorkspace { workspace: Workspace; mapping: WorkspaceMapping; report: WorkspaceReport }
export interface SqliteMigrationOptions { source?: string; mappingFile?: string; backupDir?: string; workspaceIds?: string[]; apply?: boolean; resume?: boolean }
interface MigrationReport {
  version: 1; mode: "dry-run" | "applying" | "applied" | "blocked" | "failed";
  source: string; backup: string; backupSha256: string; createdAt: string;
  identitiesVerified: boolean; localUsers: number; localSessionsExcluded: number;
  issues: string[]; workspaces: WorkspaceReport[]; error?: string;
}

function rows(workspace: Workspace, name: Collection): RecordData[] { return (workspace[name] || []) as unknown as RecordData[]; }
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

/** Use decimal digits rather than floating point rounding; PostgreSQL currently stores int4 paise. */
export function rupeesToPaise(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new MigrationError("A receipt/refund amount must be a positive, finite number of rupees.");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new MigrationError("A receipt/refund has fractional paise or an unsafe numeric representation; no rounding is permitted.");
  const paise = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  if (paise > 2_147_483_647n) throw new MigrationError("A receipt/refund exceeds the current PostgreSQL amount_paise integer range; widen the reviewed schema before importing it.");
  if (Math.round(value * 100) !== Number(paise)) throw new MigrationError("The repository's money conversion would change this amount.");
  return Number(paise);
}

function storedValue(name: Collection, row: RecordData, key: string, fallback: unknown) {
  if ((name === "revenue" || name === "refunds") && key === "amountPaise") return rupeesToPaise(row.amount);
  const value = row[key];
  if (name === "jobs" && ["campaignId", "leadId"].includes(key) && value === "") return null;
  return value === undefined ? (fallback ?? null) : value;
}

/** Compare all persisted business fields, IDs, relationships and money, allowing database defaults. */
export function workspaceFingerprint(workspace: Workspace): string {
  const collections = Object.fromEntries(collectionNames.map(name => {
    const columns = getTableColumns(COLLECTIONS[name]);
    return [name, rows(workspace, name).map(row => Object.fromEntries(Object.entries(columns)
      .filter(([key, column]) => key !== "organizationId" && !column.generated)
      .map(([key, column]) => [key, storedValue(name, row, key, column.default)])))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))];
  }));
  const value = {
    organization: { id: workspace.id, workosId: workspace.workosOrganizationId, name: workspace.name, ownerName: workspace.userName, email: workspace.email, demo: workspace.demo, team: workspace.team, courses: workspace.courses, sequence: workspace.sequence, ai: workspace.ai, subscription: workspace.subscription, timezone: workspace.timezone, revision: workspace.revision },
    collections,
    campaignRecipients: workspace.campaigns.flatMap(campaign => campaign.leadIds.map(leadId => `${campaign.id}/${leadId}`)).sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function validateRecords(workspace: Workspace, issues: string[]) {
  for (const name of collectionNames) {
    const columns = getTableColumns(COLLECTIONS[name]);
    const ids = new Set<string>();
    for (const [index, row] of rows(workspace, name).entries()) {
      const label = `${name}[${index}]`;
      if (typeof row.id !== "string" || !row.id || ids.has(row.id)) issues.push(`${label}: missing or duplicate ID.`);
      ids.add(row.id);
      const extra = Object.keys(row).filter(key => !Object.hasOwn(columns, key) && !(name === "campaigns" && key === "leadIds") && !(["revenue", "refunds"].includes(name) && key === "amount"));
      if (extra.length || "organizationId" in row) issues.push(`${label}: unsupported or tenant-routing fields require a reviewed importer update.`);
      for (const [key, column] of Object.entries(columns)) {
        if (key === "organizationId" || column.generated) continue;
        let value: unknown;
        try { value = storedValue(name, row, key, column.default); }
        catch (error) { issues.push(`${label}: ${safeMigrationError(error)}`); continue; }
        if (value === null || value === undefined) { if (column.notNull) issues.push(`${label}.${key}: required value is missing.`); continue; }
        const sqlType = column.getSQLType();
        if (sqlType === "uuid" && !uuid.safeParse(value).success) issues.push(`${label}.${key}: invalid UUID; IDs are never replaced.`);
        else if (column.dataType === "string" && typeof value !== "string") issues.push(`${label}.${key}: expected text.`);
        else if (column.dataType === "boolean" && typeof value !== "boolean") issues.push(`${label}.${key}: expected a boolean.`);
        else if (sqlType === "integer" && (typeof value !== "number" || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647)) issues.push(`${label}.${key}: outside the PostgreSQL integer range.`);
        if (key.endsWith("At") && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) issues.push(`${label}.${key}: a timestamp with an explicit UTC offset is required.`);
      }
    }
  }
  const ids = (name: Collection) => new Set(rows(workspace, name).map(row => row.id));
  const leadIds = ids("leads"), campaignIds = ids("campaigns"), paymentIds = ids("revenue"), messageIds = ids("messages"), fileIds = ids("files"), memberIds = ids("members");
  const reference = (value: unknown, allowed: Set<string>, label: string, optional = false) => {
    if (optional && (value === null || value === undefined || value === "")) return;
    if (typeof value !== "string" || !allowed.has(value)) issues.push(`${label}: missing reference in this workspace.`);
  };
  const phones = new Map<string, string>();
  for (const lead of workspace.leads) {
    const normalized = typeof lead.phone === "string" ? normalizePhone(lead.phone) : null;
    if (!normalized) issues.push(`leads/${lead.id}: invalid phone number.`);
    else if (phones.has(normalized)) issues.push(`leads/${lead.id}: duplicate normalized phone; review rather than merge or delete records.`);
    else phones.set(normalized, lead.id);
    if (!Array.isArray(lead.tags || []) || !(lead.tags || []).every(tag => typeof tag === "string") || !stringMap.safeParse(lead.customFields || {}).success) issues.push(`leads/${lead.id}: invalid tags or custom fields.`);
    if (!["unknown", "opted_in", "opted_out"].includes(lead.consent)) issues.push(`leads/${lead.id}: invalid consent state.`);
    if (!(STAGES as readonly string[]).includes(lead.stage)) issues.push(`leads/${lead.id}: unsupported pipeline stage.`);
    if (typeof lead.value !== "number" || lead.value < 0) issues.push(`leads/${lead.id}: pipeline value must be nonnegative integer rupees.`);
    reference(lead.lastInboundMessageId, messageIds, `leads/${lead.id}.lastInboundMessageId`, true);
    if (lead.lastInboundMessageId && !workspace.messages.some(message => message.id === lead.lastInboundMessageId && message.leadId === lead.id && message.direction === "inbound")) issues.push(`leads/${lead.id}: latest inbound message belongs to another thread or direction.`);
  }
  for (const campaign of workspace.campaigns) {
    if (!z.array(uuid).safeParse(campaign.leadIds).success || new Set(campaign.leadIds).size !== campaign.leadIds.length) issues.push(`campaigns/${campaign.id}: invalid or duplicate recipient IDs.`);
    else for (const leadId of campaign.leadIds) reference(leadId, leadIds, `campaigns/${campaign.id}.leadIds`);
    if (!z.array(z.number().nonnegative()).safeParse(campaign.delays).success) issues.push(`campaigns/${campaign.id}: invalid delays.`);
  }
  for (const name of ["messages", "jobs", "appointments", "revenue", "activities", "tasks", "files"] as const) {
    for (const row of rows(workspace, name)) reference(row.leadId, leadIds, `${name}/${row.id}.leadId`, ["jobs", "activities", "files"].includes(name));
  }
  for (const name of ["leads", "tasks", "appointments"] as const) for (const row of rows(workspace, name)) reference(row.ownerId, memberIds, `${name}/${row.id}.ownerId`, true);
  for (const name of ["messages", "articles"] as const) for (const row of rows(workspace, name)) reference(row.fileId, fileIds, `${name}/${row.id}.fileId`, true);
  for (const job of workspace.jobs) {
    reference(job.campaignId, campaignIds, `jobs/${job.id}.campaignId`, true);
    for (const key of ["messageId", "sourceMessageId"] as const) {
      reference(job[key], messageIds, `jobs/${job.id}.${key}`, true);
      if (job[key] && workspace.messages.find(message => message.id === job[key])?.leadId !== job.leadId) issues.push(`jobs/${job.id}.${key}: message belongs to another enquiry.`);
    }
    if (!stringMap.safeParse(job.payload || {}).success) issues.push(`jobs/${job.id}: invalid payload.`);
    if ((job.attempts || 0) < 0 || (job.retryGeneration || 0) < 0) issues.push(`jobs/${job.id}: negative attempt/retry count.`);
    if (job.kind === "file.ingest") reference(job.payload?.fileId, fileIds, `jobs/${job.id}.payload.fileId`);
    if (job.kind === "calendar.sync") reference(job.payload?.appointmentId, ids("appointments"), `jobs/${job.id}.payload.appointmentId`);
  }
  const receipts = new Set<string>(), refundReferences = new Set<string>(), refundTotals = new Map<string, bigint>();
  for (const payment of workspace.revenue) {
    reference(payment.campaignId, campaignIds, `revenue/${payment.id}.campaignId`, true);
    const campaign = workspace.campaigns.find(campaign => campaign.id === payment.campaignId);
    if (payment.campaignId && (!Array.isArray(campaign?.leadIds) || !campaign.leadIds.includes(payment.leadId))) issues.push(`revenue/${payment.id}: the enquiry is not a recipient of the referenced campaign.`);
    if (typeof payment.reference !== "string" || !payment.reference.trim() || receipts.has(payment.reference.toUpperCase())) issues.push(`revenue/${payment.id}: missing or case-insensitively duplicate receipt reference.`);
    else receipts.add(payment.reference.toUpperCase());
  }
  for (const refund of workspace.refunds || []) {
    reference(refund.revenueId, paymentIds, `refunds/${refund.id}.revenueId`);
    if (typeof refund.reference !== "string" || !refund.reference.trim() || refundReferences.has(refund.reference.toUpperCase())) issues.push(`refunds/${refund.id}: missing or duplicate refund reference.`);
    else refundReferences.add(refund.reference.toUpperCase());
    try { refundTotals.set(refund.revenueId, (refundTotals.get(refund.revenueId) || 0n) + BigInt(rupeesToPaise(refund.amount))); } catch { /* Reported by column validation. */ }
  }
  for (const payment of workspace.revenue) {
    try { if ((refundTotals.get(payment.id) || 0n) > BigInt(rupeesToPaise(payment.amount))) issues.push(`revenue/${payment.id}: refunds exceed the receipt amount.`); } catch { /* Reported above. */ }
  }
  for (const appointment of workspace.appointments) if (appointment.duration < 15 || appointment.duration > 120) issues.push(`appointments/${appointment.id}: duration must be between 15 and 120 minutes.`);
  for (const file of workspace.files || []) {
    if (file.size < 1 || file.size > 10_000_000 || typeof file.objectKey !== "string" || !file.objectKey.startsWith(`${workspace.id}/`)) issues.push(`files/${file.id}: invalid size or non-tenant-bound R2 object key.`);
  }
  for (const message of workspace.messages) if (message.fileId) {
    const file = workspace.files?.find(file => file.id === message.fileId);
    if (!file || file.status !== "ready" || !((file.purpose === "attachment" && file.leadId === message.leadId) || (file.purpose === "knowledge" && !file.leadId))) issues.push(`messages/${message.id}: attachment is not ready or is bound to another enquiry.`);
  }
  const uniqueValues = (name: Collection, keys: string[]) => {
    const values = new Set<string>();
    for (const row of rows(workspace, name)) {
      const parts = keys.map(key => row[key] ?? (name === "jobs" && key === "kind" ? "followup" : null));
      if (parts.some(value => value === null)) continue;
      const value = JSON.stringify(parts);
      if (values.has(value)) issues.push(`${name}/${row.id}: duplicate ${keys.join("/")} key.`);
      values.add(value);
    }
  };
  uniqueValues("messages", ["providerId"]); uniqueValues("revenue", ["providerId"]);
  uniqueValues("jobs", ["kind", "sourceMessageId"]);
  uniqueValues("connections", ["service"]); uniqueValues("connections", ["service", "externalId"]);
  if (workspace.connections?.some(connection => connection.secret)) issues.push("Stored provider credentials require a separate rekey/reconnect migration before this importer can apply the workspace.");
}

export function prepareWorkspace(raw: unknown, mapping: WorkspaceMapping | undefined, registeredEmails: string[] = []): { report: WorkspaceReport; prepared?: PreparedWorkspace } {
  const parsed = workspaceSchema.safeParse(raw);
  const report: WorkspaceReport = { workspaceId: typeof raw === "object" && raw && "id" in raw && typeof raw.id === "string" ? raw.id : "invalid", classification: "invalid", action: "blocked", issues: [], unresolvedOwnerLabels: [] };
  if (!parsed.success) {
    report.issues.push(...parsed.error.issues.map(issue => `Invalid aggregate field at ${issue.path.join(".") || "workspace"} (${issue.code}).`));
    return { report };
  }
  const workspace = parsed.data as unknown as Workspace;
  report.classification = workspace.demo ? "demo" : registeredEmails.length ? "registered" : "unregistered";
  report.counts = Object.fromEntries(collectionNames.map(name => [name, rows(workspace, name).length]));
  if (workspace.demo) { report.action = "excluded"; return { report }; }
  const originalMembers = workspace.members || [];
  const labels = new Set([workspace.userName, ...workspace.team, ...workspace.leads.map(row => row.owner), ...workspace.appointments.map(row => row.owner), ...workspace.tasks!.map(row => row.owner)].filter(label => typeof label === "string" && label && label !== "Unassigned"));
  if (!mapping) {
    report.issues.push("An explicit WorkOS organization, owner and membership mapping is required.");
    report.unresolvedOwnerLabels = [...labels].sort();
  } else {
    if (mapping.workspaceId !== workspace.id || (workspace.workosOrganizationId && workspace.workosOrganizationId !== mapping.workosOrganizationId)) report.issues.push("The WorkOS mapping does not match the source workspace.");
    const byLabel = new Map<string, Member>(), byLegacy = new Map<string, Member>(), userIds = new Set<string>(), membershipIds = new Set<string>();
    workspace.members = [];
    for (const member of mapping.members) {
      const legacy = originalMembers.find(item => item.id === member.legacyMemberId);
      if (member.legacyMemberId && (!legacy || byLegacy.has(member.legacyMemberId))) report.issues.push("A legacy member ID is missing or mapped more than once.");
      if (legacy?.workosId && legacy.workosId !== member.workosUserId) report.issues.push("A mapped member already has a different WorkOS identity.");
      if (userIds.has(member.workosUserId) || membershipIds.has(member.workosMembershipId)) report.issues.push("A WorkOS user or membership is mapped more than once in this institute.");
      userIds.add(member.workosUserId); membershipIds.add(member.workosMembershipId);
      const projected: Member = { id: legacy?.id || member.workosMembershipId, name: member.name, email: member.email, role: member.role, status: member.status, workosId: member.workosUserId };
      workspace.members.push(projected);
      if (member.legacyMemberId) byLegacy.set(member.legacyMemberId, projected);
      for (const label of member.ownerLabels) {
        if (byLabel.has(label) || mapping.historicalOwnerLabels.includes(label)) report.issues.push("An owner label has multiple identity/historical mappings.");
        byLabel.set(label, projected);
      }
    }
    for (const legacy of originalMembers) if (!byLegacy.has(legacy.id)) report.issues.push(`members/${legacy.id}: an explicit legacyMemberId mapping is required to preserve this member ID.`);
    const owner = workspace.members.find(member => member.workosId === mapping.ownerWorkosUserId && member.role === "owner" && member.status === "active");
    if (!owner) report.issues.push("The designated WorkOS owner must have an explicit active owner membership.");
    const mappedEmails = new Set(mapping.members.flatMap(member => [member.email, ...member.legacyEmails]).map(email => email.toLowerCase()));
    if (registeredEmails.some(email => !mappedEmails.has(email.toLowerCase()))) report.issues.push("Every registered SQLite user's email needs an explicit member/legacyEmails mapping.");
    report.unresolvedOwnerLabels = [...labels].filter(label => !byLabel.has(label) && !mapping.historicalOwnerLabels.includes(label)).sort();
    if (report.unresolvedOwnerLabels.length) report.issues.push("Some owner labels need an explicit membership mapping or historicalOwnerLabels entry.");
    report.changes = { heldJobIds: [], heldMessageIds: [], pausedCampaignIds: [], canonicalReceiptIds: [], previousSequenceEnabled: workspace.sequence.enabled, previousAiMode: workspace.ai?.mode || "legacy-default", assignedRecordIds: [] };
    for (const name of ["leads", "tasks", "appointments"] as const) for (const row of rows(workspace, name)) {
      const member = byLabel.get(String(row.owner));
      if (row.ownerId && member && row.ownerId !== member.id) report.issues.push(`${name}/${row.id}: the existing ownerId conflicts with the explicit label mapping.`);
      row.ownerId = member && member.status === "active" && member.role !== "analyst" ? member.id : null;
      if (row.ownerId && member) { row.owner = member.name; report.changes.assignedRecordIds.push(`${name}/${row.id}`); }
    }
    workspace.workosOrganizationId = mapping.workosOrganizationId;
    if (owner) { workspace.userName = owner.name; workspace.email = owner.email; }
    workspace.team = [...new Set(workspace.members.filter(member => member.status === "active" && member.role !== "analyst").map(member => member.name))];
  }
  // Set explicit members before hydration: never synthesize identities from names.
  workspace.members ||= [];
  hydrateWorkspace(workspace);
  delete workspace.actor; delete workspace.integrations;
  validateRecords(workspace, report.issues);
  try {
    const gross = workspace.revenue.reduce((sum, row) => sum + BigInt(rupeesToPaise(row.amount)), 0n);
    const refunded = workspace.refunds!.reduce((sum, row) => sum + BigInt(rupeesToPaise(row.amount)), 0n);
    report.money = { currency: "INR", grossPaise: gross.toString(), refundPaise: refunded.toString(), netPaise: (gross - refunded).toString() };
  } catch { /* The individual invalid amounts are in issues. */ }
  if (report.issues.length || !mapping) return { report };
  for (const payment of workspace.revenue) {
    if (payment.reference !== payment.reference.toUpperCase()) report.changes!.canonicalReceiptIds.push(payment.id);
    payment.reference = payment.reference.toUpperCase();
  }
  // Importing old due jobs must not replay provider side effects at cutover.
  workspace.sequence.enabled = false; workspace.ai!.mode = "paused";
  for (const campaign of workspace.campaigns) if (campaign.status === "active") { report.changes!.pausedCampaignIds.push(campaign.id); campaign.status = "paused"; }
  for (const job of workspace.jobs) if (["pending", "processing"].includes(job.status)) {
    report.changes!.heldJobIds.push(job.id); job.status = "reconcile";
    job.error = "Held during SQLite import. Reconcile provider state before resuming.";
  }
  for (const message of workspace.messages) if (message.direction === "outbound" && message.status === "queued") {
    report.changes!.heldMessageIds.push(message.id); message.status = "reconcile";
  }
  report.action = "ready"; report.counts.members = workspace.members!.length;
  report.counts.campaignRecipients = workspace.campaigns.reduce((count, campaign) => count + campaign.leadIds.length, 0);
  report.fingerprint = workspaceFingerprint(workspace);
  return { report, prepared: { workspace, mapping, report } };
}

/** Read-only WorkOS lookups, only on --apply. No account, organization or invitation is created. */
export async function verifyWorkosMappings(entries: PreparedWorkspace[], workos: Pick<WorkOS, "organizations" | "userManagement">) {
  for (const { mapping } of entries) {
    const organization = await workos.organizations.getOrganization(mapping.workosOrganizationId);
    if (organization.id !== mapping.workosOrganizationId) throw new MigrationError("WorkOS organization verification failed.");
    for (const member of mapping.members) {
      const membership = await workos.userManagement.getOrganizationMembership(member.workosMembershipId);
      const user = await workos.userManagement.getUser(member.workosUserId);
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email.split("@")[0];
      if (membership.id !== member.workosMembershipId || membership.organizationId !== mapping.workosOrganizationId || membership.userId !== member.workosUserId || membership.status !== member.status || membership.role.slug !== member.role || user.id !== member.workosUserId || !user.emailVerified || user.email.toLowerCase() !== member.email.toLowerCase() || name !== member.name) {
        throw new MigrationError("A WorkOS identity, verified email, display name, organization, role or membership status differs from the reviewed mapping.");
      }
    }
  }
}

/** The CLI holds an advisory lock and verifies WorkOS before reaching this repository-only writer. */
export async function importPreparedWorkspaces(entries: PreparedWorkspace[], resume = false, progress?: () => Promise<void>) {
  const db = database();
  const privilege = await db.execute<{ allowed: boolean }>(sql`SELECT rolsuper OR rolbypassrls AS allowed FROM pg_roles WHERE rolname = current_user`);
  if (privilege.rows[0]?.allowed !== true) throw new MigrationError("The importer requires the direct migration role with BYPASSRLS to detect cross-tenant ID collisions. Do not grant this to runtime services.");
  const pending: PreparedWorkspace[] = [];
  const seen = new Set<string>();
  // Check the entire selection before the first write; never silently upsert an existing tenant.
  for (const entry of entries) {
    const { workspace, mapping, report } = entry;
    if (report.issues.length || report.fingerprint !== workspaceFingerprint(workspace)) throw new MigrationError("The prepared import changed or has unresolved validation errors.");
    for (const name of collectionNames) for (const row of rows(workspace, name)) {
      const key = `${name}/${row.id}`;
      if (seen.has(key)) throw new MigrationError("The source selection contains a record ID shared by multiple workspaces.");
      seen.add(key);
    }
    const routes = await db.select().from(tables.organizationRoutes).where(or(eq(tables.organizationRoutes.organizationId, workspace.id), eq(tables.organizationRoutes.workosId, mapping.workosOrganizationId)));
    const organizations = await db.select().from(tables.organizations).where(or(eq(tables.organizations.id, workspace.id), eq(tables.organizations.workosId, mapping.workosOrganizationId)));
    if (routes.length || organizations.length) {
      if (!resume || routes.length !== 1 || organizations.length !== 1 || routes[0].organizationId !== workspace.id || routes[0].workosId !== mapping.workosOrganizationId || organizations[0].id !== workspace.id || organizations[0].workosId !== mapping.workosOrganizationId) throw new MigrationError("A target workspace or WorkOS route already exists. --resume only accepts an identical completed import.");
      if (workspaceFingerprint(await loadPostgresWorkspace(workspace.id)) !== report.fingerprint) throw new MigrationError("An existing workspace differs from the prepared import; refusing to overwrite it.");
      report.action = "skipped-identical";
      continue;
    }
    for (const name of collectionNames) {
      const table: TenantTable = COLLECTIONS[name], sourceIds = rows(workspace, name).map(row => row.id);
      for (let index = 0; index < sourceIds.length; index += 250) {
        const collisions = await db.select({ id: table.id }).from(table).where(inArray(table.id, sourceIds.slice(index, index + 250))).limit(1);
        if (collisions.length) throw new MigrationError(`A target ${name} record already uses a source ID. No records are overwritten.`);
      }
    }
    pending.push(entry);
  }
  await progress?.();
  for (const { workspace, mapping, report } of pending) {
    await createPostgresWorkspace(workspace, mapping.workosOrganizationId);
    report.action = "verification-failed";
    await progress?.();
    if (workspaceFingerprint(await loadPostgresWorkspace(workspace.id)) !== report.fingerprint) throw new MigrationError("A committed workspace failed its persisted-field/money verification. Stop cutover and inspect the report and backup.");
    report.action = "imported";
    await progress?.();
  }
}

async function checksum(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyImportMigrationHistory(client: Pick<Client, "query">, plan: Awaited<ReturnType<typeof migrationPlan>>) {
  const table = await client.query<{ name: string | null }>("SELECT to_regclass('drizzle.__drizzle_migrations')::text AS name");
  if (!table.rows[0]?.name) throw new MigrationError("Apply the full Drizzle journal before importing SQLite workspaces.");
  const history = (await client.query<{ hash: string; created_at: string }>("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id")).rows;
  verifyMigrationHistory(plan, history);
  if (history.length !== plan.length) throw new MigrationError("Apply the full Drizzle journal before importing SQLite workspaces.");
}

export async function runSqliteMigration(options: SqliteMigrationOptions = {}) {
  if (options.resume && !options.apply) throw new MigrationError("--resume requires --apply.");
  const source = await realpath(resolve(options.source || process.env.ADMITFLOW_DB || ".data/admitflow.sqlite"));
  if (!(await stat(source)).isFile()) throw new MigrationError("The SQLite source must be an existing file.");
  const backupRoot = resolve(options.backupDir || ".data/migration-backups");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(backupRoot, "import-"));
  await chmod(directory, 0o700);
  const backupFile = join(directory, "snapshot.sqlite"), reportFile = join(directory, "report.json");
  const sourceDb = new DatabaseSync(source, { readOnly: true, timeout: 5000, allowExtension: false });
  try { await backup(sourceDb, backupFile); } finally { sourceDb.close(); }
  await chmod(backupFile, 0o600);
  // Read the coherent backup, not a changing live aggregate. SQLite backup includes committed WAL data.
  const snapshot = new DatabaseSync(backupFile, { readOnly: true, allowExtension: false });
  let aggregates: { id: string; data: string }[], users: { email: string; workspace_id: string }[], sessionCount = 0;
  try {
    if (Object.values(snapshot.prepare("PRAGMA quick_check").get() || {})[0] !== "ok") throw new MigrationError("The SQLite backup did not pass its integrity check.");
    const tableNames = new Set((snapshot.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    if (!tableNames.has("workspaces")) throw new MigrationError("The source is not an AdmitFlow SQLite aggregate database.");
    aggregates = snapshot.prepare("SELECT id, data FROM workspaces ORDER BY id").all() as { id: string; data: string }[];
    users = tableNames.has("users") ? snapshot.prepare("SELECT email, workspace_id FROM users").all() as { email: string; workspace_id: string }[] : [];
    sessionCount = tableNames.has("sessions") ? Number((snapshot.prepare("SELECT count(*) AS count FROM sessions").get() as { count: number }).count) : 0;
  } finally { snapshot.close(); }
  const report: MigrationReport = { version: 1, mode: "dry-run", source, backup: backupFile, backupSha256: await checksum(backupFile), createdAt: new Date().toISOString(), identitiesVerified: false, localUsers: users.length, localSessionsExcluded: sessionCount, issues: [], workspaces: [] };
  const writeReport = () => writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  let mappings: WorkspaceMapping[] = [];
  if (options.mappingFile) {
    try { mappings = mappingSchema.parse(JSON.parse(await readFile(resolve(options.mappingFile), "utf8"))).workspaces; }
    catch { report.issues.push("The mapping file is unreadable or does not match mapping format version 1."); }
  }
  const mappedWorkspaces = new Set<string>(), mappedOrgs = new Set<string>();
  for (const mapping of mappings) {
    if (mappedWorkspaces.has(mapping.workspaceId) || mappedOrgs.has(mapping.workosOrganizationId)) report.issues.push("Workspace and WorkOS organization mappings must be one-to-one.");
    if (!aggregates.some(row => row.id === mapping.workspaceId)) report.issues.push("The mapping contains a workspace absent from the source backup.");
    mappedWorkspaces.add(mapping.workspaceId); mappedOrgs.add(mapping.workosOrganizationId);
  }
  const selected = new Set(options.workspaceIds || []), entries: PreparedWorkspace[] = [], sourceIds = new Set(aggregates.map(row => row.id));
  if ([...selected].some(id => !sourceIds.has(id))) report.issues.push("A selected workspace is absent from the source backup.");
  if (users.some(user => !sourceIds.has(user.workspace_id))) report.issues.push("SQLite users reference missing workspaces; reconcile these registrations first.");
  for (const aggregate of aggregates) {
    if (selected.size && !selected.has(aggregate.id)) continue;
    let raw: unknown;
    try { raw = JSON.parse(aggregate.data); } catch { report.issues.push("A selected SQLite workspace contains invalid JSON."); continue; }
    if (!raw || typeof raw !== "object" || !("id" in raw) || raw.id !== aggregate.id) { report.issues.push("A SQLite row ID differs from its aggregate workspace ID."); continue; }
    const result = prepareWorkspace(raw, mappings.find(mapping => mapping.workspaceId === aggregate.id), users.filter(user => user.workspace_id === aggregate.id).map(user => user.email));
    report.workspaces.push(result.report);
    if (result.prepared) entries.push(result.prepared);
  }
  const seen = new Set<string>();
  for (const entry of entries) for (const name of collectionNames) for (const row of rows(entry.workspace, name)) {
    const key = `${name}/${row.id}`;
    if (seen.has(key)) report.issues.push("A source record ID is shared by multiple selected workspaces.");
    seen.add(key);
  }
  if (report.issues.length || report.workspaces.some(workspace => workspace.issues.length)) report.mode = "blocked";
  await writeReport();
  if (!options.apply || report.mode === "blocked") return { report, reportFile };
  if (!entries.length) throw new MigrationError("No non-demo workspaces were selected for import.");

  let lockClient: Client | undefined, locked = false, repositoryOpened = false;
  try {
    const connectionString = unpooledDatabaseUrl();
    if (!process.env.WORKOS_API_KEY) throw new MigrationError("WORKOS_API_KEY is required to verify the explicit identity mappings on --apply.");
    await verifyWorkosMappings(entries, new WorkOS(process.env.WORKOS_API_KEY));
    report.identitiesVerified = true;
    const plan = await migrationPlan();
    lockClient = new Client({ connectionString, connectionTimeoutMillis: 15_000, application_name: "admitflow-sqlite-import-lock" });
    await lockClient.connect();
    locked = (await lockClient.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(194821, 1) AS acquired")).rows[0]?.acquired === true;
    if (!locked) throw new MigrationError("Another AdmitFlow migration or SQLite import is running.");
    await verifyImportMigrationHistory(lockClient, plan);
    process.env.DATABASE_URL = connectionString;
    process.env.DATABASE_POOL_SIZE = "2";
    report.mode = "applying"; await writeReport();
    repositoryOpened = true;
    await importPreparedWorkspaces(entries, options.resume, writeReport);
    report.mode = "applied";
  } catch (error) {
    report.mode = "failed"; report.error = safeMigrationError(error);
  } finally {
    if (lockClient) {
      if (locked) await lockClient.query("SELECT pg_advisory_unlock(194821, 1)").catch(() => undefined);
      await lockClient.end().catch(() => undefined);
    }
    // Drizzle exposes its underlying client; close the repository pool without relying on globals.
    if (repositoryOpened) {
      await (database() as unknown as { $client?: Pool }).$client?.end();
    }
    await writeReport();
  }
  return { report, reportFile };
}

async function main() {
  const { values } = parseArgs({ options: {
    source: { type: "string" }, mapping: { type: "string" }, "backup-dir": { type: "string" }, workspace: { type: "string", multiple: true },
    apply: { type: "boolean" }, "dry-run": { type: "boolean" }, resume: { type: "boolean" }, help: { type: "boolean" },
  }, strict: true });
  if (values.help) {
    console.log("Usage: tsx scripts/migrate-sqlite.ts [--source FILE] [--mapping FILE] [--backup-dir DIR] [--workspace UUID ...] [--apply [--resume]]\nDefault: back up SQLite and write a dry-run report; no network calls. --apply verifies WorkOS and imports via the repository into DATABASE_URL_UNPOOLED. See docs/deployment.md for the mapping format and cutover procedure.");
    return;
  }
  if (values.apply && values["dry-run"]) throw new MigrationError("Choose either --apply or --dry-run.");
  config({ path: ".env.local", quiet: true });
  const { report, reportFile } = await runSqliteMigration({ source: values.source, mappingFile: values.mapping, backupDir: values["backup-dir"], workspaceIds: values.workspace, apply: values.apply, resume: values.resume });
  console.log(JSON.stringify({ mode: report.mode, reportFile, backup: report.backup, backupSha256: report.backupSha256, workspaces: report.workspaces.length, imported: report.workspaces.filter(workspace => workspace.action === "imported").length, issues: report.issues.length + report.workspaces.reduce((sum, workspace) => sum + workspace.issues.length, 0) }, null, 2));
  if (["failed", "blocked"].includes(report.mode)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(safeMigrationError(error)); process.exitCode = 1; });
}
