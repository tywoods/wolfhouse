-- 053: durable finance exclusion for payments on deleted cancelled schedule bookings.
-- Never deletes payment rows or payment_events. Never invents Stripe refunds.
-- Classification: payments.finance_exclusion = 'deleted_cancelled_booking'
-- Capture class (none|partial|full) lives in payments.metadata.payment_capture_class.

BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS finance_exclusion text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'payments_finance_exclusion_check'
  ) THEN
    ALTER TABLE payments
      ADD CONSTRAINT payments_finance_exclusion_check
      CHECK (
        finance_exclusion IS NULL
        OR finance_exclusion = 'deleted_cancelled_booking'
      );
  END IF;
END $$;

COMMENT ON COLUMN payments.finance_exclusion IS
  'When set, exclude from active Finance collected/outstanding/revenue. deleted_cancelled_booking = schedule booking was cancelled then deleted/archived; refund assumed manual/external. Never stores fabricated Stripe refund IDs.';

CREATE INDEX IF NOT EXISTS payments_finance_exclusion_client_idx
  ON payments (client_id)
  WHERE finance_exclusion IS NOT NULL;

COMMIT;
