-- Slice A — Per-guest booking & payments foundation (Wolfhouse Staff API)
-- Tenant-neutral: client_id-scoped so Sunset can reuse.
-- Reversible via 024_booking_guests_down.sql

BEGIN;

CREATE TABLE IF NOT EXISTS booking_guests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  guest_number            INTEGER NOT NULL CHECK (guest_number >= 1),
  guest_name              TEXT NOT NULL,
  assigned_room_code      TEXT,
  assigned_bed_code       TEXT,
  deposit_amount_cents    INTEGER NOT NULL DEFAULT 0 CHECK (deposit_amount_cents >= 0),
  amount_paid_cents       INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  payment_status          TEXT NOT NULL DEFAULT 'not_requested',
  payment_id              UUID REFERENCES payments(id) ON DELETE SET NULL,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, guest_number)
);

CREATE INDEX IF NOT EXISTS idx_booking_guests_booking
  ON booking_guests (booking_id);

CREATE INDEX IF NOT EXISTS idx_booking_guests_client_booking
  ON booking_guests (client_id, booking_id);

CREATE TRIGGER booking_guests_updated_at
  BEFORE UPDATE ON booking_guests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE booking_guests IS 'Named guests on a booking — beds, deposits, and per-guest payment links (Slice A)';
COMMENT ON COLUMN booking_guests.guest_number IS '1-based index within the booking; stable for /pay/{code}/g{n} short links';
COMMENT ON COLUMN booking_guests.payment_status IS 'Per-guest payment truth: not_requested | draft | checkout_created | paid | …';

-- Link payments to a specific guest (nullable — whole-booking payments stay NULL)
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS booking_guest_id UUID REFERENCES booking_guests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payments_booking_guest
  ON payments (booking_guest_id)
  WHERE booking_guest_id IS NOT NULL;

COMMIT;
