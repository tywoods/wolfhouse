-- Down for 090: drop tenant-integrity triggers/function.
-- Safe when bridge tables or the function are absent.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'external_calendar_unit_maps' AND c.relkind = 'r'
  ) THEN
    DROP TRIGGER IF EXISTS external_calendar_unit_maps_tenant_trg
      ON public.external_calendar_unit_maps;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'external_inventory_events' AND c.relkind = 'r'
  ) THEN
    DROP TRIGGER IF EXISTS external_inventory_events_tenant_trg
      ON public.external_inventory_events;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.external_calendar_assert_same_client();

COMMIT;
