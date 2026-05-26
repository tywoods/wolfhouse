-- Phase 2d — idempotent confirmation timestamp for Send Confirmation workflow
-- Safe to re-run.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_bookings_pending_confirmation
  ON bookings (client_id, updated_at)
  WHERE send_confirmation = TRUE
    AND status = 'payment_pending'
    AND confirmation_sent_at IS NULL;

COMMENT ON COLUMN bookings.confirmation_sent_at IS
  'Set when WhatsApp confirmation is successfully sent (Phase 2d local fork).';
