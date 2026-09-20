-- Lead timestamps are stored as ISO text for legacy compatibility. Keep view
-- filters in SQL without throwing on a malformed legacy value. This helper
-- requires no extension and works on PostgreSQL versions before 16 as well.
CREATE FUNCTION public.admitflow_timestamp_ms(value text)
RETURNS double precision LANGUAGE plpgsql STABLE STRICT
SET search_path = pg_catalog
SET timezone = 'UTC'
AS $$
DECLARE parsed timestamptz;
BEGIN
  IF length(value) > 100 OR value !~ '[0-9]' THEN RETURN NULL; END IF;
  parsed := value::timestamptz;
  IF NOT isfinite(parsed) THEN RETURN NULL; END IF;
  RETURN extract(epoch FROM parsed) * 1000;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
  RETURN NULL;
END $$;
