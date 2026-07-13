-- Sunset payment-link idempotency guard (staging).
-- Prevents duplicate payable draft/checkout rows for the same booking + request key.

CREATE UNIQUE INDEX IF NOT EXISTS payments_sunset_booking_idempotency_unique
  ON payments (booking_id, (metadata->>'idempotency_key'))
  WHERE metadata->>'idempotency_key' IS NOT NULL
    AND metadata->>'idempotency_key' <> ''
    AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status);

COMMENT ON INDEX payments_sunset_booking_idempotency_unique IS
  'One active Sunset payment-link row per booking + client idempotency key.';
