-- Upgrade data under one lock. Runtime performs bounded erasure and keyed legacy-contact backfill.
DO $migration$
DECLARE previous_rls text := current_setting('row_security');
BEGIN
PERFORM set_config('row_security', 'off', true);
LOCK TABLE public.intake_inbox IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "intake_inbox" ALTER COLUMN "payload" DROP NOT NULL;
ALTER TABLE "intake_inbox" DROP CONSTRAINT intake_inbox_state_check;
ALTER TABLE "intake_inbox" ADD COLUMN "payload_digest" text;
ALTER TABLE "intake_inbox" ADD COLUMN "contact_key_version" text DEFAULT '' NOT NULL;
ALTER TABLE "intake_inbox" ADD COLUMN "expires_at" timestamptz(3);
ALTER TABLE "intake_inbox" ADD COLUMN "redacted_at" timestamptz(3);
UPDATE "intake_inbox" SET payload_digest = encode(sha256(convert_to(payload::text, 'UTF8')), 'hex'),
  expires_at = least(received_at + interval '720 hours', processed_at + interval '168 hours');
ALTER TABLE "intake_inbox" ALTER COLUMN "payload_digest" SET NOT NULL;
ALTER TABLE "intake_inbox" ALTER COLUMN "expires_at" SET NOT NULL;
PERFORM set_config('row_security', previous_rls, true);
END $migration$;
--> statement-breakpoint
CREATE INDEX "intake_expiry_page" ON "intake_inbox" USING btree ("organization_id","expires_at","id") WHERE "intake_inbox"."payload" is not null;--> statement-breakpoint
CREATE INDEX "intake_legacy_contacts" ON "intake_inbox" USING btree ("organization_id","expires_at","id") WHERE "intake_inbox"."contact_key_version" = '';--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "expires_at_finite" CHECK (isfinite("intake_inbox"."expires_at") and "intake_inbox"."expires_at" >= '0001-01-01T00:00:00Z'::timestamptz and "intake_inbox"."expires_at" < '10000-01-01T00:00:00Z'::timestamptz);--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "redacted_at_finite" CHECK (isfinite("intake_inbox"."redacted_at") and "intake_inbox"."redacted_at" >= '0001-01-01T00:00:00Z'::timestamptz and "intake_inbox"."redacted_at" < '10000-01-01T00:00:00Z'::timestamptz);--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "intake_retention_state" CHECK ("intake_inbox"."state" in ('pending', 'deferred', 'imported', 'expired') and ("intake_inbox"."state" <> 'expired' or "intake_inbox"."payload" is null));--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "intake_retention_dates" CHECK ("intake_inbox"."expires_at" <= "intake_inbox"."received_at" + interval '720 hours' and ("intake_inbox"."processed_at" is null or "intake_inbox"."expires_at" <= "intake_inbox"."processed_at" + interval '168 hours') and (("intake_inbox"."payload" is null) = ("intake_inbox"."redacted_at" is not null)));--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "intake_digest_valid" CHECK ("intake_inbox"."payload_digest" ~ '^[a-f0-9]{64}$' and ("intake_inbox"."payload" is null or "intake_inbox"."payload_digest" = encode(sha256(convert_to("intake_inbox"."payload"::text, 'UTF8')), 'hex')));--> statement-breakpoint
ALTER TABLE "intake_inbox" ADD CONSTRAINT "intake_contact_digest_valid" CHECK ("intake_inbox"."contact_key_version" = '' or ("intake_inbox"."contact_key_version" ~ '^[a-f0-9]{64}$' and ("intake_inbox"."contact_key" = '' or "intake_inbox"."contact_key" ~ '^[a-f0-9]{64}$')));
--> statement-breakpoint
CREATE FUNCTION public.protect_intake_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id) THEN
      RAISE EXCEPTION 'Intake deduplication and safety evidence cannot be deleted independently';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.organization_id, NEW.connection_id, NEW.service, NEW.external_id, NEW.received_at, NEW.payload_digest)
     IS DISTINCT FROM (OLD.id, OLD.organization_id, OLD.connection_id, OLD.service, OLD.external_id, OLD.received_at, OLD.payload_digest)
    OR (NEW.payload IS NOT NULL AND NEW.payload IS DISTINCT FROM OLD.payload)
    OR NEW.expires_at > OLD.expires_at
    OR (OLD.redacted_at IS NOT NULL AND NEW.redacted_at IS DISTINCT FROM OLD.redacted_at)
    OR (OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at)
    OR (OLD.state IN ('imported', 'expired') AND NEW.state <> OLD.state)
    OR (OLD.contact_key_version <> '' AND (NEW.contact_key, NEW.contact_key_version) IS DISTINCT FROM (OLD.contact_key, OLD.contact_key_version))
    OR (OLD.contact_key_version = '' AND NEW.contact_key_version = '' AND NEW.contact_key IS DISTINCT FROM OLD.contact_key)
    OR (OLD.payload IS NULL AND NEW.state = 'imported' AND OLD.state <> 'imported')
  THEN RAISE EXCEPTION 'Intake receipt identity, expiry and terminal evidence are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intake_retention_immutable BEFORE UPDATE OR DELETE ON public.intake_inbox FOR EACH ROW EXECUTE FUNCTION public.protect_intake_retention();
