-- 119_luna_v3_guest_payment_history.sql
-- Preserve every authoritative per-guest payment association when Staff replaces
-- booking_guests.payment_id with a newly finalized payment pointer.
--
-- This migration is deliberately fail-closed.  A replay is accepted only when
-- every 119-owned object still has its exact ownership marker; partial, foreign,
-- or newer installations are never repaired or replaced implicitly.
BEGIN;

DO $preflight$
DECLARE
  marker constant text := '119_luna_v3_guest_payment_history v1';
  present integer;
  bad text;
BEGIN
  IF to_regclass('public.booking_guests') IS NULL
     OR to_regclass('public.payments') IS NULL
     OR to_regclass('public.luna_v3_payment_links') IS NULL
  THEN RAISE EXCEPTION '119_refused: prerequisite tables are missing'; END IF;
  IF obj_description('public.luna_v3_payment_links'::regclass,'pg_class')
       IS DISTINCT FROM '115_luna_v3_guest_operations v1'
  THEN RAISE EXCEPTION '119_refused: payment links table is foreign/newer'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='payments'
                    AND column_name='booking_guest_id')
  THEN RAISE EXCEPTION '119_refused: payments.booking_guest_id is missing'; END IF;

  SELECT count(*) INTO present FROM (
    SELECT 1 WHERE to_regclass('public.luna_v3_guest_payments') IS NOT NULL
    UNION ALL SELECT 1 WHERE to_regclass('public.luna_v3_guest_payments_payment_uq') IS NOT NULL
    UNION ALL SELECT 1 WHERE to_regprocedure('public.luna_v3_preserve_guest_payment_history()') IS NOT NULL
    UNION ALL SELECT 1 FROM pg_constraint WHERE conrelid='public.booking_guests'::regclass
      AND conname='booking_guests_id_booking_client_uq_119'
    UNION ALL SELECT 1 FROM pg_constraint WHERE conrelid='public.luna_v3_payment_links'::regclass
      AND conname='luna_v3_payment_links_guest_payment_history_fk'
    UNION ALL SELECT 1 FROM pg_trigger WHERE tgrelid='public.booking_guests'::regclass
      AND tgname='luna_v3_preserve_guest_payment_history_trg' AND NOT tgisinternal
  ) objects;
  IF present NOT IN (0,6) THEN
    RAISE EXCEPTION '119_refused: partial installation (%/6 objects)',present;
  END IF;
  IF present=6 THEN
    SELECT string_agg(name,', ' ORDER BY name) INTO bad FROM (
      SELECT 'table' name WHERE obj_description('public.luna_v3_guest_payments'::regclass,'pg_class') IS DISTINCT FROM marker
      UNION ALL SELECT 'index' WHERE obj_description('public.luna_v3_guest_payments_payment_uq'::regclass,'pg_class') IS DISTINCT FROM marker
      UNION ALL SELECT 'function' WHERE obj_description(to_regprocedure('public.luna_v3_preserve_guest_payment_history()'),'pg_proc') IS DISTINCT FROM marker
      UNION ALL SELECT 'guest-key' WHERE (SELECT obj_description(oid,'pg_constraint') FROM pg_constraint WHERE conrelid='public.booking_guests'::regclass AND conname='booking_guests_id_booking_client_uq_119') IS DISTINCT FROM marker
      UNION ALL SELECT 'link-fk' WHERE (SELECT obj_description(oid,'pg_constraint') FROM pg_constraint WHERE conrelid='public.luna_v3_payment_links'::regclass AND conname='luna_v3_payment_links_guest_payment_history_fk') IS DISTINCT FROM marker
      UNION ALL SELECT 'trigger' WHERE (SELECT obj_description(oid,'pg_trigger') FROM pg_trigger WHERE tgrelid='public.booking_guests'::regclass AND tgname='luna_v3_preserve_guest_payment_history_trg' AND NOT tgisinternal) IS DISTINCT FROM marker
    ) foreign_objects;
    IF bad IS NOT NULL THEN
      RAISE EXCEPTION '119_refused: foreign/newer owned objects: %',bad;
    END IF;
  END IF;
END $preflight$;

DO $install$
DECLARE old_name text;
BEGIN
  IF to_regclass('public.luna_v3_guest_payments') IS NULL THEN
    ALTER TABLE booking_guests ADD CONSTRAINT booking_guests_id_booking_client_uq_119
      UNIQUE(id,booking_id,client_id);
    COMMENT ON CONSTRAINT booking_guests_id_booking_client_uq_119 ON booking_guests IS
      '119_luna_v3_guest_payment_history v1';

    CREATE TABLE luna_v3_guest_payments (
      client_id uuid NOT NULL,
      booking_id uuid NOT NULL,
      booking_guest_id uuid NOT NULL,
      payment_id uuid NOT NULL,
      associated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (client_id, booking_id, booking_guest_id, payment_id),
      FOREIGN KEY (payment_id,booking_id,client_id)
        REFERENCES payments(id,booking_id,client_id) ON DELETE RESTRICT,
      FOREIGN KEY (booking_guest_id,booking_id,client_id)
        REFERENCES booking_guests(id,booking_id,client_id) ON DELETE RESTRICT
    );
    COMMENT ON TABLE luna_v3_guest_payments IS '119_luna_v3_guest_payment_history v1';
    CREATE UNIQUE INDEX luna_v3_guest_payments_payment_uq
      ON luna_v3_guest_payments(client_id,booking_id,payment_id);
    COMMENT ON INDEX luna_v3_guest_payments_payment_uq IS '119_luna_v3_guest_payment_history v1';

    CREATE FUNCTION luna_v3_preserve_guest_payment_history() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF NEW.payment_id IS NOT NULL THEN
        INSERT INTO luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id)
        VALUES(NEW.client_id,NEW.booking_id,NEW.id,NEW.payment_id)
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END $function$;
    COMMENT ON FUNCTION luna_v3_preserve_guest_payment_history() IS '119_luna_v3_guest_payment_history v1';
    CREATE TRIGGER luna_v3_preserve_guest_payment_history_trg
      AFTER INSERT OR UPDATE OF payment_id ON booking_guests
      FOR EACH ROW EXECUTE FUNCTION luna_v3_preserve_guest_payment_history();
    COMMENT ON TRIGGER luna_v3_preserve_guest_payment_history_trg ON booking_guests IS
      '119_luna_v3_guest_payment_history v1';

    -- Existing 115 payment-link rows must already have a history target before
    -- PostgreSQL validates the replacement FK below.
    INSERT INTO luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id)
    SELECT p.client_id,p.booking_id,p.booking_guest_id,p.id
      FROM payments p WHERE p.booking_guest_id IS NOT NULL
    UNION
    SELECT g.client_id,g.booking_id,g.id,g.payment_id
      FROM booking_guests g WHERE g.payment_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- 115's pointer FK is identified by its exact ordered columns, not merely
    -- by any FK which happens to reference booking_guests.
    SELECT c.conname INTO old_name
      FROM pg_constraint c
     WHERE c.conrelid='public.luna_v3_payment_links'::regclass
       AND c.confrelid='public.booking_guests'::regclass AND c.contype='f'
       AND (SELECT array_agg(a.attname ORDER BY u.ord)
              FROM unnest(c.conkey) WITH ORDINALITY u(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.attnum)
           = ARRAY['booking_guest_id','payment_id','booking_id','client_id']::name[]
       AND (SELECT array_agg(a.attname ORDER BY u.ord)
              FROM unnest(c.confkey) WITH ORDINALITY u(attnum,ord)
              JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=u.attnum)
           = ARRAY['id','payment_id','booking_id','client_id']::name[];
    IF old_name IS NULL THEN RAISE EXCEPTION '119_refused: exact 115 guest pointer constraint missing'; END IF;
    EXECUTE format('ALTER TABLE luna_v3_payment_links DROP CONSTRAINT %I',old_name);
    ALTER TABLE luna_v3_payment_links
      ADD CONSTRAINT luna_v3_payment_links_guest_payment_history_fk
      FOREIGN KEY(client_id,booking_id,booking_guest_id,payment_id)
      REFERENCES luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id)
      ON DELETE RESTRICT;
    COMMENT ON CONSTRAINT luna_v3_payment_links_guest_payment_history_fk ON luna_v3_payment_links IS
      '119_luna_v3_guest_payment_history v1';
  END IF;
END $install$;

-- Replay-safe backfill.  payments.booking_guest_id is the historical authority;
-- booking_guests.payment_id contributes the current pointer for older rows where
-- that historical field was never populated.  Scope mismatches fail atomically
-- through the history table's composite foreign keys/unique payment ownership.
INSERT INTO luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id)
SELECT p.client_id,p.booking_id,p.booking_guest_id,p.id
  FROM payments p WHERE p.booking_guest_id IS NOT NULL
UNION
SELECT g.client_id,g.booking_id,g.id,g.payment_id
  FROM booking_guests g WHERE g.payment_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
