CREATE TABLE institute_trials (
  workos_id text PRIMARY KEY,
  started_at text,
  ends_at text,
  consumed boolean NOT NULL DEFAULT false,
  provenance text NOT NULL,
  CONSTRAINT trial_dates CHECK (
    (started_at IS NULL AND ends_at IS NULL AND consumed)
    OR (started_at IS NOT NULL AND ends_at IS NOT NULL AND
      ends_at::timestamptz - started_at::timestamptz = interval '168 hours')
  )
);
--> statement-breakpoint
-- Routing contains only server-owned identities. Set tenant context even for migration roles without BYPASSRLS.
DO $$
DECLARE route record; org record; eligible boolean;
  rollout timestamptz := transaction_timestamp();
BEGIN
  FOR route IN SELECT organization_id, workos_id FROM organization_routes WHERE workos_id IS NOT NULL LOOP
    PERFORM set_config('app.organization_id', route.organization_id::text, true);
    SELECT * INTO org FROM organizations WHERE id = route.organization_id;
    IF FOUND AND NOT org.demo AND org.workos_id = route.workos_id THEN
      eligible := org.subscription->>'status' = 'trial'
        AND coalesce(org.subscription->>'providerId', '') = ''
        AND NOT EXISTS (SELECT 1 FROM connection_routes WHERE organization_id = org.id AND service = 'billing')
        AND NOT EXISTS (SELECT 1 FROM event_receipts WHERE organization_id = org.id AND provider LIKE 'billing%');
      INSERT INTO institute_trials(workos_id, started_at, ends_at, consumed, provenance)
      VALUES(route.workos_id,
        CASE WHEN eligible THEN to_char(rollout AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        CASE WHEN eligible THEN to_char((rollout + interval '168 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
        NOT coalesce(eligible, false), 'legacy-rollout') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  PERFORM set_config('app.organization_id', '', true);
END $$;
--> statement-breakpoint
CREATE FUNCTION preserve_institute_trial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Institute trial history must be retained'; END IF;
  IF NEW.workos_id IS DISTINCT FROM OLD.workos_id OR NEW.started_at IS DISTINCT FROM OLD.started_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at OR NEW.provenance IS DISTINCT FROM OLD.provenance
    OR (OLD.consumed AND NOT NEW.consumed) THEN
    RAISE EXCEPTION 'Institute trial grants cannot be reset';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER preserve_institute_trial BEFORE UPDATE OR DELETE ON institute_trials
FOR EACH ROW EXECUTE FUNCTION preserve_institute_trial();
