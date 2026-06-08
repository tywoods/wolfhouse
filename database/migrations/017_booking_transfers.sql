-- Phase 26b — Airport transfer records per booking (multi-client)
--
-- At most one arrival and one departure transfer per booking (UNIQUE booking_id + direction).
-- Client transfer pricing/inclusion rules live in scripts/lib/client-transfer-config.js — not here.

BEGIN;

CREATE TABLE IF NOT EXISTS booking_transfers (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug             TEXT NOT NULL,
  booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  direction               TEXT NOT NULL CHECK (direction IN ('arrival', 'departure')),
  status                  TEXT NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested', 'confirmed', 'cancelled', 'not_needed')),
  airport_code            TEXT,
  airport_label           TEXT,
  flight_number           TEXT,
  lookup_date             DATE,
  scheduled_at            TIMESTAMPTZ,
  pickup_location         TEXT,
  dropoff_location        TEXT,
  guest_count             INTEGER,
  price_cents             INTEGER,
  currency                TEXT NOT NULL DEFAULT 'EUR',
  included_in_package     BOOLEAN,
  pricing_note            TEXT,
  notes                   TEXT,
  source                  TEXT NOT NULL DEFAULT 'staff'
                          CHECK (source IN ('staff', 'luna', 'owner', 'import', 'flight_lookup')),
  flight_lookup_provider  TEXT,
  flight_lookup_status    TEXT,
  flight_lookup_summary   JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT booking_transfers_booking_direction_unique
    UNIQUE (booking_id, direction)
);

COMMENT ON TABLE booking_transfers IS
  'Phase 26b airport transfer rows per booking. Max one arrival + one departure per booking. '
  'Pricing rules are client config — not hard-coded in this table.';

COMMENT ON COLUMN booking_transfers.flight_lookup_summary IS
  'Sanitized flight lookup metadata only — no raw provider payload.';

CREATE INDEX IF NOT EXISTS idx_booking_transfers_client_booking
  ON booking_transfers (client_slug, booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_transfers_client_lookup_date
  ON booking_transfers (client_slug, lookup_date);

CREATE INDEX IF NOT EXISTS idx_booking_transfers_client_scheduled_at
  ON booking_transfers (client_slug, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_booking_transfers_client_airport
  ON booking_transfers (client_slug, airport_code);

CREATE INDEX IF NOT EXISTS idx_booking_transfers_client_status
  ON booking_transfers (client_slug, status);

CREATE TRIGGER booking_transfers_updated_at
  BEFORE UPDATE ON booking_transfers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
