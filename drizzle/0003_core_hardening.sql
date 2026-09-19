CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body) || to_tsvector('simple', title || ' ' || body)) STORED
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "etag" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "finalized_at" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "uploaded_by" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dispatched_at" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "retry_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_inbound_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "received_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "status_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "dispatched_at" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "dispatch_state" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "voice_fallback" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "owner_id" text;--> statement-breakpoint
-- Referenced composite keys must exist before adding their foreign keys.
CREATE UNIQUE INDEX "articles_tenant_id" ON "articles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_tenant_id" ON "files" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "members_tenant_id" ON "members" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_tenant_lead_id" ON "messages" USING btree ("organization_id","lead_id","id");--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_organization_id_article_id_articles_organization_id_id_fk" FOREIGN KEY ("organization_id","article_id") REFERENCES "public"."articles"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_article_order" ON "knowledge_chunks" USING btree ("organization_id","article_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_search" ON "knowledge_chunks" USING gin ("search");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_owner_id_members_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_id") REFERENCES "public"."members"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_organization_id_file_id_files_organization_id_id_fk" FOREIGN KEY ("organization_id","file_id") REFERENCES "public"."files"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_organization_id_lead_id_leads_organization_id_id_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_campaign_id_campaigns_organization_id_id_fk" FOREIGN KEY ("organization_id","campaign_id") REFERENCES "public"."campaigns"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_lead_id_message_id_messages_organization_id_lead_id_id_fk" FOREIGN KEY ("organization_id","lead_id","message_id") REFERENCES "public"."messages"("organization_id","lead_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_lead_id_source_message_id_messages_organization_id_lead_id_id_fk" FOREIGN KEY ("organization_id","lead_id","source_message_id") REFERENCES "public"."messages"("organization_id","lead_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_organization_id_owner_id_members_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_id") REFERENCES "public"."members"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_file_id_files_organization_id_id_fk" FOREIGN KEY ("organization_id","file_id") REFERENCES "public"."files"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_campaign_id_lead_id_campaign_recipients_organization_id_campaign_id_lead_id_fk" FOREIGN KEY ("organization_id","campaign_id","lead_id") REFERENCES "public"."campaign_recipients"("organization_id","campaign_id","lead_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_owner_id_members_organization_id_id_fk" FOREIGN KEY ("organization_id","owner_id") REFERENCES "public"."members"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_tenant_owner_id" ON "leads" USING btree ("organization_id","owner_id","created_at","id");--> statement-breakpoint
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON knowledge_chunks USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE leads ADD CONSTRAINT leads_latest_inbound_tenant_fk FOREIGN KEY (organization_id, id, last_inbound_message_id) REFERENCES messages (organization_id, lead_id, id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE members ADD CONSTRAINT members_role_valid CHECK (role IN ('owner', 'admin', 'counsellor', 'analyst'));
ALTER TABLE leads ADD CONSTRAINT lead_value_nonnegative CHECK (value >= 0);
ALTER TABLE files ADD CONSTRAINT file_size_valid CHECK (size BETWEEN 1 AND 10000000);
ALTER TABLE files ADD CONSTRAINT file_key_tenant_bound CHECK (object_key LIKE organization_id::text || '/%');
ALTER TABLE jobs ADD CONSTRAINT job_attempts_nonnegative CHECK (attempts >= 0 AND retry_generation >= 0);
CREATE UNIQUE INDEX jobs_inbound_reply ON jobs (organization_id, kind, source_message_id);
CREATE UNIQUE INDEX refunds_reference_case_insensitive ON refunds (organization_id, lower(reference));
--> statement-breakpoint
-- Explicit legacy-only backfill. Never turn a matching WorkOS display name into
-- an identity claim. Original member, lead and history IDs are retained.
DO $$
DECLARE tenant_id uuid; target_table text;
BEGIN
  FOR tenant_id IN SELECT organization_id FROM organization_routes LOOP
    PERFORM set_config('app.organization_id', tenant_id::text, true);
    FOREACH target_table IN ARRAY ARRAY['leads', 'tasks', 'appointments'] LOOP
      EXECUTE format('WITH legacy AS (SELECT organization_id, name, min(id) AS id FROM members WHERE organization_id = $1 AND status = ''active'' GROUP BY organization_id, name HAVING count(*) = 1 AND bool_and(workos_id IS NULL)) UPDATE %I AS item SET owner_id = legacy.id FROM legacy WHERE item.organization_id = legacy.organization_id AND item.owner = legacy.name AND item.owner_id IS NULL', target_table) USING tenant_id;
    END LOOP;
    UPDATE messages SET status = 'accepted', dispatch_state = 'accepted', dispatched_at = created_at
      WHERE organization_id = tenant_id AND direction = 'outbound' AND status IN ('queued', 'sent') AND provider_id IS NOT NULL AND coalesce(source, '') <> 'business-app'
      AND EXISTS (SELECT 1 FROM organizations WHERE id = tenant_id AND NOT demo);
    UPDATE messages SET status = 'reconcile', dispatch_state = 'uncertain', dispatched_at = created_at
      WHERE organization_id = tenant_id AND direction = 'outbound' AND status IN ('queued', 'failed') AND provider_id IS NULL
      AND EXISTS (SELECT 1 FROM organizations WHERE id = tenant_id AND NOT demo);
    UPDATE jobs SET status = 'accepted' FROM messages WHERE jobs.organization_id = tenant_id AND messages.organization_id = tenant_id AND jobs.message_id = messages.id AND messages.status = 'accepted';
    UPDATE jobs SET status = 'reconcile', dispatched_at = messages.dispatched_at FROM messages WHERE jobs.organization_id = tenant_id AND messages.organization_id = tenant_id AND jobs.message_id = messages.id AND messages.status = 'reconcile';
  END LOOP;
  PERFORM set_config('app.organization_id', '', true);
END $$;
--> statement-breakpoint
CREATE FUNCTION enforce_refund_balance() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE payment_amount integer; refunded bigint;
BEGIN
  SELECT amount_paise INTO payment_amount FROM payments WHERE organization_id = NEW.organization_id AND id = NEW.revenue_id FOR UPDATE;
  IF payment_amount IS NULL THEN RAISE EXCEPTION 'Payment not found in tenant'; END IF;
  SELECT coalesce(sum(amount_paise), 0) INTO refunded FROM refunds WHERE organization_id = NEW.organization_id AND revenue_id = NEW.revenue_id AND id <> NEW.id;
  IF refunded + NEW.amount_paise > payment_amount THEN RAISE EXCEPTION 'Refund exceeds remaining payment'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refund_balance BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION enforce_refund_balance();
CREATE FUNCTION enforce_payment_balance() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE refunded bigint;
BEGIN
  SELECT coalesce(sum(amount_paise), 0) INTO refunded FROM refunds WHERE organization_id = NEW.organization_id AND revenue_id = NEW.id;
  IF refunded > NEW.amount_paise THEN RAISE EXCEPTION 'Payment cannot be reduced below its refunds'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_balance BEFORE UPDATE OF amount_paise ON payments FOR EACH ROW EXECUTE FUNCTION enforce_payment_balance();
--> statement-breakpoint
CREATE FUNCTION enforce_message_attachment() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE attachment files%ROWTYPE;
BEGIN
  IF NEW.file_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO attachment FROM files WHERE organization_id = NEW.organization_id AND id = NEW.file_id;
  IF NOT FOUND OR attachment.status <> 'ready' OR NOT ((attachment.purpose = 'attachment' AND attachment.lead_id = NEW.lead_id) OR (attachment.purpose = 'knowledge' AND attachment.lead_id IS NULL)) THEN
    RAISE EXCEPTION 'Attachment is not ready or belongs to another enquiry';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_attachment BEFORE INSERT OR UPDATE OF organization_id, lead_id, file_id ON messages FOR EACH ROW EXECUTE FUNCTION enforce_message_attachment();
