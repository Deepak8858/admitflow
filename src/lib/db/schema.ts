import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex, primaryKey, foreignKey, customType, check, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { AiSettings, Subscription, Role, WorkspaceFile, Connection, Job, LeadView, LeadSort } from "../domain";
import { instant } from "./instant";
export { whatsappSubscriptionOperations } from "./whatsapp-schema";

const finiteInstants = (...columns: AnyPgColumn[]) => columns.map(column => check(`${column.name}_finite`, sql`isfinite(${column}) and ${column} >= '0001-01-01T00:00:00Z'::timestamptz and ${column} < '10000-01-01T00:00:00Z'::timestamptz`));

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey(), workosId: text("workos_id").unique(), name: text("name").notNull(),
  ownerName: text("owner_name").notNull(), email: text("email").notNull().default(""), demo: boolean("demo").notNull().default(false),
  team: jsonb("team").$type<string[]>().notNull().default([]), courses: jsonb("courses").$type<string[]>().notNull().default([]),
  sequence: jsonb("sequence").$type<{ enabled: boolean; delays: number[] }>().notNull(),
  ai: jsonb("ai").$type<AiSettings>().notNull(), subscription: jsonb("subscription").$type<Subscription>().notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"), revision: integer("revision").notNull().default(0),
});
const tenant = () => ({ id: uuid("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }) });
export const leads = pgTable("leads", {
  ...tenant(), name: text("name").notNull(), phone: text("phone").notNull(), email: text("email").notNull().default(""),
  course: text("course").notNull(), source: text("source").notNull(), stage: text("stage").notNull(), owner: text("owner").notNull(), ownerId: text("owner_id"),
  value: integer("value").notNull().default(0), notes: text("notes").notNull().default(""), nextAction: text("next_action").notNull().default(""),
  nextActionAt: instant("next_action_at"), createdAt: instant("created_at").notNull(), lastContactAt: instant("last_contact_at"), lastInboundAt: instant("last_inbound_at"),
  consent: text("consent").notNull().default("unknown"), consentSource: text("consent_source").notNull().default(""), consentAt: instant("consent_at"),
  isMinor: boolean("is_minor").notNull().default(false), guardianConsent: boolean("guardian_consent").notNull().default(false), humanOwned: boolean("human_owned").notNull().default(false),
  unread: boolean("unread").notNull().default(false), whatsappId: text("whatsapp_id"), lastInboundMessageId: uuid("last_inbound_message_id"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]), customFields: jsonb("custom_fields").$type<Record<string, string>>().notNull().default({}),
}, table => [...finiteInstants(table.nextActionAt, table.createdAt, table.lastContactAt, table.lastInboundAt, table.consentAt), uniqueIndex("leads_tenant_id").on(table.organizationId, table.id), uniqueIndex("leads_tenant_phone").on(table.organizationId, table.phone), index("leads_tenant_stage_owner").on(table.organizationId, table.stage, table.owner), index("leads_tenant_owner_id").on(table.organizationId, table.ownerId, table.createdAt, table.id), index("leads_tenant_due").on(table.organizationId, table.nextActionAt), ownerReference(table)]);
const leadReference = (table: { organizationId: AnyPgColumn; leadId: AnyPgColumn }) => foreignKey({ columns: [table.organizationId, table.leadId], foreignColumns: [leads.organizationId, leads.id] }).onDelete("cascade");
const ownerReference = (table: { organizationId: AnyPgColumn; ownerId: AnyPgColumn }) => foreignKey({ columns: [table.organizationId, table.ownerId], foreignColumns: [members.organizationId, members.id] });

export const messages = pgTable("messages", {
  ...tenant(), leadId: uuid("lead_id").notNull(), body: text("body").notNull(), direction: text("direction").notNull(), author: text("author").notNull(),
  status: text("status").notNull(), createdAt: instant("created_at").notNull(), providerId: text("provider_id"), source: text("source"),
  fileId: uuid("file_id"), mediaType: text("media_type"), providerMediaId: text("provider_media_id"), error: text("error"),
  authorId: text("author_id"), receivedAt: instant("received_at"), statusAt: instant("status_at"), dispatchedAt: instant("dispatched_at"), dispatchState: text("dispatch_state"), voiceFallback: text("voice_fallback"),
}, table => [...finiteInstants(table.createdAt, table.receivedAt, table.statusAt, table.dispatchedAt), leadReference(table), index("messages_thread").on(table.organizationId, table.leadId, table.createdAt), uniqueIndex("messages_provider_id").on(table.organizationId, table.providerId), uniqueIndex("messages_tenant_lead_id").on(table.organizationId, table.leadId, table.id), foreignKey({ columns: [table.organizationId, table.fileId], foreignColumns: [files.organizationId, files.id] })]);
export const campaigns = pgTable("campaigns", {
  ...tenant(), name: text("name").notNull(), course: text("course").notNull(), status: text("status").notNull(), message: text("message").notNull(),
  createdAt: instant("created_at").notNull(), delays: jsonb("delays").$type<number[]>().notNull(), templateName: text("template_name"), templateLanguage: text("template_language"),
}, table => [...finiteInstants(table.createdAt), uniqueIndex("campaigns_tenant_id").on(table.organizationId, table.id)]);
export const campaignRecipients = pgTable("campaign_recipients", {
  organizationId: uuid("organization_id").notNull(), campaignId: uuid("campaign_id").notNull(), leadId: uuid("lead_id").notNull(),
}, table => [primaryKey({ columns: [table.organizationId, table.campaignId, table.leadId] }), leadReference(table), foreignKey({ columns: [table.organizationId, table.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id] }).onDelete("cascade")]);
export const jobs = pgTable("jobs", {
  ...tenant(), campaignId: uuid("campaign_id"), leadId: uuid("lead_id"), step: integer("step").notNull(), dueAt: instant("due_at").notNull(),
  status: text("status").notNull(), kind: text("kind").$type<NonNullable<Job["kind"]>>().notNull().default("followup"),
  error: text("error"), messageId: uuid("message_id"), sourceMessageId: uuid("source_message_id"), attempts: integer("attempts").notNull().default(0), lockedAt: instant("locked_at"), payload: jsonb("payload").$type<Record<string, string>>().notNull().default({}),
  dispatchedAt: instant("dispatched_at"), retryGeneration: integer("retry_generation").notNull().default(0),
}, table => [...finiteInstants(table.dueAt, table.lockedAt, table.dispatchedAt), leadReference(table), index("jobs_due").on(table.organizationId, table.status, table.dueAt), foreignKey({ columns: [table.organizationId, table.campaignId], foreignColumns: [campaigns.organizationId, campaigns.id] }), foreignKey({ columns: [table.organizationId, table.leadId, table.messageId], foreignColumns: [messages.organizationId, messages.leadId, messages.id] }), foreignKey({ columns: [table.organizationId, table.leadId, table.sourceMessageId], foreignColumns: [messages.organizationId, messages.leadId, messages.id] })]);
export const appointments = pgTable("appointments", {
  ...tenant(), leadId: uuid("lead_id").notNull(), owner: text("owner").notNull(), ownerId: text("owner_id"), startsAt: instant("starts_at").notNull(), duration: integer("duration").notNull(),
  kind: text("kind").notNull(), status: text("status").notNull(), externalId: text("external_id"), meetingUrl: text("meeting_url"), syncStatus: text("sync_status").notNull().default("local"),
}, table => [...finiteInstants(table.startsAt), leadReference(table), ownerReference(table), index("appointments_owner_time").on(table.organizationId, table.owner, table.startsAt)]);
export const payments = pgTable("payments", {
  ...tenant(), leadId: uuid("lead_id").notNull(), amountPaise: integer("amount_paise").notNull(), recordedAt: instant("recorded_at").notNull(),
  campaignId: uuid("campaign_id"), reference: text("reference").notNull(), origin: text("origin").notNull().default("manual"), providerId: text("provider_id"),
}, table => [...finiteInstants(table.recordedAt), leadReference(table), uniqueIndex("payments_tenant_id").on(table.organizationId, table.id), uniqueIndex("payments_receipt").on(table.organizationId, table.reference), uniqueIndex("payments_provider").on(table.organizationId, table.providerId), foreignKey({ columns: [table.organizationId, table.campaignId, table.leadId], foreignColumns: [campaignRecipients.organizationId, campaignRecipients.campaignId, campaignRecipients.leadId] })]);
export const refunds = pgTable("refunds", {
  ...tenant(), revenueId: uuid("revenue_id").notNull(), amountPaise: integer("amount_paise").notNull(), reference: text("reference").notNull(), recordedAt: instant("recorded_at").notNull(),
}, table => [...finiteInstants(table.recordedAt), foreignKey({ columns: [table.organizationId, table.revenueId], foreignColumns: [payments.organizationId, payments.id] }).onDelete("cascade"), uniqueIndex("refunds_reference").on(table.organizationId, table.reference)]);
export const articles = pgTable("articles", {
  ...tenant(), title: text("title").notNull(), category: text("category").notNull(), body: text("body").notNull(), updatedAt: instant("updated_at").notNull(), version: integer("version").notNull().default(1), fileId: uuid("file_id"),
}, table => [...finiteInstants(table.updatedAt), uniqueIndex("articles_tenant_id").on(table.organizationId, table.id), foreignKey({ columns: [table.organizationId, table.fileId], foreignColumns: [files.organizationId, files.id] })]);
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
export const knowledgeChunks = pgTable("knowledge_chunks", {
  ...tenant(), articleId: uuid("article_id").notNull(), ordinal: integer("ordinal").notNull(), title: text("title").notNull(), body: text("body").notNull(), version: integer("version").notNull(), contentHash: text("content_hash").notNull(), embeddingModel: text("embedding_model"),
  search: tsvector("search").generatedAlwaysAs(sql`to_tsvector('english', title || ' ' || body) || to_tsvector('simple', title || ' ' || body)`),
}, table => [foreignKey({ columns: [table.organizationId, table.articleId], foreignColumns: [articles.organizationId, articles.id] }).onDelete("cascade"), uniqueIndex("knowledge_chunks_article_order").on(table.organizationId, table.articleId, table.ordinal), index("knowledge_chunks_search").using("gin", table.search)]);
export const activities = pgTable("activities", {
  ...tenant(), leadId: uuid("lead_id"), text: text("text").notNull(), createdAt: instant("created_at").notNull(), kind: text("kind").notNull(),
}, table => [...finiteInstants(table.createdAt), index("activities_recent").on(table.organizationId, table.createdAt)]);
export const tasks = pgTable("tasks", {
  ...tenant(), leadId: uuid("lead_id").notNull(), title: text("title").notNull(), owner: text("owner").notNull(), ownerId: text("owner_id"), dueAt: instant("due_at").notNull(), status: text("status").notNull(),
}, table => [...finiteInstants(table.dueAt), leadReference(table), ownerReference(table), index("tasks_due").on(table.organizationId, table.status, table.dueAt)]);
export const members = pgTable("members", {
  id: text("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }), name: text("name").notNull(), email: text("email").notNull(), role: text("role").$type<Role>().notNull(), status: text("status").notNull(), workosId: text("workos_id"),
}, table => [uniqueIndex("members_identity").on(table.organizationId, table.workosId), uniqueIndex("members_tenant_id").on(table.organizationId, table.id)]);
export const files = pgTable("files", {
  ...tenant(), name: text("name").notNull(), mime: text("mime").notNull(), size: integer("size").notNull(), purpose: text("purpose").$type<WorkspaceFile["purpose"]>().notNull(), status: text("status").notNull(), createdAt: instant("created_at").notNull(), objectKey: text("object_key").notNull(), error: text("error"), leadId: uuid("lead_id"),
  etag: text("etag"), finalizedAt: instant("finalized_at"), uploadedBy: text("uploaded_by"),
}, table => [...finiteInstants(table.createdAt, table.finalizedAt), leadReference(table), uniqueIndex("files_tenant_id").on(table.organizationId, table.id)]);
export const connections = pgTable("connections", {
  ...tenant(), service: text("service").$type<Connection["service"]>().notNull(), status: text("status").notNull(), externalId: text("external_id").notNull(), label: text("label").notNull(), updatedAt: instant("updated_at").notNull(), metadata: jsonb("metadata").$type<Record<string, string>>().notNull(), secret: text("secret"),
}, table => [...finiteInstants(table.updatedAt), uniqueIndex("connections_service").on(table.organizationId, table.service), uniqueIndex("connections_external").on(table.service, table.externalId), uniqueIndex("connections_tenant_binding").on(table.organizationId, table.id, table.service, table.externalId), check("connections_disconnected_secret", sql`${table.status} <> 'disconnected' or ${table.secret} is null`)]);
export const savedViews = pgTable("saved_views", {
  ...tenant(), name: text("name").notNull(), query: text("query").notNull(), course: text("course").notNull(), stage: text("stage").notNull(), owner: text("owner").notNull(),
  view: text("view").$type<LeadView>(), sort: text("sort").$type<LeadSort>(),
}, table => [check("saved_views_view_valid", sql`${table.view} in ('all', 'high-intent', 'needs-followup', 'admitted')`), check("saved_views_sort_valid", sql`${table.sort} in ('intent', 'newest', 'name')`)]);
export const intakeInbox = pgTable("intake_inbox", {
  id: text("id").primaryKey(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull(), service: text("service").$type<"whatsapp" | "meta_leads">().notNull(), externalId: text("external_id").notNull(), contactKey: text("contact_key").notNull(),
  receivedAt: instant("received_at").notNull(), state: text("state").$type<"pending" | "deferred" | "imported" | "expired">().notNull().default("pending"),
  payload: jsonb("payload").$type<import("../intake-types").IntakePayload>(), processedAt: instant("processed_at"), error: text("error"),
  payloadDigest: text("payload_digest").notNull(), contactKeyVersion: text("contact_key_version").notNull().default(""),
  expiresAt: instant("expires_at").notNull(), redactedAt: instant("redacted_at"),
}, table => [...finiteInstants(table.receivedAt, table.processedAt, table.expiresAt, table.redactedAt),
  index("intake_pending_page").on(table.organizationId, table.state, table.id),
  index("intake_pending_contact").on(table.organizationId, table.contactKey).where(sql`${table.state} <> 'imported'`),
  index("intake_expiry_page").on(table.organizationId, table.expiresAt, table.id).where(sql`${table.payload} is not null`),
  index("intake_legacy_contacts").on(table.organizationId, table.expiresAt, table.id).where(sql`${table.contactKeyVersion} = ''`),
  check("intake_payload_size", sql`octet_length(${table.payload}::text) <= 131072`),
  check("intake_retention_state", sql`${table.state} in ('pending', 'deferred', 'imported', 'expired') and (${table.state} <> 'expired' or ${table.payload} is null)`),
  check("intake_retention_dates", sql`${table.expiresAt} <= ${table.receivedAt} + interval '720 hours' and (${table.processedAt} is null or ${table.expiresAt} <= ${table.processedAt} + interval '168 hours') and ((${table.payload} is null) = (${table.redactedAt} is not null))`),
  check("intake_digest_valid", sql`${table.payloadDigest} ~ '^[a-f0-9]{64}$' and (${table.payload} is null or ${table.payloadDigest} = encode(sha256(convert_to(${table.payload}::text, 'UTF8')), 'hex'))`),
  check("intake_contact_digest_valid", sql`${table.contactKeyVersion} = '' or (${table.contactKeyVersion} ~ '^[a-f0-9]{64}$' and (${table.contactKey} = '' or ${table.contactKey} ~ '^[a-f0-9]{64}$'))`),
  foreignKey({ name: "intake_connection_binding", columns: [table.organizationId, table.connectionId, table.service, table.externalId], foreignColumns: [connections.organizationId, connections.id, connections.service, connections.externalId] })]);
// Identity ledger deliberately survives workspace deletion. Never persist it from a Workspace mutation.
export const instituteTrials = pgTable("institute_trials", {
  workosId: text("workos_id").primaryKey(), startedAt: instant("started_at"), endsAt: instant("ends_at"),
  consumed: boolean("consumed").notNull().default(false), provenance: text("provenance").notNull(),
}, table => finiteInstants(table.startedAt, table.endsAt));
// Tenant-scoped receipts: journaled SQL forces RLS. Legacy null-tenant rows stay hidden.
export const eventReceipts = pgTable("event_receipts", {
  id: text("id").primaryKey(), organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }), provider: text("provider").notNull(), receivedAt: instant("received_at").notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), processedAt: instant("processed_at"), error: text("error"),
}, table => [...finiteInstants(table.receivedAt, table.processedAt),
  index("event_receipts_tenant_due").on(table.organizationId, sql`(${table.payload}->>'nextAttemptAt')`, table.id).where(sql`${table.provider} = 'razorpay_admission' and ${table.processedAt} is null`)]);
// Exists before a tenant. Actor RLS and immutable dispatch history are installed by custom SQL.
export const organizationProvisioning = pgTable("organization_provisioning", {
  id: uuid("id").primaryKey(), actorId: text("actor_id").notNull(), clientId: text("client_id").notNull(), requestId: uuid("request_id").notNull(),
  name: text("name").notNull(), externalId: text("external_id").notNull(),
  phase: text("phase").$type<"org_dispatched" | "org_confirmed" | "membership_dispatched" | "ready">().notNull(),
  organizationId: text("organization_id"), membershipId: text("membership_id"), revision: integer("revision").notNull().default(0),
  reviewCode: text("review_code").$type<"identity_mismatch">(), createdAt: instant("created_at").notNull(), updatedAt: instant("updated_at").notNull(), acknowledgedAt: instant("acknowledged_at"),
}, table => [...finiteInstants(table.createdAt, table.updatedAt, table.acknowledgedAt),
  uniqueIndex("provisioning_actor_request").on(table.clientId, table.actorId, table.requestId),
  uniqueIndex("provisioning_actor_pending").on(table.clientId, table.actorId).where(sql`${table.acknowledgedAt} is null`),
  uniqueIndex("provisioning_external_id").on(table.externalId), uniqueIndex("provisioning_provider_org").on(table.clientId, table.organizationId),
  check("provisioning_phase_valid", sql`${table.phase} in ('org_dispatched', 'org_confirmed', 'membership_dispatched', 'ready')`),
  check("provisioning_identity_valid", sql`(${table.phase} = 'org_dispatched' or ${table.organizationId} is not null) and (${table.phase} <> 'ready' or ${table.membershipId} is not null)`),
  check("provisioning_ack_valid", sql`${table.acknowledgedAt} is null or ${table.phase} = 'ready'`),
  check("provisioning_review_valid", sql`${table.reviewCode} is null or ${table.reviewCode} = 'identity_mismatch'`),
  check("provisioning_revision_valid", sql`${table.revision} >= 0`),
]);
export const syncCursors = pgTable("sync_cursors", { id: text("id").primaryKey(), value: text("value").notNull() });
export const organizationRoutes = pgTable("organization_routes", { organizationId: uuid("organization_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }), workosId: text("workos_id").unique() });
export const connectionRoutes = pgTable("connection_routes", { service: text("service").notNull(), externalId: text("external_id").notNull(), organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }) }, table => [primaryKey({ columns: [table.service, table.externalId] })]);
