-- Explicit down for 089_external_calendar_inventory.
-- Refuse if any imported events still point at a booking (would orphan XBLK
-- identity). Empty: drop the four tables. Second empty execution is safe.
-- Occupancy serialization is owned by 091 and is not touched here.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'external_inventory_events'
       AND c.relkind = 'r'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.external_inventory_events
       WHERE booking_id IS NOT NULL AND status = 'imported'
    ) THEN
      RAISE EXCEPTION '089_down_refused: imported owner-schedule events still linked — refuse silent occupancy loss';
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS public.external_inventory_events;
DROP TABLE IF EXISTS public.external_calendar_unit_maps;
DROP TABLE IF EXISTS public.external_calendar_secrets;
DROP TABLE IF EXISTS public.external_calendar_connections;

COMMIT;
