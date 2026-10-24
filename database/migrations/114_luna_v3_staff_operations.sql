-- 114_luna_v3_staff_operations.sql
-- Durable Luna v3 sessions, exact-bed holds, operation receipts and no-alert handoffs.
BEGIN;

-- Replay is allowed only over the historical Luna-owned predecessors or this
-- consolidated definition. Refuse before replacing any hold invariant or
-- adopting a same-named phone constraint.
DO $replay_ownership$
DECLARE
  hold_oid oid;
  hold_marker text;
  trigger_oid oid;
  trigger_def text;
  trigger_marker text;
  phone_oid oid;
  phone_def text;
  phone_marker text;
  phone_column_exists boolean := false;
  phone_column_marker text;
BEGIN
  hold_oid := to_regprocedure('public.luna_v3_hold_beds_reject_overlap()');
  IF hold_oid IS NOT NULL THEN
    SELECT obj_description(hold_oid,'pg_proc') INTO hold_marker;
    IF hold_marker IS NULL THEN
      IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=hold_oid)
         IS DISTINCT FROM '9be3799a04b79b394d331fadb688ead0' THEN
        RAISE EXCEPTION '114_refused: unmarked hold invariant is not the exact historical 114 predecessor';
      END IF;
    ELSIF hold_marker NOT IN (
      '116_luna_v3_session_phone_and_hold_invariant v1; extends 114-owned object',
      '118_luna_v3_private_optional_hold_eligibility v1; extends 116-owned object',
      '114_luna_v3_staff_operations v2; consolidated 116 and 118'
    ) THEN
      RAISE EXCEPTION '114_refused: hold invariant ownership is foreign/newer (%)',hold_marker;
    END IF;
  END IF;

  IF to_regclass('public.luna_v3_hold_beds') IS NOT NULL THEN
    SELECT oid,pg_get_triggerdef(oid,false),obj_description(oid,'pg_trigger')
      INTO trigger_oid,trigger_def,trigger_marker
      FROM pg_trigger
     WHERE tgrelid='public.luna_v3_hold_beds'::regclass
       AND tgname='luna_v3_hold_beds_reject_overlap_trg'
       AND NOT tgisinternal;
    IF trigger_oid IS NOT NULL THEN
      IF trigger_def IS DISTINCT FROM
           'CREATE TRIGGER luna_v3_hold_beds_reject_overlap_trg BEFORE INSERT OR UPDATE OF hold_id, client_id, bed_id ON public.luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION luna_v3_hold_beds_reject_overlap()'
      THEN RAISE EXCEPTION '114_refused: hold trigger definition is foreign/newer'; END IF;
      IF trigger_marker IS NOT NULL
         AND trigger_marker IS DISTINCT FROM '114_luna_v3_staff_operations v2; consolidated trigger' THEN
        RAISE EXCEPTION '114_refused: hold trigger ownership is foreign/newer (%)',trigger_marker;
      END IF;
    END IF;
  END IF;

  IF to_regclass('public.luna_v3_sessions') IS NOT NULL THEN
    SELECT true,col_description('public.luna_v3_sessions'::regclass,attnum)
      INTO phone_column_exists,phone_column_marker
      FROM pg_attribute
     WHERE attrelid='public.luna_v3_sessions'::regclass
       AND attname='guest_phone'
       AND NOT attisdropped;
    IF phone_column_exists AND phone_column_marker IS NULL THEN
      RAISE EXCEPTION '114_refused: existing guest_phone column is unowned';
    END IF;
    IF phone_column_marker IS NOT NULL
       AND phone_column_marker NOT IN (
         '116 server-owned trusted guest phone; never request-body authority',
         '114 server-owned trusted guest phone; never request-body authority'
       ) THEN
      RAISE EXCEPTION '114_refused: guest_phone column ownership is foreign/newer (%)',phone_column_marker;
    END IF;
    SELECT oid,pg_get_constraintdef(oid,false),obj_description(oid,'pg_constraint')
      INTO phone_oid,phone_def,phone_marker
      FROM pg_constraint
     WHERE conrelid='public.luna_v3_sessions'::regclass
       AND conname='luna_v3_sessions_guest_phone_bounded';
    IF phone_oid IS NOT NULL THEN
      IF phone_def IS DISTINCT FROM
           'CHECK (((guest_phone IS NULL) OR (((octet_length(guest_phone) >= 3) AND (octet_length(guest_phone) <= 40)) AND (guest_phone = btrim(guest_phone)))))'
      THEN RAISE EXCEPTION '114_refused: phone constraint definition is foreign/newer'; END IF;
      IF phone_marker IS NOT NULL
         AND phone_marker IS DISTINCT FROM '120_luna_v3_constraint_ownership_and_transfer_decline v1' THEN
        RAISE EXCEPTION '114_refused: phone constraint ownership is foreign/newer (%)',phone_marker;
      END IF;
    END IF;
  END IF;
END $replay_ownership$;

CREATE TABLE IF NOT EXISTS luna_v3_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_key text NOT NULL,
  principal_id text NOT NULL,
  write_admitted boolean NOT NULL DEFAULT false,
  selected_booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, session_key),
  CHECK (session_key LIKE 'luna-v3:%')
);

CREATE TABLE IF NOT EXISTS luna_v3_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  quote_revision text NOT NULL,
  check_in date NOT NULL,
  check_out date NOT NULL,
  guests jsonb NOT NULL,
  assignments jsonb NOT NULL,
  quote jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, session_id, quote_revision),
  CHECK (check_out > check_in),
  CHECK (jsonb_typeof(guests) = 'array'),
  CHECK (jsonb_typeof(assignments) = 'array'),
  CHECK (jsonb_typeof(quote) = 'object')
);

CREATE TABLE IF NOT EXISTS luna_v3_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  selection_id uuid NOT NULL REFERENCES luna_v3_selections(id) ON DELETE RESTRICT,
  check_in date NOT NULL,
  check_out date NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','converted','expired')),
  booking_id uuid REFERENCES bookings(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out > check_in),
  CHECK ((state = 'converted') = (booking_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS luna_v3_hold_beds (
  hold_id uuid NOT NULL REFERENCES luna_v3_holds(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  bed_id uuid NOT NULL REFERENCES beds(id) ON DELETE RESTRICT,
  guest_ordinal integer NOT NULL CHECK (guest_ordinal > 0),
  bed_code text NOT NULL,
  package_code text,
  PRIMARY KEY (hold_id, guest_ordinal),
  UNIQUE (hold_id, bed_id)
);
CREATE INDEX IF NOT EXISTS luna_v3_hold_beds_occupancy_idx ON luna_v3_hold_beds(client_id, bed_id);

CREATE TABLE IF NOT EXISTS luna_v3_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  tool text NOT NULL,
  operation_key text NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  receipt jsonb,
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','applied','rejected','unknown')),
  booking_id uuid REFERENCES bookings(id) ON DELETE RESTRICT,
  hold_id uuid REFERENCES luna_v3_holds(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (client_id, session_id, tool, operation_key)
);

CREATE TABLE IF NOT EXISTS luna_v3_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES luna_v3_sessions(id) ON DELETE CASCADE,
  booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Refuse to replace occupancy code unless it is exactly the implementation
-- owned by migration 091.  Missing, foreign and already-newer definitions all
-- fail closed; 114 deliberately takes ownership after replacement below.
DO $assert_091_ownership$
DECLARE owned text; oid oid; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['public.booking_beds_reject_overlap()','public.bookings_occupancy_status_guard()'] LOOP
    oid := to_regprocedure(signature);
    IF oid IS NULL THEN RAISE EXCEPTION '114_refused: required 091 function % is missing', signature; END IF;
    SELECT obj_description(oid,'pg_proc') INTO owned;
    IF owned IS DISTINCT FROM '091_booking_occupancy_serialization v1'
       AND owned IS DISTINCT FROM '114_luna_v3_staff_operations v1; preserves 091 and extends common occupancy boundary'
       AND owned IS DISTINCT FROM '114_luna_v3_staff_operations v2; preserves 091 and extends common occupancy boundary' THEN
      RAISE EXCEPTION '114_refused: function % is not expected 091-owned definition (comment=%)', signature, owned;
    END IF;
  END LOOP;
END
$assert_091_ownership$;

-- Both ordinary booking_beds and v3 holds take the same per-bed transaction lock.
-- The ordinary writer trigger rejects a committed active hold while holding that lock.
CREATE OR REPLACE FUNCTION booking_beds_reject_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE conflict_row uuid; booking_status text; rec record;
BEGIN
  IF NEW.id IS NULL THEN NEW.id := gen_random_uuid(); END IF;
  IF NEW.bed_id IS NULL OR NEW.client_id IS NULL OR NEW.booking_id IS NULL OR NEW.assignment_start_date IS NULL OR NEW.assignment_end_date IS NULL THEN RETURN NEW; END IF;
  IF NEW.assignment_end_date <= NEW.assignment_start_date THEN RAISE EXCEPTION 'booking_beds_invalid_range'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.booking_id IS DISTINCT FROM NEW.booking_id THEN
    FOR rec IN SELECT x.id FROM (VALUES (OLD.booking_id),(NEW.booking_id)) x(id) WHERE x.id IS NOT NULL ORDER BY x.id LOOP
      PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('booking',rec.id));
    END LOOP;
  ELSE PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('booking',NEW.booking_id)); END IF;
  IF TG_OP = 'UPDATE' AND (OLD.bed_id IS DISTINCT FROM NEW.bed_id OR OLD.client_id IS DISTINCT FROM NEW.client_id) THEN
    FOR rec IN SELECT * FROM (SELECT OLD.client_id client_id,OLD.bed_id bed_id UNION SELECT NEW.client_id,NEW.bed_id) beds ORDER BY client_id,bed_id LOOP
      PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',rec.bed_id));
    END LOOP;
  ELSE PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',NEW.bed_id)); END IF;
  SELECT status::text INTO booking_status FROM bookings WHERE id=NEW.booking_id;
  IF booking_status IN ('cancelled','expired') THEN RETURN NEW; END IF;
  SELECT bb.id INTO conflict_row FROM booking_beds bb JOIN bookings bk ON bk.id=bb.booking_id
   WHERE bb.client_id=NEW.client_id AND bb.bed_id=NEW.bed_id AND bb.id IS DISTINCT FROM NEW.id
     AND bb.assignment_start_date<NEW.assignment_end_date AND bb.assignment_end_date>NEW.assignment_start_date
     AND bk.status::text NOT IN ('cancelled','expired') LIMIT 1;
  IF conflict_row IS NULL THEN
    SELECT hb.hold_id INTO conflict_row FROM luna_v3_hold_beds hb JOIN luna_v3_holds h ON h.id=hb.hold_id
     WHERE hb.client_id=NEW.client_id AND hb.bed_id=NEW.bed_id AND h.state='active' AND h.expires_at>clock_timestamp()
       AND h.check_in<NEW.assignment_end_date AND h.check_out>NEW.assignment_start_date LIMIT 1;
  END IF;
  IF conflict_row IS NOT NULL THEN RAISE EXCEPTION 'booking_beds_overlap_conflict'; END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION booking_beds_reject_overlap() IS '114_luna_v3_staff_operations v2; preserves 091 and extends common occupancy boundary';

-- Hold insertion uses the identical bed lock and rejects ordinary occupancy even
-- when an application-level availability check is bypassed.
ALTER TABLE luna_v3_sessions ADD COLUMN IF NOT EXISTS guest_phone text;
DO $phone_constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.luna_v3_sessions'::regclass
                   AND conname='luna_v3_sessions_guest_phone_bounded') THEN
    ALTER TABLE luna_v3_sessions ADD CONSTRAINT luna_v3_sessions_guest_phone_bounded
      CHECK (guest_phone IS NULL OR (octet_length(guest_phone) BETWEEN 3 AND 40 AND guest_phone=btrim(guest_phone)));
  END IF;
END $phone_constraint$;
COMMENT ON COLUMN luna_v3_sessions.guest_phone IS '114 server-owned trusted guest phone; never request-body authority';

CREATE OR REPLACE FUNCTION luna_v3_hold_beds_reject_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE h luna_v3_holds%ROWTYPE; conflict_row uuid; eligible boolean;
BEGIN
  SELECT * INTO h FROM luna_v3_holds WHERE id=NEW.hold_id;
  IF h.id IS NULL OR h.client_id<>NEW.client_id THEN RAISE EXCEPTION 'luna_v3_hold_scope_invalid'; END IF;
  PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',NEW.bed_id));
  SELECT b.active AND COALESCE(b.sellable,true) AND r.active
    AND COALESCE(r.selling_mode,'shared') IN ('shared','private','private_optional')
    INTO eligible FROM beds b JOIN rooms r ON r.id=b.room_id AND r.client_id=b.client_id
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
COMMENT ON FUNCTION luna_v3_hold_beds_reject_overlap() IS '114_luna_v3_staff_operations v2; consolidated 116 and 118';
DROP TRIGGER IF EXISTS luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds;
CREATE TRIGGER luna_v3_hold_beds_reject_overlap_trg BEFORE INSERT OR UPDATE OF hold_id,client_id,bed_id
 ON luna_v3_hold_beds FOR EACH ROW EXECUTE FUNCTION luna_v3_hold_beds_reject_overlap();
COMMENT ON TRIGGER luna_v3_hold_beds_reject_overlap_trg ON luna_v3_hold_beds IS '114_luna_v3_staff_operations v2; consolidated trigger';

-- Preserve 091's inactive-booking reactivation guard and extend it to holds.
CREATE OR REPLACE FUNCTION bookings_occupancy_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rec record; conflict_row uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('booking',NEW.id));
  IF OLD.status::text IN ('cancelled','expired') AND NEW.status::text NOT IN ('cancelled','expired') THEN
    FOR rec IN SELECT bb.id,bb.client_id,bb.bed_id,bb.assignment_start_date,bb.assignment_end_date FROM booking_beds bb WHERE bb.booking_id=NEW.id ORDER BY bb.client_id,bb.bed_id,bb.id LOOP
      PERFORM pg_advisory_xact_lock(booking_occupancy_lock_key('bed',rec.bed_id));
      SELECT bb.id INTO conflict_row FROM booking_beds bb JOIN bookings bk ON bk.id=bb.booking_id
       WHERE bb.client_id=rec.client_id AND bb.bed_id=rec.bed_id AND bb.id IS DISTINCT FROM rec.id
       AND bb.assignment_start_date<rec.assignment_end_date AND bb.assignment_end_date>rec.assignment_start_date
       AND bk.status::text NOT IN ('cancelled','expired') LIMIT 1;
      IF conflict_row IS NULL THEN
        SELECT hb.hold_id INTO conflict_row FROM luna_v3_hold_beds hb JOIN luna_v3_holds h ON h.id=hb.hold_id
         WHERE hb.client_id=rec.client_id AND hb.bed_id=rec.bed_id AND h.state='active' AND h.expires_at>clock_timestamp()
         AND h.check_in<rec.assignment_end_date AND h.check_out>rec.assignment_start_date LIMIT 1;
      END IF;
      IF conflict_row IS NOT NULL THEN RAISE EXCEPTION 'booking_beds_overlap_conflict'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION bookings_occupancy_status_guard() IS '114_luna_v3_staff_operations v2; preserves 091 and extends common occupancy boundary';

COMMIT;
