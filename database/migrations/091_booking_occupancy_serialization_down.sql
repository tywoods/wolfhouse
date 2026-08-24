-- Down for 091: drop only 091-owned occupancy objects.
-- Refuses foreign/newer replacements. Repeatable when objects/tables are absent.

BEGIN;

DO $$
DECLARE
  owned text;
  oid oid;
BEGIN
  -- assignment trigger
  IF to_regclass('public.booking_beds') IS NOT NULL THEN
    SELECT obj_description(t.oid, 'pg_trigger') INTO owned
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'booking_beds'
       AND t.tgname = 'booking_beds_reject_overlap_trg';
    IF FOUND THEN
      IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
        RAISE EXCEPTION '091_down_refused: trigger booking_beds_reject_overlap_trg is not 091-owned (comment=%)', owned;
      END IF;
      EXECUTE 'DROP TRIGGER IF EXISTS booking_beds_reject_overlap_trg ON public.booking_beds';
    END IF;
  END IF;

  -- status trigger
  IF to_regclass('public.bookings') IS NOT NULL THEN
    SELECT obj_description(t.oid, 'pg_trigger') INTO owned
      FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'bookings'
       AND t.tgname = 'bookings_occupancy_status_trg';
    IF FOUND THEN
      IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
        RAISE EXCEPTION '091_down_refused: trigger bookings_occupancy_status_trg is not 091-owned (comment=%)', owned;
      END IF;
      EXECUTE 'DROP TRIGGER IF EXISTS bookings_occupancy_status_trg ON public.bookings';
    END IF;
  END IF;

  oid := to_regprocedure('public.bookings_occupancy_status_guard()');
  IF oid IS NOT NULL THEN
    SELECT obj_description(oid, 'pg_proc') INTO owned;
    IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
      RAISE EXCEPTION '091_down_refused: function bookings_occupancy_status_guard is not 091-owned (comment=%)', owned;
    END IF;
    EXECUTE 'DROP FUNCTION public.bookings_occupancy_status_guard()';
  END IF;

  oid := to_regprocedure('public.booking_beds_reject_overlap()');
  IF oid IS NOT NULL THEN
    SELECT obj_description(oid, 'pg_proc') INTO owned;
    IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
      RAISE EXCEPTION '091_down_refused: function booking_beds_reject_overlap is not 091-owned (comment=%)', owned;
    END IF;
    EXECUTE 'DROP FUNCTION public.booking_beds_reject_overlap()';
  END IF;

  oid := to_regprocedure('public.booking_occupancy_lock_key(text,uuid)');
  IF oid IS NOT NULL THEN
    SELECT obj_description(oid, 'pg_proc') INTO owned;
    IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
      RAISE EXCEPTION '091_down_refused: function booking_occupancy_lock_key is not 091-owned (comment=%)', owned;
    END IF;
    EXECUTE 'DROP FUNCTION public.booking_occupancy_lock_key(text, uuid)';
  END IF;
END $$;

COMMIT;
