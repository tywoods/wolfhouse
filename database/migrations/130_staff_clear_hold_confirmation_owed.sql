-- DH-STAFF-1644: Inbox Clear stamps cleared_at (history kept).
-- Confirmation owed per saved booking; clears only on real delivery.
BEGIN;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS booking_confirmation_owed (
  booking_id UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id),
  owed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at TIMESTAMPTZ,
  clear_reason TEXT,
  provider_message_id TEXT,
  CONSTRAINT booking_confirmation_owed_clear_reason_chk
    CHECK (cleared_at IS NULL OR clear_reason = 'delivered')
);

CREATE INDEX IF NOT EXISTS booking_confirmation_owed_open_idx
  ON booking_confirmation_owed (client_id)
  WHERE cleared_at IS NULL;

COMMIT;
