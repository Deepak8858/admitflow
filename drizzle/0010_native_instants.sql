-- One atomic block: lock the explicit 31-column allowlist before preflight.
-- row_security=off fails rather than silently overlooking rows for a restricted role.
-- Never rewrite rows through UPDATE: immutable trial/provisioning triggers remain installed.
DO $migration$
DECLARE target record; invalid_count bigint; failures text[] := ARRAY[]::text[];
  previous_rls text := current_setting('row_security');
BEGIN
  PERFORM set_config('row_security', 'off', true);
  LOCK TABLE public.activities, public.appointments, public.articles, public.campaigns, public.connections, public.event_receipts, public.files, public.institute_trials, public.intake_inbox, public.jobs, public.leads, public.messages, public.organization_provisioning, public.payments, public.refunds, public.tasks IN ACCESS EXCLUSIVE MODE;

  CREATE FUNCTION pg_temp.admitflow_valid_instant(value text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE STRICT AS $validator$
  DECLARE parts text[]; parsed timestamptz;
  BEGIN
    parts := regexp_match(value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.([0-9]+))?(Z|([+-])([0-9]{2}):([0-9]{2}))$');
    IF parts IS NULL OR parts[1]::integer < 1 OR parts[4]::integer > 23
      OR parts[5]::integer > 59 OR parts[6]::integer > 59
      OR coalesce(substring(parts[8] from 4), '') ~ '[1-9]'
      OR coalesce(parts[11]::integer, 0) > 15 OR coalesce(parts[12]::integer, 0) > 59
    THEN RETURN false; END IF;
    parsed := value::timestamptz;
    RETURN isfinite(parsed) AND parsed >= '0001-01-01T00:00:00Z'::timestamptz
      AND parsed < '10000-01-01T00:00:00Z'::timestamptz;
  EXCEPTION WHEN OTHERS THEN RETURN false;
  END $validator$;

  FOR target IN SELECT * FROM (VALUES
    ('activities', 'created_at'),
    ('appointments', 'starts_at'),
    ('articles', 'updated_at'),
    ('campaigns', 'created_at'),
    ('connections', 'updated_at'),
    ('event_receipts', 'received_at'),
    ('event_receipts', 'processed_at'),
    ('files', 'created_at'),
    ('files', 'finalized_at'),
    ('institute_trials', 'started_at'),
    ('institute_trials', 'ends_at'),
    ('intake_inbox', 'received_at'),
    ('intake_inbox', 'processed_at'),
    ('jobs', 'due_at'),
    ('jobs', 'locked_at'),
    ('jobs', 'dispatched_at'),
    ('leads', 'next_action_at'),
    ('leads', 'created_at'),
    ('leads', 'last_contact_at'),
    ('leads', 'last_inbound_at'),
    ('leads', 'consent_at'),
    ('messages', 'created_at'),
    ('messages', 'received_at'),
    ('messages', 'status_at'),
    ('messages', 'dispatched_at'),
    ('organization_provisioning', 'created_at'),
    ('organization_provisioning', 'updated_at'),
    ('organization_provisioning', 'acknowledged_at'),
    ('payments', 'recorded_at'),
    ('refunds', 'recorded_at'),
    ('tasks', 'due_at')
  ) AS allowed(table_name, column_name) LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I IS NOT NULL AND NOT pg_temp.admitflow_valid_instant(%I)', target.table_name, target.column_name, target.column_name) INTO invalid_count;
    IF invalid_count > 0 THEN failures := array_append(failures, format('%s.%s=%s', target.table_name, target.column_name, invalid_count)); END IF;
  END LOOP;
  IF cardinality(failures) > 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'Invalid legacy instant counts: ' || array_to_string(failures, ', '), ERRCODE = '22007';
  END IF;

  -- Remove/recreate the cross-column typed expression only while holding the lock.
  ALTER TABLE public.institute_trials DROP CONSTRAINT trial_dates;
  ALTER TABLE public.activities
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz;
  ALTER TABLE public.appointments
    ALTER COLUMN "starts_at" TYPE timestamptz(3) USING "starts_at"::timestamptz;
  ALTER TABLE public.articles
    ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at"::timestamptz;
  ALTER TABLE public.campaigns
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz;
  ALTER TABLE public.connections
    ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at"::timestamptz;
  ALTER TABLE public.event_receipts
    ALTER COLUMN "received_at" TYPE timestamptz(3) USING "received_at"::timestamptz,
    ALTER COLUMN "processed_at" TYPE timestamptz(3) USING "processed_at"::timestamptz;
  ALTER TABLE public.files
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz,
    ALTER COLUMN "finalized_at" TYPE timestamptz(3) USING "finalized_at"::timestamptz;
  ALTER TABLE public.institute_trials
    ALTER COLUMN "started_at" TYPE timestamptz(3) USING "started_at"::timestamptz,
    ALTER COLUMN "ends_at" TYPE timestamptz(3) USING "ends_at"::timestamptz;
  ALTER TABLE public.intake_inbox
    ALTER COLUMN "received_at" TYPE timestamptz(3) USING "received_at"::timestamptz,
    ALTER COLUMN "processed_at" TYPE timestamptz(3) USING "processed_at"::timestamptz;
  ALTER TABLE public.jobs
    ALTER COLUMN "due_at" TYPE timestamptz(3) USING "due_at"::timestamptz,
    ALTER COLUMN "locked_at" TYPE timestamptz(3) USING "locked_at"::timestamptz,
    ALTER COLUMN "dispatched_at" TYPE timestamptz(3) USING "dispatched_at"::timestamptz;
  ALTER TABLE public.leads
    ALTER COLUMN "next_action_at" TYPE timestamptz(3) USING "next_action_at"::timestamptz,
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz,
    ALTER COLUMN "last_contact_at" TYPE timestamptz(3) USING "last_contact_at"::timestamptz,
    ALTER COLUMN "last_inbound_at" TYPE timestamptz(3) USING "last_inbound_at"::timestamptz,
    ALTER COLUMN "consent_at" TYPE timestamptz(3) USING "consent_at"::timestamptz;
  ALTER TABLE public.messages
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz,
    ALTER COLUMN "received_at" TYPE timestamptz(3) USING "received_at"::timestamptz,
    ALTER COLUMN "status_at" TYPE timestamptz(3) USING "status_at"::timestamptz,
    ALTER COLUMN "dispatched_at" TYPE timestamptz(3) USING "dispatched_at"::timestamptz;
  ALTER TABLE public.organization_provisioning
    ALTER COLUMN "created_at" TYPE timestamptz(3) USING "created_at"::timestamptz,
    ALTER COLUMN "updated_at" TYPE timestamptz(3) USING "updated_at"::timestamptz,
    ALTER COLUMN "acknowledged_at" TYPE timestamptz(3) USING "acknowledged_at"::timestamptz;
  ALTER TABLE public.payments
    ALTER COLUMN "recorded_at" TYPE timestamptz(3) USING "recorded_at"::timestamptz;
  ALTER TABLE public.refunds
    ALTER COLUMN "recorded_at" TYPE timestamptz(3) USING "recorded_at"::timestamptz;
  ALTER TABLE public.tasks
    ALTER COLUMN "due_at" TYPE timestamptz(3) USING "due_at"::timestamptz;
  ALTER TABLE public.institute_trials ADD CONSTRAINT trial_dates CHECK (
    (started_at IS NULL AND ends_at IS NULL AND consumed)
    OR (started_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at - started_at = interval '168 hours')
  );
ALTER TABLE "activities" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("activities"."created_at") and "activities"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "activities"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "appointments" ADD CONSTRAINT "starts_at_finite" CHECK (isfinite("appointments"."starts_at") and "appointments"."starts_at" >= '0001-01-01T00:00:00Z'::timestamptz and "appointments"."starts_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "articles" ADD CONSTRAINT "updated_at_finite" CHECK (isfinite("articles"."updated_at") and "articles"."updated_at" >= '0001-01-01T00:00:00Z'::timestamptz and "articles"."updated_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "campaigns" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("campaigns"."created_at") and "campaigns"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "campaigns"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "connections" ADD CONSTRAINT "updated_at_finite" CHECK (isfinite("connections"."updated_at") and "connections"."updated_at" >= '0001-01-01T00:00:00Z'::timestamptz and "connections"."updated_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "event_receipts" ADD CONSTRAINT "received_at_finite" CHECK (isfinite("event_receipts"."received_at") and "event_receipts"."received_at" >= '0001-01-01T00:00:00Z'::timestamptz and "event_receipts"."received_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "event_receipts" ADD CONSTRAINT "processed_at_finite" CHECK (isfinite("event_receipts"."processed_at") and "event_receipts"."processed_at" >= '0001-01-01T00:00:00Z'::timestamptz and "event_receipts"."processed_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "files" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("files"."created_at") and "files"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "files"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "files" ADD CONSTRAINT "finalized_at_finite" CHECK (isfinite("files"."finalized_at") and "files"."finalized_at" >= '0001-01-01T00:00:00Z'::timestamptz and "files"."finalized_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "institute_trials" ADD CONSTRAINT "started_at_finite" CHECK (isfinite("institute_trials"."started_at") and "institute_trials"."started_at" >= '0001-01-01T00:00:00Z'::timestamptz and "institute_trials"."started_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "institute_trials" ADD CONSTRAINT "ends_at_finite" CHECK (isfinite("institute_trials"."ends_at") and "institute_trials"."ends_at" >= '0001-01-01T00:00:00Z'::timestamptz and "institute_trials"."ends_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "intake_inbox" ADD CONSTRAINT "received_at_finite" CHECK (isfinite("intake_inbox"."received_at") and "intake_inbox"."received_at" >= '0001-01-01T00:00:00Z'::timestamptz and "intake_inbox"."received_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "intake_inbox" ADD CONSTRAINT "processed_at_finite" CHECK (isfinite("intake_inbox"."processed_at") and "intake_inbox"."processed_at" >= '0001-01-01T00:00:00Z'::timestamptz and "intake_inbox"."processed_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "jobs" ADD CONSTRAINT "due_at_finite" CHECK (isfinite("jobs"."due_at") and "jobs"."due_at" >= '0001-01-01T00:00:00Z'::timestamptz and "jobs"."due_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "jobs" ADD CONSTRAINT "locked_at_finite" CHECK (isfinite("jobs"."locked_at") and "jobs"."locked_at" >= '0001-01-01T00:00:00Z'::timestamptz and "jobs"."locked_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "jobs" ADD CONSTRAINT "dispatched_at_finite" CHECK (isfinite("jobs"."dispatched_at") and "jobs"."dispatched_at" >= '0001-01-01T00:00:00Z'::timestamptz and "jobs"."dispatched_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "leads" ADD CONSTRAINT "next_action_at_finite" CHECK (isfinite("leads"."next_action_at") and "leads"."next_action_at" >= '0001-01-01T00:00:00Z'::timestamptz and "leads"."next_action_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "leads" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("leads"."created_at") and "leads"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "leads"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "leads" ADD CONSTRAINT "last_contact_at_finite" CHECK (isfinite("leads"."last_contact_at") and "leads"."last_contact_at" >= '0001-01-01T00:00:00Z'::timestamptz and "leads"."last_contact_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "leads" ADD CONSTRAINT "last_inbound_at_finite" CHECK (isfinite("leads"."last_inbound_at") and "leads"."last_inbound_at" >= '0001-01-01T00:00:00Z'::timestamptz and "leads"."last_inbound_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "leads" ADD CONSTRAINT "consent_at_finite" CHECK (isfinite("leads"."consent_at") and "leads"."consent_at" >= '0001-01-01T00:00:00Z'::timestamptz and "leads"."consent_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "messages" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("messages"."created_at") and "messages"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "messages"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "messages" ADD CONSTRAINT "received_at_finite" CHECK (isfinite("messages"."received_at") and "messages"."received_at" >= '0001-01-01T00:00:00Z'::timestamptz and "messages"."received_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "messages" ADD CONSTRAINT "status_at_finite" CHECK (isfinite("messages"."status_at") and "messages"."status_at" >= '0001-01-01T00:00:00Z'::timestamptz and "messages"."status_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "messages" ADD CONSTRAINT "dispatched_at_finite" CHECK (isfinite("messages"."dispatched_at") and "messages"."dispatched_at" >= '0001-01-01T00:00:00Z'::timestamptz and "messages"."dispatched_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "organization_provisioning" ADD CONSTRAINT "created_at_finite" CHECK (isfinite("organization_provisioning"."created_at") and "organization_provisioning"."created_at" >= '0001-01-01T00:00:00Z'::timestamptz and "organization_provisioning"."created_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "organization_provisioning" ADD CONSTRAINT "updated_at_finite" CHECK (isfinite("organization_provisioning"."updated_at") and "organization_provisioning"."updated_at" >= '0001-01-01T00:00:00Z'::timestamptz and "organization_provisioning"."updated_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "organization_provisioning" ADD CONSTRAINT "acknowledged_at_finite" CHECK (isfinite("organization_provisioning"."acknowledged_at") and "organization_provisioning"."acknowledged_at" >= '0001-01-01T00:00:00Z'::timestamptz and "organization_provisioning"."acknowledged_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "payments" ADD CONSTRAINT "recorded_at_finite" CHECK (isfinite("payments"."recorded_at") and "payments"."recorded_at" >= '0001-01-01T00:00:00Z'::timestamptz and "payments"."recorded_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "refunds" ADD CONSTRAINT "recorded_at_finite" CHECK (isfinite("refunds"."recorded_at") and "refunds"."recorded_at" >= '0001-01-01T00:00:00Z'::timestamptz and "refunds"."recorded_at" < '10000-01-01T00:00:00Z'::timestamptz);
ALTER TABLE "tasks" ADD CONSTRAINT "due_at_finite" CHECK (isfinite("tasks"."due_at") and "tasks"."due_at" >= '0001-01-01T00:00:00Z'::timestamptz and "tasks"."due_at" < '10000-01-01T00:00:00Z'::timestamptz);
  DROP FUNCTION pg_temp.admitflow_valid_instant(text);
  PERFORM set_config('row_security', previous_rls, true);
END $migration$;
