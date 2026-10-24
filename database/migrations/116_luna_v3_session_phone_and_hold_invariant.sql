-- 116_luna_v3_session_phone_and_hold_invariant.sql
-- Trusted session phone and final exact-bed eligibility invariant.
BEGIN;

DO $ownership$
DECLARE marker text; hold_marker text;
BEGIN
  IF to_regclass('public.luna_v3_sessions') IS NULL OR to_regclass('public.luna_v3_hold_beds') IS NULL THEN
    RAISE EXCEPTION '116_refused: migration 114 objects are missing';
  END IF;
  IF to_regprocedure('public.luna_v3_hold_beds_reject_overlap()') IS NULL
     OR position('booking_beds_overlap_conflict' in pg_get_functiondef(to_regprocedure('public.luna_v3_hold_beds_reject_overlap()'))) = 0
  THEN RAISE EXCEPTION '116_refused: 114 hold invariant is missing or foreign'; END IF;
  SELECT obj_description(to_regprocedure('public.luna_v3_hold_beds_reject_overlap()'),'pg_proc') INTO hold_marker;
  IF hold_marker IS NULL THEN
    -- 114 predates the ownership comment. Its stored PL/pgSQL source is stable
    -- across server pretty-printers, so admit only that exact predecessor body.
    IF (SELECT md5(prosrc) FROM pg_proc
          WHERE oid=to_regprocedure('public.luna_v3_hold_beds_reject_overlap()'))
       IS DISTINCT FROM '9be3799a04b79b394d331fadb688ead0'
    THEN RAISE EXCEPTION '116_refused: unmarked hold invariant is not the exact 114 predecessor'; END IF;
  ELSIF hold_marker IS DISTINCT FROM '116_luna_v3_session_phone_and_hold_invariant v1; extends 114-owned object' THEN
    RAISE EXCEPTION '116_refused: hold invariant is foreign/newer (comment=%)',hold_marker;
  END IF;
  SELECT obj_description(to_regprocedure('public.booking_beds_reject_overlap()'),'pg_proc') INTO marker;
  IF marker IS DISTINCT FROM '114_luna_v3_staff_operations v1; preserves 091 and extends common occupancy boundary' THEN
    RAISE EXCEPTION '116_refused: booking occupancy function is not 114-owned (comment=%)',marker;
  END IF;
END $ownership$;

ALTER TABLE luna_v3_sessions ADD COLUMN IF NOT EXISTS guest_phone text;
ALTER TABLE luna_v3_sessions DROP CONSTRAINT IF EXISTS luna_v3_sessions_guest_phone_bounded;
ALTER TABLE luna_v3_sessions ADD CONSTRAINT luna_v3_sessions_guest_phone_bounded
  CHECK (guest_phone IS NULL OR (octet_length(guest_phone) BETWEEN 3 AND 40 AND guest_phone = btrim(guest_phone)));

CREATE OR REPLACE FUNCTION luna_v3_hold_beds_reject_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h luna_v3_holds%ROWTYPE; conflict_row uuid; eligible boolean;
BEGIN
  SELECT * INTO h FROM luna_v3_holds WHERE id=NEW.hold_id;
  IF h.id IS NULL OR h.client_id<>NEW.client_id THEN RAISE EXCEPTION 'luna_v3_hold_scope_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',NEW.bed_id));
  SELECT b.active AND COALESCE(b.sellable,true) AND r.active
    AND COALESCE(r.selling_mode,'shared') IN ('shared','private')
    INTO eligible
    FROM beds b JOIN rooms r ON r.id=b.room_id AND r.client_id=b.client_id
   WHERE b.id=NEW.bed_id AND b.client_id=NEW.client_id AND b.bed_code=NEW.bed_code
   FOR KEY SHARE OF b,r;
  IF eligible IS DISTINCT FROM true THEN RAISE EXCEPTION 'luna_v3_hold_bed_ineligible'; END IF;
  SELECT bb.id INTO conflict_row FROM booking_beds bb JOIN bookings bk ON bk.id=bb.booking_id
   WHERE bb.client_id=NEW.client_id AND bb.bed_id=NEW.bed_id
     AND bb.assignment_start_date<h.check_out AND bb.assignment_end_date>h.check_in
     AND bk.status::text NOT IN ('cancelled','expired') LIMIT 1;
  IF conflict_row IS NOT NULL THEN RAISE EXCEPTION 'booking_beds_overlap_conflict'; END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION luna_v3_hold_beds_reject_overlap() IS '116_luna_v3_session_phone_and_hold_invariant v1; extends 114-owned object';
COMMENT ON COLUMN luna_v3_sessions.guest_phone IS '116 server-owned trusted guest phone; never request-body authority';
COMMIT;
