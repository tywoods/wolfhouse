-- 091: reconcile location with tenant_locations (text location_id, composite FK).
-- Wolfhouse P1 may leave location_key NULL.

BEGIN;

ALTER TABLE public.external_calendar_connections
  DROP COLUMN IF EXISTS location_id;

ALTER TABLE public.external_calendar_connections
  ADD COLUMN IF NOT EXISTS location_key text NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'tenant_locations' AND c.relkind = 'r'
  ) THEN
    ALTER TABLE public.external_calendar_connections
      DROP CONSTRAINT IF EXISTS external_calendar_connections_location_fk;
    ALTER TABLE public.external_calendar_connections
      ADD CONSTRAINT external_calendar_connections_location_fk
      FOREIGN KEY (client_id, location_key)
      REFERENCES public.tenant_locations (client_id, location_id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END $$;

COMMIT;
