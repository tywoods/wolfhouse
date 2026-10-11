-- Down for 112. Refuses while any room is still archived.
-- Do not run this to roll back an archive-aware image: the CSV fallback
-- could resurrect those rooms. Restore or reconcile first.
BEGIN;

DO $refuse$
BEGIN
  IF to_regclass('public.rooms') IS NOT NULL
     AND EXISTS (SELECT 1 FROM rooms WHERE archived_at IS NOT NULL) THEN
    RAISE EXCEPTION '112_down_refused: archived rooms exist; restore them before dropping the archive marker';
  END IF;
END
$refuse$;

DO $drop_ext$
BEGIN
  IF to_regclass('public.external_calendar_unit_maps') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS external_calendar_maps_reject_archived_trg ON external_calendar_unit_maps;
  END IF;
END
$drop_ext$;
DROP FUNCTION IF EXISTS public.external_calendar_maps_reject_archived();
DROP TRIGGER IF EXISTS zz_bookings_reject_archived_admission_trg ON bookings;
DROP FUNCTION IF EXISTS public.bookings_reject_archived_room_admission();
DROP TRIGGER IF EXISTS zz_booking_beds_reject_archived_admission_trg ON booking_beds;
DROP FUNCTION IF EXISTS public.booking_beds_reject_archived_room();
DROP TRIGGER IF EXISTS beds_preserve_archived_room_trg ON beds;
DROP FUNCTION IF EXISTS public.beds_preserve_archived_room();
DROP TRIGGER IF EXISTS rooms_preserve_archive_marker_trg ON rooms;
DROP FUNCTION IF EXISTS public.rooms_preserve_archive_marker();
DROP TABLE IF EXISTS staff_room_fill_inventory_operations;
ALTER TABLE rooms DROP COLUMN IF EXISTS archive_operation_id;
ALTER TABLE rooms DROP COLUMN IF EXISTS archived_at;

COMMIT;
