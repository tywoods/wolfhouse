-- Stage 8.8.19 — Service/add-on payment linkage (schema spec)
--
-- Purpose:
--   Link booking_service_records to payments rows so Stripe webhook / payment truth
--   can mark the correct service rows paid (Stage 8.8.18 rules).
--
-- Assumption (detected from 004_payment_schema_phase2.sql):
--   payments.payment_kind is PostgreSQL ENUM type `payment_kind` with values
--   deposit_only | full_amount. This migration adds addon_service via ALTER TYPE.
--
-- NOT YET APPLIED — spec only (Stage 8.8.19). Do not run without explicit approval.

BEGIN;

-- ---------------------------------------------------------------------------
-- booking_service_records.payment_id → payments(id)
-- ---------------------------------------------------------------------------

ALTER TABLE booking_service_records
  ADD COLUMN IF NOT EXISTS payment_id UUID REFERENCES payments(id) ON DELETE SET NULL;

COMMENT ON COLUMN booking_service_records.payment_id IS
  'Links service rows to the payment row that pays for those add-ons/services. '
  'Stripe webhook / payment truth may mark service rows paid only when linked via '
  'payment_id or explicit service_record_ids metadata on the payment (Stage 8.8.18).';

CREATE INDEX IF NOT EXISTS idx_booking_service_records_payment_id
  ON booking_service_records (payment_id)
  WHERE payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- payment_kind: add addon_service for separate add-on Checkout sessions
-- ---------------------------------------------------------------------------
-- Pattern matches 004_payment_schema_phase2.sql (ENUM, not CHECK constraint).
-- Safe in PostgreSQL 12+: ADD VALUE IF NOT EXISTS is idempotent.

ALTER TYPE payment_kind ADD VALUE IF NOT EXISTS 'addon_service';

COMMENT ON COLUMN payments.payment_kind IS
  'deposit_only (package deposit), full_amount (package full pay), or addon_service (separate add-on Checkout; Stage 8.8.18+)';

COMMIT;
