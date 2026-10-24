-- 118_luna_v3_private_optional_hold_eligibility.sql
-- Extend the 116-owned Luna v3 exact-bed trigger to admit private_optional rooms.
BEGIN;

DO $ownership$
DECLARE marker text;
BEGIN
  IF to_regprocedure('public.luna_v3_hold_beds_reject_overlap()') IS NULL THEN
    RAISE EXCEPTION '118_refused: migration 116 hold invariant is missing';
  END IF;
  SELECT obj_description(to_regprocedure('public.luna_v3_hold_beds_reject_overlap()'),'pg_proc') INTO marker;
  IF marker IS DISTINCT FROM '116_luna_v3_session_phone_and_hold_invariant v1; extends 114-owned object' THEN
    RAISE EXCEPTION '118_refused: hold invariant is not 116-owned (comment=%)',marker;
  END IF;
END $ownership$;

CREATE OR REPLACE FUNCTION luna_v3_hold_beds_reject_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h luna_v3_holds%ROWTYPE; conflict_row uuid; eligible boolean;
BEGIN
  SELECT * INTO h FROM luna_v3_holds WHERE id=NEW.hold_id;
  IF h.id IS NULL OR h.client_id<>NEW.client_id THEN RAISE EXCEPTION 'luna_v3_hold_scope_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',NEW.bed_id));
  SELECT b.active AND COALESCE(b.sellable,true) AND r.active
    AND COALESCE(r.selling_mode,'shared') IN ('shared','private','private_optional')
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
COMMENT ON FUNCTION luna_v3_hold_beds_reject_overlap() IS '118_luna_v3_private_optional_hold_eligibility v1; extends 116-owned object';
COMMIT;
