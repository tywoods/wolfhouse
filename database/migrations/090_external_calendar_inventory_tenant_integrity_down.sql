-- Down for 090: drop tenant-integrity triggers/function. Safe if objects missing.

BEGIN;

DROP TRIGGER IF EXISTS external_calendar_unit_maps_tenant_trg
  ON public.external_calendar_unit_maps;
DROP TRIGGER IF EXISTS external_inventory_events_tenant_trg
  ON public.external_inventory_events;
DROP FUNCTION IF EXISTS public.external_calendar_assert_same_client();

COMMIT;
