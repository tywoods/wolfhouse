-- 091_booking_occupancy_serialization.sql
-- Shared occupancy invariant for every booking_beds writer.
-- Owned by this migration (comment version). Down removes exactly these objects.

BEGIN;

DO $$
DECLARE
  owned text;
BEGIN
  IF to_regprocedure('public.booking_occupancy_lock_key(text,uuid)') IS NOT NULL THEN
    SELECT obj_description('public.booking_occupancy_lock_key(text,uuid)'::regprocedure) INTO owned;
    IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1' THEN
      RAISE EXCEPTION '091_refused: occupancy lock function exists without 091 ownership';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.booking_occupancy_lock_key(
  p_kind text,
  p_id uuid
) RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ('x' || substr(md5(p_kind || ':' || p_id::text), 1, 16))::bit(64)::bigint;
$$;
COMMENT ON FUNCTION public.booking_occupancy_lock_key(text, uuid)
  IS '091_booking_occupancy_serialization v1';

CREATE OR REPLACE FUNCTION public.booking_beds_reject_overlap()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conflict_row uuid;
  booking_status text;
  rec record;
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := gen_random_uuid();
  END IF;
  IF NEW.bed_id IS NULL OR NEW.client_id IS NULL
     OR NEW.booking_id IS NULL
     OR NEW.assignment_start_date IS NULL OR NEW.assignment_end_date IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.assignment_end_date <= NEW.assignment_start_date THEN
    RAISE EXCEPTION 'booking_beds_invalid_range';
  END IF;

  -- 1. Booking locks, sorted.
  IF TG_OP = 'UPDATE' AND OLD.booking_id IS DISTINCT FROM NEW.booking_id THEN
    FOR rec IN
      SELECT x.id
        FROM (VALUES (OLD.booking_id), (NEW.booking_id)) AS x(id)
       WHERE x.id IS NOT NULL
       ORDER BY x.id
    LOOP
      PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('booking', rec.id));
    END LOOP;
  ELSE
    PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('booking', NEW.booking_id));
  END IF;

  -- 2. Bed locks, sorted (old+new on reassignment).
  IF TG_OP = 'UPDATE'
     AND (OLD.bed_id IS DISTINCT FROM NEW.bed_id OR OLD.client_id IS DISTINCT FROM NEW.client_id) THEN
    FOR rec IN
      SELECT *
        FROM (
          SELECT OLD.client_id AS client_id, OLD.bed_id AS bed_id
          UNION
          SELECT NEW.client_id, NEW.bed_id
        ) beds
       ORDER BY client_id, bed_id
    LOOP
      PERFORM pg_advisory_xact_lock(
        public.booking_occupancy_lock_key('bed', rec.bed_id)
      );
    END LOOP;
  ELSE
    PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', NEW.bed_id));
  END IF;

  -- 3. Recheck status after locks.
  SELECT b.status::text INTO booking_status
    FROM public.bookings b
   WHERE b.id = NEW.booking_id;
  IF booking_status IN ('cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  -- 4. Overlap: exclude this assignment row only.
  SELECT bb.id INTO conflict_row
    FROM public.booking_beds bb
    JOIN public.bookings bk ON bk.id = bb.booking_id
   WHERE bb.client_id = NEW.client_id
     AND bb.bed_id = NEW.bed_id
     AND bb.id IS DISTINCT FROM NEW.id
     AND bb.assignment_start_date < NEW.assignment_end_date
     AND bb.assignment_end_date > NEW.assignment_start_date
     AND bk.status::text NOT IN ('cancelled', 'expired')
   LIMIT 1;

  IF conflict_row IS NOT NULL THEN
    RAISE EXCEPTION 'booking_beds_overlap_conflict';
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.booking_beds_reject_overlap()
  IS '091_booking_occupancy_serialization v1';

DROP TRIGGER IF EXISTS booking_beds_reject_overlap_trg ON public.booking_beds;
CREATE TRIGGER booking_beds_reject_overlap_trg
  BEFORE INSERT OR UPDATE OF booking_id, client_id, bed_id, assignment_start_date, assignment_end_date
  ON public.booking_beds
  FOR EACH ROW
  EXECUTE PROCEDURE public.booking_beds_reject_overlap();
COMMENT ON TRIGGER booking_beds_reject_overlap_trg ON public.booking_beds
  IS '091_booking_occupancy_serialization v1';

CREATE OR REPLACE FUNCTION public.bookings_occupancy_status_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec record;
  conflict_row uuid;
BEGIN
  -- Always serialize on the booking before any status change.
  PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('booking', NEW.id));

  IF OLD.status::text IN ('cancelled', 'expired')
     AND NEW.status::text NOT IN ('cancelled', 'expired') THEN
    FOR rec IN
      SELECT bb.id, bb.client_id, bb.bed_id, bb.assignment_start_date, bb.assignment_end_date
        FROM public.booking_beds bb
       WHERE bb.booking_id = NEW.id
       ORDER BY bb.client_id, bb.bed_id, bb.id
    LOOP
      PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', rec.bed_id));
      SELECT bb.id INTO conflict_row
        FROM public.booking_beds bb
        JOIN public.bookings bk ON bk.id = bb.booking_id
       WHERE bb.client_id = rec.client_id
         AND bb.bed_id = rec.bed_id
         AND bb.id IS DISTINCT FROM rec.id
         AND bb.assignment_start_date < rec.assignment_end_date
         AND bb.assignment_end_date > rec.assignment_start_date
         AND bk.status::text NOT IN ('cancelled', 'expired')
       LIMIT 1;
      IF conflict_row IS NOT NULL THEN
        RAISE EXCEPTION 'booking_beds_overlap_conflict';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.bookings_occupancy_status_guard()
  IS '091_booking_occupancy_serialization v1';

DROP TRIGGER IF EXISTS bookings_occupancy_status_trg ON public.bookings;
CREATE TRIGGER bookings_occupancy_status_trg
  BEFORE UPDATE OF status
  ON public.bookings
  FOR EACH ROW
  EXECUTE PROCEDURE public.bookings_occupancy_status_guard();
COMMENT ON TRIGGER bookings_occupancy_status_trg ON public.bookings
  IS '091_booking_occupancy_serialization v1';

COMMIT;
