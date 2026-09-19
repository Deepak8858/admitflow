CREATE TABLE "organization_provisioning" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"client_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"name" text NOT NULL,
	"external_id" text NOT NULL,
	"phase" text NOT NULL,
	"organization_id" text,
	"membership_id" text,
	"revision" integer DEFAULT 0 NOT NULL,
	"review_code" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"acknowledged_at" text,
	CONSTRAINT "provisioning_phase_valid" CHECK ("organization_provisioning"."phase" in ('org_dispatched', 'org_confirmed', 'membership_dispatched', 'ready')),
	CONSTRAINT "provisioning_identity_valid" CHECK (("organization_provisioning"."phase" = 'org_dispatched' or "organization_provisioning"."organization_id" is not null) and ("organization_provisioning"."phase" <> 'ready' or "organization_provisioning"."membership_id" is not null)),
	CONSTRAINT "provisioning_ack_valid" CHECK ("organization_provisioning"."acknowledged_at" is null or "organization_provisioning"."phase" = 'ready'),
	CONSTRAINT "provisioning_review_valid" CHECK ("organization_provisioning"."review_code" is null or "organization_provisioning"."review_code" = 'identity_mismatch'),
	CONSTRAINT "provisioning_revision_valid" CHECK ("organization_provisioning"."revision" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_actor_request" ON "organization_provisioning" USING btree ("client_id","actor_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_actor_pending" ON "organization_provisioning" USING btree ("client_id","actor_id") WHERE "organization_provisioning"."acknowledged_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_external_id" ON "organization_provisioning" USING btree ("external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_provider_org" ON "organization_provisioning" USING btree ("client_id","organization_id");
--> statement-breakpoint
ALTER TABLE organization_provisioning ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organization_provisioning FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY provisioning_actor_scope ON organization_provisioning FOR ALL
USING (actor_id = nullif(current_setting('app.provisioning_actor', true), '') AND client_id = nullif(current_setting('app.provisioning_client', true), ''))
WITH CHECK (actor_id = nullif(current_setting('app.provisioning_actor', true), '') AND client_id = nullif(current_setting('app.provisioning_client', true), ''));
--> statement-breakpoint
CREATE FUNCTION guard_provisioning_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provisioning receipts cannot be deleted';
  END IF;
  IF ROW(NEW.id, NEW.actor_id, NEW.client_id, NEW.request_id, NEW.name, NEW.external_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.actor_id, OLD.client_id, OLD.request_id, OLD.name, OLD.external_id, OLD.created_at)
    OR (OLD.organization_id IS NOT NULL AND NEW.organization_id IS DISTINCT FROM OLD.organization_id)
    OR (OLD.membership_id IS NOT NULL AND NEW.membership_id IS DISTINCT FROM OLD.membership_id)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
    OR (OLD.review_code IS NOT NULL AND NEW.review_code IS DISTINCT FROM OLD.review_code)
    OR NEW.revision <> OLD.revision + 1
    OR array_position(ARRAY['org_dispatched', 'org_confirmed', 'membership_dispatched', 'ready'], NEW.phase)
       < array_position(ARRAY['org_dispatched', 'org_confirmed', 'membership_dispatched', 'ready'], OLD.phase)
  THEN
    RAISE EXCEPTION 'Provisioning history cannot be rewritten';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provisioning_history_guard BEFORE UPDATE OR DELETE ON organization_provisioning
FOR EACH ROW EXECUTE FUNCTION guard_provisioning_history();
