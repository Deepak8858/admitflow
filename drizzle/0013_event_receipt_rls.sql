CREATE INDEX "event_receipts_tenant_due" ON "event_receipts" USING btree ("organization_id",("payload"->>'nextAttemptAt'),"id") WHERE "event_receipts"."provider" = 'razorpay_admission' and "event_receipts"."processed_at" is null;
--> statement-breakpoint
-- Preserve legacy null-organization receipts, but never expose them to runtime tenants.
ALTER TABLE "event_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "event_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "event_receipts_tenant_policy" ON "event_receipts" FOR ALL
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
-- Ordinary provider updates do not need WhatsApp operation-table access.
-- Inspect OLD.service so changing an existing WhatsApp binding cannot skip its guard.
CREATE OR REPLACE FUNCTION public.protect_whatsapp_account_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.service <> 'whatsapp' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_subscription_operations o WHERE o.organization_id = OLD.organization_id AND o.connection_id = OLD.id
    AND (NEW.metadata->>'wabaId' IS DISTINCT FROM o.waba_id)) THEN
    RAISE EXCEPTION 'Original WhatsApp Business Account binding must be retained';
  END IF;
  RETURN NEW;
END;
$$;
