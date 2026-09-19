-- Custom SQL migration file, put your code below! --
-- Every application query runs inside a transaction with this tenant context.
-- Use a non-superuser runtime role without BYPASSRLS. Routing tables contain only IDs.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['leads','messages','campaigns','campaign_recipients','jobs','appointments','payments','refunds','articles','activities','tasks','members','files','connections','saved_views'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)', table_name);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY organization_isolation ON organizations USING (id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (id = nullif(current_setting('app.organization_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payment_positive CHECK (amount_paise > 0);
ALTER TABLE refunds ADD CONSTRAINT refund_positive CHECK (amount_paise > 0);
ALTER TABLE appointments ADD CONSTRAINT duration_valid CHECK (duration BETWEEN 15 AND 120);
ALTER TABLE leads ADD CONSTRAINT consent_valid CHECK (consent IN ('unknown', 'opted_in', 'opted_out'));
CREATE UNIQUE INDEX payments_receipt_case_insensitive ON payments (organization_id, lower(reference));
