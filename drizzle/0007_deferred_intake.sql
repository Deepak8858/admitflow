CREATE TABLE intake_inbox (
  id text PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL,
  service text NOT NULL CHECK (service IN ('whatsapp', 'meta_leads')),
  external_id text NOT NULL,
  contact_key text NOT NULL,
  received_at text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'deferred', 'imported')),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 131072),
  processed_at text,
  error text
);
--> statement-breakpoint
CREATE INDEX intake_pending_page ON intake_inbox(organization_id, state, id);
CREATE INDEX intake_pending_contact ON intake_inbox(organization_id, contact_key) WHERE state <> 'imported';
--> statement-breakpoint
ALTER TABLE intake_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_inbox FORCE ROW LEVEL SECURITY;
CREATE POLICY intake_tenant ON intake_inbox USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);
