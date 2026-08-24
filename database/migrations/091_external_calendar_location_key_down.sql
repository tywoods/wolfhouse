BEGIN;

ALTER TABLE public.external_calendar_connections
  DROP CONSTRAINT IF EXISTS external_calendar_connections_location_fk;
ALTER TABLE public.external_calendar_connections
  DROP COLUMN IF EXISTS location_key;

COMMIT;
