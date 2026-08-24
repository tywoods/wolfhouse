-- Down for 091: remove exactly the occupancy serialization objects.
-- Safe and repeatable if objects are already absent.

BEGIN;

DROP TRIGGER IF EXISTS bookings_occupancy_status_trg ON public.bookings;
DROP TRIGGER IF EXISTS booking_beds_reject_overlap_trg ON public.booking_beds;
DROP FUNCTION IF EXISTS public.bookings_occupancy_status_guard();
DROP FUNCTION IF EXISTS public.booking_beds_reject_overlap();
DROP FUNCTION IF EXISTS public.booking_occupancy_lock_key(text, uuid);

COMMIT;
