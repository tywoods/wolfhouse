-- Sunset payment-link authoritative intent guard (staging).
-- One active payable row per booking + payment kind + amount + currency for Sunset schedule links.
-- Idempotent: safe to rerun. Preflight fails loudly when conflicting active rows already exist.

DO $$
DECLARE
  conflict_groups INTEGER;
  conflict_rows INTEGER;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(cnt), 0)::INTEGER
    INTO conflict_groups, conflict_rows
    FROM (
      SELECT booking_id, payment_kind, amount_due_cents, currency, COUNT(*)::INTEGER AS cnt
        FROM payments
       WHERE metadata->>'source' = 'sunset_schedule_stripe_link'
         AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)
       GROUP BY booking_id, payment_kind, amount_due_cents, currency
      HAVING COUNT(*) > 1
    ) dupes;

  IF conflict_groups > 0 THEN
    RAISE EXCEPTION
      'migration_038_preflight_failed: % authoritative-intent conflict group(s) spanning % active Sunset payment row(s). Resolve duplicates before applying index.',
      conflict_groups, conflict_rows;
  END IF;
END $$;

DROP INDEX IF EXISTS payments_sunset_booking_idempotency_unique;

CREATE UNIQUE INDEX IF NOT EXISTS payments_sunset_authoritative_intent_unique
  ON payments (booking_id, payment_kind, amount_due_cents, currency)
  WHERE metadata->>'source' = 'sunset_schedule_stripe_link'
    AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status);

COMMENT ON INDEX payments_sunset_authoritative_intent_unique IS
  'One active Sunset payment-link row per authoritative intent (booking, kind, amount, currency). Request keys are observability-only.';
