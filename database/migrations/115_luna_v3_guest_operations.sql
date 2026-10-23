-- 115_luna_v3_guest_operations.sql
-- Durable scoped notes, provider checkout receipts and transfer receipts.
-- Objects are owned by the exact COMMENT marker below. A partial or foreign
-- install is refused rather than repaired/replaced implicitly.
BEGIN;

DO $ownership$
DECLARE n integer; bad text;
BEGIN
  SELECT count(*) INTO n FROM pg_class
   WHERE oid IN (to_regclass('public.luna_v3_notes'),to_regclass('public.luna_v3_payment_links'),to_regclass('public.luna_v3_transfer_requests'));
  IF n NOT IN (0,3) THEN RAISE EXCEPTION '115_refused: partial installation (%/3 tables)',n; END IF;
  IF n=3 THEN
    SELECT string_agg(c.relname,',') INTO bad FROM pg_class c
     WHERE c.oid IN (to_regclass('public.luna_v3_notes'),to_regclass('public.luna_v3_payment_links'),to_regclass('public.luna_v3_transfer_requests'))
       AND obj_description(c.oid,'pg_class') IS DISTINCT FROM '115_luna_v3_guest_operations v1';
    IF bad IS NOT NULL THEN RAISE EXCEPTION '115_refused: foreign/newer owned objects: %',bad; END IF;
    IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='luna_v3_transfer_requests' AND column_name='operation_id')
       OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='luna_v3_payment_links' AND column_name='operation_id')
       OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='luna_v3_payment_links' AND column_name='booking_guest_id')
       OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='luna_v3_notes' AND column_name='operation_id')
    THEN RAISE EXCEPTION '115_refused: owned objects have incomplete/newer shape'; END IF;
  END IF;
END $ownership$;

-- Composite candidate keys make tenant identity part of every relationship.
DO $constraints$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='clients_id_uq_115') THEN ALTER TABLE clients ADD CONSTRAINT clients_id_uq_115 UNIQUE(id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='bookings_id_client_uq_115') THEN ALTER TABLE bookings ADD CONSTRAINT bookings_id_client_uq_115 UNIQUE(id,client_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='luna_v3_sessions_id_client_uq_115') THEN ALTER TABLE luna_v3_sessions ADD CONSTRAINT luna_v3_sessions_id_client_uq_115 UNIQUE(id,client_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='luna_v3_operations_scope_uq_115') THEN ALTER TABLE luna_v3_operations ADD CONSTRAINT luna_v3_operations_scope_uq_115 UNIQUE(id,client_id,session_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='payments_id_booking_client_uq_115') THEN ALTER TABLE payments ADD CONSTRAINT payments_id_booking_client_uq_115 UNIQUE(id,booking_id,client_id); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='booking_guests_payment_scope_uq_115') THEN ALTER TABLE booking_guests ADD CONSTRAINT booking_guests_payment_scope_uq_115 UNIQUE(id,payment_id,booking_id,client_id); END IF;
END $constraints$;

CREATE TABLE IF NOT EXISTS luna_v3_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL,
 session_id uuid NOT NULL, booking_id uuid, operation_id uuid NOT NULL UNIQUE,
 text text NOT NULL CHECK(octet_length(text) BETWEEN 1 AND 8000), context jsonb NOT NULL DEFAULT '{}'::jsonb,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,client_id) REFERENCES luna_v3_sessions(id,client_id) ON DELETE CASCADE,
 FOREIGN KEY(booking_id,client_id) REFERENCES bookings(id,client_id) ON DELETE RESTRICT,
 FOREIGN KEY(operation_id,client_id,session_id) REFERENCES luna_v3_operations(id,client_id,session_id) ON DELETE RESTRICT
);
COMMENT ON TABLE luna_v3_notes IS '115_luna_v3_guest_operations v1';
CREATE INDEX IF NOT EXISTS luna_v3_notes_scope_idx ON luna_v3_notes(client_id,session_id,booking_id,created_at);

CREATE TABLE IF NOT EXISTS luna_v3_payment_links (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, session_id uuid NOT NULL,
 booking_id uuid NOT NULL, operation_id uuid NOT NULL UNIQUE, payment_id uuid NOT NULL, booking_guest_id uuid NOT NULL,
 payment_choice text NOT NULL CHECK(payment_choice IN('deposit','full','balance')),
 amount_cents integer NOT NULL CHECK(amount_cents>0), currency text NOT NULL,
 provider_checkout_id text NOT NULL UNIQUE, provider_url text NOT NULL,
 provider_livemode boolean NOT NULL CHECK(provider_livemode=false), provider_readback jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,client_id) REFERENCES luna_v3_sessions(id,client_id) ON DELETE CASCADE,
 FOREIGN KEY(booking_id,client_id) REFERENCES bookings(id,client_id) ON DELETE RESTRICT,
 FOREIGN KEY(payment_id,booking_id,client_id) REFERENCES payments(id,booking_id,client_id) ON DELETE RESTRICT,
 FOREIGN KEY(booking_guest_id,payment_id,booking_id,client_id) REFERENCES booking_guests(id,payment_id,booking_id,client_id) ON DELETE RESTRICT,
 FOREIGN KEY(operation_id,client_id,session_id) REFERENCES luna_v3_operations(id,client_id,session_id) ON DELETE RESTRICT
);
COMMENT ON TABLE luna_v3_payment_links IS '115_luna_v3_guest_operations v1';

CREATE TABLE IF NOT EXISTS luna_v3_transfer_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid NOT NULL, session_id uuid NOT NULL,
 booking_id uuid NOT NULL, operation_id uuid NOT NULL UNIQUE,
 authoritative_transfer_id uuid REFERENCES booking_transfers(id) ON DELETE RESTRICT,
 decision text NOT NULL CHECK(decision IN('requested','declined')), travel_details jsonb NOT NULL DEFAULT '{}'::jsonb,
 state text NOT NULL CHECK(state IN('pending','declined')), priced_cents integer, currency text,
 CHECK((decision='requested')=(authoritative_transfer_id IS NOT NULL)),
 CHECK((priced_cents IS NULL AND currency IS NULL) OR (priced_cents>=0 AND currency IS NOT NULL)),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(session_id,client_id) REFERENCES luna_v3_sessions(id,client_id) ON DELETE CASCADE,
 FOREIGN KEY(booking_id,client_id) REFERENCES bookings(id,client_id) ON DELETE RESTRICT,
 FOREIGN KEY(operation_id,client_id,session_id) REFERENCES luna_v3_operations(id,client_id,session_id) ON DELETE RESTRICT
);
COMMENT ON TABLE luna_v3_transfer_requests IS '115_luna_v3_guest_operations v1';
COMMIT;
