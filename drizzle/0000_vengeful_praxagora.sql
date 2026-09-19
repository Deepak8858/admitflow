CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid,
	"text" text NOT NULL,
	"created_at" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"starts_at" text NOT NULL,
	"duration" integer NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"external_id" text,
	"meeting_url" text,
	"sync_status" text DEFAULT 'local' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"updated_at" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"file_id" uuid
);
--> statement-breakpoint
CREATE TABLE "campaign_recipients" (
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	CONSTRAINT "campaign_recipients_organization_id_campaign_id_lead_id_pk" PRIMARY KEY("organization_id","campaign_id","lead_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"course" text NOT NULL,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"created_at" text NOT NULL,
	"delays" jsonb NOT NULL,
	"template_name" text,
	"template_language" text
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"service" text NOT NULL,
	"status" text NOT NULL,
	"external_id" text NOT NULL,
	"label" text NOT NULL,
	"updated_at" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"secret" text
);
--> statement-breakpoint
CREATE TABLE "event_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"provider" text NOT NULL,
	"received_at" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"purpose" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"object_key" text NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"campaign_id" uuid,
	"lead_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"due_at" text NOT NULL,
	"status" text NOT NULL,
	"kind" text DEFAULT 'followup' NOT NULL,
	"error" text,
	"message_id" uuid,
	"source_message_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"course" text NOT NULL,
	"source" text NOT NULL,
	"stage" text NOT NULL,
	"owner" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"next_action" text DEFAULT '' NOT NULL,
	"next_action_at" text,
	"created_at" text NOT NULL,
	"last_contact_at" text,
	"last_inbound_at" text,
	"consent" text DEFAULT 'unknown' NOT NULL,
	"consent_source" text DEFAULT '' NOT NULL,
	"consent_at" text,
	"is_minor" boolean DEFAULT false NOT NULL,
	"guardian_consent" boolean DEFAULT false NOT NULL,
	"human_owned" boolean DEFAULT false NOT NULL,
	"unread" boolean DEFAULT false NOT NULL,
	"whatsapp_id" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"workos_id" text
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"body" text NOT NULL,
	"direction" text NOT NULL,
	"author" text NOT NULL,
	"status" text NOT NULL,
	"created_at" text NOT NULL,
	"provider_id" text,
	"source" text,
	"file_id" uuid,
	"media_type" text,
	"provider_media_id" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workos_id" text,
	"name" text NOT NULL,
	"owner_name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"team" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"courses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence" jsonb NOT NULL,
	"ai" jsonb NOT NULL,
	"subscription" jsonb NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "organizations_workos_id_unique" UNIQUE("workos_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"recorded_at" text NOT NULL,
	"campaign_id" uuid,
	"reference" text NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"provider_id" text
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"revenue_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"reference" text NOT NULL,
	"recorded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"course" text NOT NULL,
	"stage" text NOT NULL,
	"owner" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"title" text NOT NULL,
	"owner" text NOT NULL,
	"due_at" text NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
-- Composite references require their unique indexes before the foreign keys.
CREATE UNIQUE INDEX "campaigns_tenant_id" ON "campaigns" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_tenant_id" ON "leads" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_id" ON "payments" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_organization_id_campaign_id_campaigns_organization_id_id_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_revenue_id_payments_organization_id_id_fk" FOREIGN KEY ("organization_id","revenue_id") REFERENCES "public"."payments"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_recent" ON "activities" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "appointments_owner_time" ON "appointments" USING btree ("organization_id","owner","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_service" ON "connections" USING btree ("organization_id","service");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_external" ON "connections" USING btree ("service","external_id");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("organization_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_tenant_phone" ON "leads" USING btree ("organization_id","phone");--> statement-breakpoint
CREATE INDEX "leads_tenant_stage_owner" ON "leads" USING btree ("organization_id","stage","owner");--> statement-breakpoint
CREATE INDEX "leads_tenant_due" ON "leads" USING btree ("organization_id","next_action_at");--> statement-breakpoint
CREATE UNIQUE INDEX "members_identity" ON "members" USING btree ("organization_id","workos_id");--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("organization_id","lead_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id" ON "messages" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt" ON "payments" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider" ON "payments" USING btree ("organization_id","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_reference" ON "refunds" USING btree ("organization_id","reference");--> statement-breakpoint
CREATE INDEX "tasks_due" ON "tasks" USING btree ("organization_id","status","due_at");
