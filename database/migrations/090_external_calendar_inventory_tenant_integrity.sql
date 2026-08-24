-- 090_external_calendar_inventory_tenant_integrity.sql
-- Enforce connection → map → bed → event → booking stay on one client_id.
-- Stock PostgreSQL triggers (no extensions).

BEGIN;

CREATE OR REPLACE FUNCTION public.external_calendar_assert_same_client()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public
AS $$
DECLARE
  conn_client uuid;
  bed_client uuid;
  booking_client uuid;
BEGIN
  IF TG_TABLE_NAME = 'external_calendar_unit_maps' THEN
    SELECT c.client_id INTO conn_client
      FROM public.external_calendar_connections c
     WHERE c.id = NEW.connection_id;
    IF conn_client IS NULL OR conn_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'extcal_tenant_mismatch: map client_id != connection.client_id' USING ERRCODE = '23514';
    END IF;
    SELECT b.client_id INTO bed_client
      FROM public.beds b
     WHERE b.id = NEW.bed_id;
    IF bed_client IS NULL OR bed_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'extcal_tenant_mismatch: bed client_id != map.client_id' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'external_inventory_events' THEN
    SELECT c.client_id INTO conn_client
      FROM public.external_calendar_connections c
     WHERE c.id = NEW.connection_id;
    IF conn_client IS NULL OR conn_client IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'extcal_tenant_mismatch: event client_id != connection.client_id' USING ERRCODE = '23514';
    END IF;
    IF NEW.booking_id IS NOT NULL THEN
      SELECT bk.client_id INTO booking_client
        FROM public.bookings bk
       WHERE bk.id = NEW.booking_id;
      IF booking_client IS NULL OR booking_client IS DISTINCT FROM NEW.client_id THEN
        RAISE EXCEPTION 'extcal_tenant_mismatch: booking client_id != event.client_id' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.map_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.external_calendar_unit_maps m
         WHERE m.id = NEW.map_id
           AND m.client_id = NEW.client_id
           AND m.connection_id = NEW.connection_id
      ) THEN
        RAISE EXCEPTION 'extcal_tenant_mismatch: map not on same connection/client' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS external_calendar_unit_maps_tenant_trg
  ON public.external_calendar_unit_maps;
CREATE TRIGGER external_calendar_unit_maps_tenant_trg
  BEFORE INSERT OR UPDATE ON public.external_calendar_unit_maps
  FOR EACH ROW EXECUTE PROCEDURE public.external_calendar_assert_same_client();

DROP TRIGGER IF EXISTS external_inventory_events_tenant_trg
  ON public.external_inventory_events;
CREATE TRIGGER external_inventory_events_tenant_trg
  BEFORE INSERT OR UPDATE ON public.external_inventory_events
  FOR EACH ROW EXECUTE PROCEDURE public.external_calendar_assert_same_client();

COMMIT;
