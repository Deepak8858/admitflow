CREATE TABLE "whatsapp_subscription_operations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL, "service" text NOT NULL DEFAULT 'whatsapp', "external_id" text NOT NULL,
  "waba_id" text NOT NULL, "app_id" text NOT NULL, "generation" uuid NOT NULL, "dispatch_generation" uuid,
  "created_at" timestamptz(3) NOT NULL, "dispatched_at" timestamptz(3), "confirmed_at" timestamptz(3), "observed_at" timestamptz(3), "checked_at" timestamptz(3),
  CONSTRAINT "created_at_finite" CHECK (isfinite(created_at) AND created_at >= '0001-01-01T00:00:00Z'::timestamptz AND created_at < '10000-01-01T00:00:00Z'::timestamptz),
  CONSTRAINT "dispatched_at_finite" CHECK (isfinite(dispatched_at) AND dispatched_at >= '0001-01-01T00:00:00Z'::timestamptz AND dispatched_at < '10000-01-01T00:00:00Z'::timestamptz),
  CONSTRAINT "confirmed_at_finite" CHECK (isfinite(confirmed_at) AND confirmed_at >= '0001-01-01T00:00:00Z'::timestamptz AND confirmed_at < '10000-01-01T00:00:00Z'::timestamptz),
  CONSTRAINT "observed_at_finite" CHECK (isfinite(observed_at) AND observed_at >= '0001-01-01T00:00:00Z'::timestamptz AND observed_at < '10000-01-01T00:00:00Z'::timestamptz),
  CONSTRAINT "checked_at_finite" CHECK (isfinite(checked_at) AND checked_at >= '0001-01-01T00:00:00Z'::timestamptz AND checked_at < '10000-01-01T00:00:00Z'::timestamptz),
  "reconciliation" text NOT NULL DEFAULT 'reserved',
  CONSTRAINT "whatsapp_subscription_connection" FOREIGN KEY ("organization_id", "connection_id", "service", "external_id") REFERENCES "connections"("organization_id", "id", "service", "external_id"),
  CONSTRAINT "whatsapp_subscription_service" CHECK ("service" = 'whatsapp'),
  CONSTRAINT "whatsapp_subscription_identity" CHECK ("external_id" ~ '^[0-9]{1,80}$' AND "waba_id" ~ '^[0-9]{1,80}$' AND "app_id" ~ '^[0-9]{1,80}$'),
  CONSTRAINT "whatsapp_subscription_state" CHECK ("reconciliation" IN ('reserved', 'uncertain', 'confirmed', 'present', 'absent')),
  CONSTRAINT "whatsapp_subscription_confirmation" CHECK ("confirmed_at" IS NULL OR "dispatched_at" IS NOT NULL),
  CONSTRAINT "whatsapp_subscription_dispatch" CHECK (("dispatched_at" IS NULL) = ("dispatch_generation" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_subscription_tenant" ON "whatsapp_subscription_operations" ("organization_id");
CREATE UNIQUE INDEX "whatsapp_subscription_account_app" ON "whatsapp_subscription_operations" ("waba_id", "app_id");
--> statement-breakpoint
ALTER TABLE "whatsapp_subscription_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_subscription_operations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_subscription_tenant_policy" ON "whatsapp_subscription_operations" FOR ALL
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION public.protect_whatsapp_subscription_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'WhatsApp subscription history cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF ROW(NEW.id, NEW.organization_id, NEW.connection_id, NEW.service, NEW.external_id, NEW.waba_id, NEW.app_id, NEW.generation, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.connection_id, OLD.service, OLD.external_id, OLD.waba_id, OLD.app_id, OLD.generation, OLD.created_at)
    OR (OLD.dispatched_at IS NOT NULL AND ROW(NEW.dispatched_at, NEW.dispatch_generation) IS DISTINCT FROM ROW(OLD.dispatched_at, OLD.dispatch_generation))
    OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)
    OR (OLD.observed_at IS NOT NULL AND NEW.observed_at IS DISTINCT FROM OLD.observed_at) THEN
    RAISE EXCEPTION 'WhatsApp subscription identity and positive evidence are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "whatsapp_subscription_evidence" BEFORE UPDATE OR DELETE ON "whatsapp_subscription_operations"
  FOR EACH ROW EXECUTE FUNCTION public.protect_whatsapp_subscription_evidence();
--> statement-breakpoint
CREATE FUNCTION public.protect_whatsapp_account_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM whatsapp_subscription_operations o WHERE o.organization_id = OLD.organization_id AND o.connection_id = OLD.id
    AND (NEW.metadata->>'wabaId' IS DISTINCT FROM o.waba_id)) THEN
    RAISE EXCEPTION 'Original WhatsApp Business Account binding must be retained';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "whatsapp_account_binding" BEFORE UPDATE ON "connections"
  FOR EACH ROW EXECUTE FUNCTION public.protect_whatsapp_account_binding();
