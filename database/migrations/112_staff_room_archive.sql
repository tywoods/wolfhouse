-- 112_staff_room_archive.sql
-- Wolfhouse room archive. active=false is not an archive marker.
-- Admission guards lock booking, then bed — the same order as 091.
-- They must not lock a room row before those bed locks.
BEGIN;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS archive_operation_id TEXT;

COMMENT ON COLUMN rooms.archived_at IS
  '112 explicit archive marker. active=false alone is not an archive.';
COMMENT ON COLUMN rooms.archive_operation_id IS
  '112 current archive operation. Restore binds to this id.';

CREATE TABLE IF NOT EXISTS staff_room_fill_inventory_operations (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('archive', 'restore')),
  room_id UUID NOT NULL,
  request_hash TEXT NOT NULL,
  actor_staff_user_id TEXT,
  acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  PRIMARY KEY (client_id, operation_id)
);

COMMENT ON TABLE staff_room_fill_inventory_operations IS
  '112 tenant-scoped archive/restore journal. Replay returns the receipt and does not repeat the mutation.';

-- Import/upsert cannot clear an archive. Only an explicit restore sets this flag.
CREATE OR REPLACE FUNCTION public.rooms_preserve_archive_marker()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL
     AND current_setting('wolfhouse.room_restore', true) IS DISTINCT FROM 'on' THEN
    IF NEW.room_code IS DISTINCT FROM OLD.room_code
       OR NEW.name IS DISTINCT FROM OLD.name
       OR NEW.client_id IS DISTINCT FROM OLD.client_id
       OR NEW.house IS DISTINCT FROM OLD.house
       OR NEW.room_type IS DISTINCT FROM OLD.room_type
       OR NEW.capacity IS DISTINCT FROM OLD.capacity THEN
      RAISE EXCEPTION 'archived_room_identity';
    END IF;
    NEW.archived_at := OLD.archived_at;
    NEW.archive_operation_id := OLD.archive_operation_id;
    NEW.active := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rooms_preserve_archive_marker_trg ON rooms;
CREATE TRIGGER rooms_preserve_archive_marker_trg
  BEFORE UPDATE ON rooms
  FOR EACH ROW
  EXECUTE PROCEDURE public.rooms_preserve_archive_marker();

CREATE OR REPLACE FUNCTION public.beds_preserve_archived_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  archived timestamptz;
  old_archived timestamptz;
BEGIN
  IF current_setting('wolfhouse.room_restore', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.room_id IS NOT NULL THEN
    SELECT r.archived_at INTO old_archived
      FROM rooms r
     WHERE r.id = OLD.room_id;
    IF old_archived IS NOT NULL
       AND (NEW.room_id IS DISTINCT FROM OLD.room_id
            OR NEW.bed_code IS DISTINCT FROM OLD.bed_code
            OR NEW.client_id IS DISTINCT FROM OLD.client_id) THEN
      RAISE EXCEPTION 'archived_room_membership';
    END IF;
  END IF;
  SELECT r.archived_at INTO archived
    FROM rooms r
   WHERE r.id = NEW.room_id;
  IF archived IS NOT NULL THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'archived_room_membership';
    END IF;
    IF NEW.room_id IS DISTINCT FROM OLD.room_id THEN
      RAISE EXCEPTION 'archived_room_membership';
    END IF;
    NEW.active := FALSE;
    NEW.sellable := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS beds_preserve_archived_room_trg ON beds;
CREATE TRIGGER beds_preserve_archived_room_trg
  BEFORE INSERT OR UPDATE ON beds
  FOR EACH ROW
  EXECUTE PROCEDURE public.beds_preserve_archived_room();

-- Runs after booking_beds_reject_overlap_trg (name sorts later).
-- Lock order: booking, then bed. No room-row lock.
CREATE OR REPLACE FUNCTION public.booking_beds_reject_archived_room()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  archived timestamptz;
  booking_status text;
BEGIN
  IF NEW.bed_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.booking_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('booking', NEW.booking_id));
  END IF;
  PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', NEW.bed_id));

  IF NEW.booking_id IS NOT NULL THEN
    SELECT b.status::text INTO booking_status
      FROM bookings b
     WHERE b.id = NEW.booking_id;
    IF booking_status IN ('cancelled', 'expired') THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT r.archived_at INTO archived
    FROM beds bd
    JOIN rooms r ON r.id = bd.room_id
   WHERE bd.id = NEW.bed_id;
  IF archived IS NOT NULL THEN
    RAISE EXCEPTION 'archived_room_admission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_booking_beds_reject_archived_admission_trg ON booking_beds;
CREATE TRIGGER zz_booking_beds_reject_archived_admission_trg
  BEFORE INSERT OR UPDATE
  ON booking_beds
  FOR EACH ROW
  EXECUTE PROCEDURE public.booking_beds_reject_archived_room();

CREATE OR REPLACE FUNCTION public.bookings_reject_archived_room_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec record;
  archived timestamptz;
  room_archived timestamptz;
BEGIN
  IF NEW.id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('booking', NEW.id));
  END IF;

  IF NEW.status::text IN ('cancelled', 'expired') THEN
    RETURN NEW;
  END IF;

  IF NEW.room_to_block_id IS NOT NULL THEN
    FOR rec IN
      SELECT bd.id AS bed_id
        FROM beds bd
       WHERE bd.room_id = NEW.room_to_block_id
       ORDER BY bd.id
    LOOP
      PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', rec.bed_id));
    END LOOP;
    SELECT r.archived_at INTO room_archived
      FROM rooms r
     WHERE r.id = NEW.room_to_block_id;
    IF room_archived IS NOT NULL THEN
      RAISE EXCEPTION 'archived_room_admission';
    END IF;
  END IF;

  IF NEW.primary_room_code IS NOT NULL AND btrim(NEW.primary_room_code) <> '' THEN
    FOR rec IN
      SELECT bd.id AS bed_id
        FROM rooms r
        JOIN beds bd ON bd.room_id = r.id
       WHERE r.client_id = NEW.client_id
         AND r.room_code = NEW.primary_room_code
       ORDER BY bd.id
    LOOP
      PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', rec.bed_id));
    END LOOP;
    SELECT r.archived_at INTO room_archived
      FROM rooms r
     WHERE r.client_id = NEW.client_id
       AND r.room_code = NEW.primary_room_code
     ORDER BY r.archived_at DESC NULLS LAST
     LIMIT 1;
    IF room_archived IS NOT NULL AND (
         NEW.check_out > (now() AT TIME ZONE 'Europe/Madrid')::date
         OR NEW.status::text = 'checked_in'
         OR COALESCE(NEW.assignment_status::text, '') IN ('assigned', 'assigning', 'needs_review')
       ) THEN
      RAISE EXCEPTION 'archived_room_admission';
    END IF;
  END IF;

  FOR rec IN
    SELECT bb.bed_id
      FROM booking_beds bb
     WHERE bb.booking_id = NEW.id
       AND bb.bed_id IS NOT NULL
     ORDER BY bb.bed_id
  LOOP
    PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', rec.bed_id));
    SELECT r.archived_at INTO archived
      FROM beds bd
      JOIN rooms r ON r.id = bd.room_id
     WHERE bd.id = rec.bed_id;
    IF archived IS NOT NULL THEN
      RAISE EXCEPTION 'archived_room_admission';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_bookings_reject_archived_admission_trg ON bookings;
CREATE TRIGGER zz_bookings_reject_archived_admission_trg
  BEFORE INSERT OR UPDATE OF status, room_to_block_id, primary_room_code, check_in, check_out, assignment_status
  ON bookings
  FOR EACH ROW
  EXECUTE PROCEDURE public.bookings_reject_archived_room_admission();

DO $ext$
BEGIN
  IF to_regclass('public.external_calendar_unit_maps') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.external_calendar_maps_reject_archived()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $body$
    DECLARE
      archived timestamptz;
    BEGIN
      IF NEW.bed_id IS NULL THEN
        RETURN NEW;
      END IF;
      PERFORM pg_advisory_xact_lock(public.booking_occupancy_lock_key('bed', NEW.bed_id));
      SELECT r.archived_at INTO archived
        FROM beds bd
        JOIN rooms r ON r.id = bd.room_id
       WHERE bd.id = NEW.bed_id;
      IF archived IS NOT NULL THEN
        RAISE EXCEPTION 'archived_room_admission';
      END IF;
      RETURN NEW;
    END;
    $body$;
  $fn$;
  EXECUTE 'DROP TRIGGER IF EXISTS external_calendar_maps_reject_archived_trg ON external_calendar_unit_maps';
  EXECUTE $trg$
    CREATE TRIGGER external_calendar_maps_reject_archived_trg
      BEFORE INSERT OR UPDATE OF bed_id
      ON external_calendar_unit_maps
      FOR EACH ROW
      EXECUTE PROCEDURE public.external_calendar_maps_reject_archived()
  $trg$;
END
$ext$;

COMMIT;
