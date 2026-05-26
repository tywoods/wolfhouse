-- Phase 2a: Payment enums and columns for Stripe (deposit_only first; full_amount reserved)
-- Does not create Stripe workflows. Preserves booking rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- booking payment_status: add values used by Stripe + WhatsApp flow
-- ---------------------------------------------------------------------------

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'payment_link_sent' AFTER 'waiting_payment';
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'expired' AFTER 'failed';

-- ---------------------------------------------------------------------------
-- payment_kind: deposit_only | full_amount (replace legacy deposit/balance/full/custom)
-- ---------------------------------------------------------------------------

CREATE TYPE payment_kind_v2 AS ENUM ('deposit_only', 'full_amount');

ALTER TABLE payments
  ALTER COLUMN kind DROP DEFAULT;

ALTER TABLE payments
  ALTER COLUMN kind TYPE payment_kind_v2
  USING (
    CASE kind::text
      WHEN 'full' THEN 'full_amount'::payment_kind_v2
      WHEN 'balance' THEN 'deposit_only'::payment_kind_v2
      WHEN 'custom' THEN 'deposit_only'::payment_kind_v2
      ELSE 'deposit_only'::payment_kind_v2
    END
  );

DROP TYPE payment_kind;
ALTER TYPE payment_kind_v2 RENAME TO payment_kind;

ALTER TABLE payments
  ALTER COLUMN kind SET DEFAULT 'deposit_only';

-- Rename kind → payment_kind (clearer API)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'kind'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'payment_kind'
  ) THEN
    ALTER TABLE payments RENAME COLUMN kind TO payment_kind;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- payments: amount_due_cents, amount_paid_cents
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'amount_cents'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'payments' AND column_name = 'amount_due_cents'
  ) THEN
    ALTER TABLE payments RENAME COLUMN amount_cents TO amount_due_cents;
  END IF;
END $$;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS amount_paid_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_amount_cents_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_due_cents_check
  CHECK (amount_due_cents >= 0);

ALTER TABLE payments
  ADD CONSTRAINT payments_amount_paid_cents_check
  CHECK (amount_paid_cents >= 0);

-- Default deposit for Phase 2 test (€200) — actual sessions set this explicitly
COMMENT ON COLUMN payments.payment_kind IS 'deposit_only (Phase 2 default) or full_amount (future)';
COMMENT ON COLUMN payments.amount_due_cents IS 'Amount requested in this Checkout session';
COMMENT ON COLUMN payments.amount_paid_cents IS 'Set by Stripe webhook only';

-- ---------------------------------------------------------------------------
-- bookings: ensure money columns exist (already in 001; document defaults)
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN bookings.total_amount_cents IS 'Full stay total (package proration); may be null until calculated';
COMMENT ON COLUMN bookings.deposit_required_cents IS 'Required deposit cents; NULL or 0 → Create Payment Session uses STRIPE_DEFAULT_DEPOSIT_CENTS (20000)';
COMMENT ON COLUMN bookings.deposit_paid_cents IS 'Updated by Stripe webhook when payment_kind=deposit_only succeeds';
COMMENT ON COLUMN bookings.amount_paid_cents IS 'Cumulative paid; webhook-only for Stripe';
COMMENT ON COLUMN bookings.balance_due_cents IS 'total - amount_paid (maintained by app logic)';

-- ---------------------------------------------------------------------------
-- Indexes for Stripe idempotency
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_payments_booking_kind_status
  ON payments (booking_id, payment_kind, status);

CREATE INDEX IF NOT EXISTS idx_payments_client_booking
  ON payments (client_id, booking_id);

COMMIT;
