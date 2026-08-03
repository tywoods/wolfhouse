-- 056: additive manual booking refund ledger (Sunset Admin Bookings N1 / Finance Slice 2 seam).
-- Manual accounting records only — does NOT perform or claim a Stripe refund.
--
-- Tenant consistency: composite FK (booking_id, client_id) → bookings(id, client_id)
-- so a refund cannot reference a booking under a different client than its client_id.
--
-- Retention / append-only:
--   * FK ON DELETE RESTRICT on booking + client — deleting a booking/client that has
--     refund rows fails closed (audit retention; no CASCADE destruction of refunds).
--   * BEFORE UPDATE always rejected.
--   * BEFORE DELETE rejected unless session: SET LOCAL wh.allow_booking_refund_mutation = 'on'
--     (controlled maintenance/migration only).
-- Money is integer cents. Idempotency unique (client_id, idempotency_key).

BEGIN;

-- Composite uniqueness required for composite FK from booking_refund_records.
-- bookings.id is already PK; (id, client_id) is unique because id is unique.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_id_client_id_uidx
  ON bookings (id, client_id);

CREATE TABLE IF NOT EXISTS booking_refund_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          UUID NOT NULL,
  booking_id         UUID NOT NULL,
  location_id        TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  currency           CHAR(3) NOT NULL DEFAULT 'EUR',
  effective_date     DATE NOT NULL,
  reason             TEXT NOT NULL,
  staff_user_id      TEXT NULL,
  staff_email        TEXT NULL,
  staff_role         TEXT NULL,
  idempotency_key    TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'staff_manual_record'
                     CHECK (source = 'staff_manual_record'),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT booking_refund_records_reason_nonempty CHECK (char_length(btrim(reason)) > 0),
  CONSTRAINT booking_refund_records_location_nonempty CHECK (char_length(btrim(location_id)) > 0),
  CONSTRAINT booking_refund_records_idempotency_nonempty CHECK (char_length(btrim(idempotency_key)) > 0),
  CONSTRAINT booking_refund_records_currency_eur CHECK (currency = 'EUR'),
  -- Same-tenant booking: composite FK enforces booking.client_id = refund.client_id.
  CONSTRAINT booking_refund_records_booking_client_fk
    FOREIGN KEY (booking_id, client_id)
    REFERENCES bookings (id, client_id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE,
  CONSTRAINT booking_refund_records_client_fk
    FOREIGN KEY (client_id)
    REFERENCES clients (id)
    ON DELETE RESTRICT
    ON UPDATE CASCADE
);

COMMENT ON TABLE booking_refund_records IS
  'Manual refund accounting ledger for Admin Bookings / future Finance Slice 2. Does not call Stripe or invent Stripe refund IDs. Append-only audit retention: UPDATE always blocked; DELETE only when wh.allow_booking_refund_mutation=on; FK RESTRICT prevents CASCADE wipe. Idempotent per client_id + idempotency_key; composite FK binds booking+client.';

COMMENT ON COLUMN booking_refund_records.amount_cents IS
  'Positive integer cents only. Cumulative refunds for a booking must not exceed authoritative collected gross (enforced in write path with row lock).';

COMMENT ON COLUMN booking_refund_records.source IS
  'Always staff_manual_record — never implies a Stripe refund webhook.';

COMMENT ON COLUMN booking_refund_records.idempotency_key IS
  'Client-supplied key unique per tenant so retries cannot duplicate refund rows. Semantic payload (booking/location/amount/date/reason) must match on retry.';

CREATE UNIQUE INDEX IF NOT EXISTS booking_refund_records_client_idempotency_uidx
  ON booking_refund_records (client_id, idempotency_key);

CREATE INDEX IF NOT EXISTS booking_refund_records_booking_idx
  ON booking_refund_records (booking_id, created_at DESC);

CREATE INDEX IF NOT EXISTS booking_refund_records_client_location_idx
  ON booking_refund_records (client_id, location_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS booking_refund_records_client_created_idx
  ON booking_refund_records (client_id, created_at DESC);

-- Append-only guards (database-level; not app-only).
CREATE OR REPLACE FUNCTION booking_refund_records_reject_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'booking_refund_records is append-only (UPDATE forbidden)'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION booking_refund_records_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  allow_flag text;
BEGIN
  BEGIN
    allow_flag := current_setting('wh.allow_booking_refund_mutation', true);
  EXCEPTION WHEN OTHERS THEN
    allow_flag := NULL;
  END;
  IF allow_flag IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'booking_refund_records is append-only (DELETE forbidden unless wh.allow_booking_refund_mutation=on)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS booking_refund_records_no_update ON booking_refund_records;
CREATE TRIGGER booking_refund_records_no_update
  BEFORE UPDATE ON booking_refund_records
  FOR EACH ROW
  EXECUTE FUNCTION booking_refund_records_reject_update();

DROP TRIGGER IF EXISTS booking_refund_records_no_delete ON booking_refund_records;
CREATE TRIGGER booking_refund_records_no_delete
  BEFORE DELETE ON booking_refund_records
  FOR EACH ROW
  EXECUTE FUNCTION booking_refund_records_reject_delete();

COMMENT ON FUNCTION booking_refund_records_reject_update() IS
  'Blocks all UPDATE on booking_refund_records (append-only audit ledger).';
COMMENT ON FUNCTION booking_refund_records_reject_delete() IS
  'Blocks DELETE on booking_refund_records unless SET LOCAL wh.allow_booking_refund_mutation = on (controlled maintenance).';

COMMIT;
