-- Durable authoritative identity for per-guest Stripe Checkout creation.
-- Request tokens are deliberately not identity: retries converge on one active row.
DO $$
DECLARE
  conflict_groups integer;
  conflict_rows integer;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(n), 0)::integer
    INTO conflict_groups, conflict_rows
    FROM (
      SELECT client_id, booking_id, booking_guest_id,
             metadata->>'payment_target' AS payment_target,
             amount_due_cents, currency, COUNT(*)::integer AS n
        FROM payments
       WHERE metadata->>'source' = 'bot_guest_payment_link_slice_a'
         AND booking_guest_id IS NOT NULL
         AND metadata->>'payment_target' IN ('deposit', 'remaining_share', 'full_share')
         AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status)
       GROUP BY client_id, booking_id, booking_guest_id,
                metadata->>'payment_target', amount_due_cents, currency
      HAVING COUNT(*) > 1
    ) conflicts;
  IF conflict_groups > 0 THEN
    RAISE EXCEPTION
      'migration_107_preflight_failed: % per-guest checkout identity conflict group(s), % active row(s)',
      conflict_groups, conflict_rows;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payments_per_guest_checkout_intent_unique
  ON payments (
    client_id, booking_id, booking_guest_id,
    (metadata->>'payment_target'), amount_due_cents, currency
  )
  WHERE metadata->>'source' = 'bot_guest_payment_link_slice_a'
    AND booking_guest_id IS NOT NULL
    AND metadata->>'payment_target' IN ('deposit', 'remaining_share', 'full_share')
    AND status IN ('draft'::payment_record_status, 'checkout_created'::payment_record_status);

COMMENT ON INDEX payments_per_guest_checkout_intent_unique IS
  'One active per-guest checkout row per tenant, booking, guest, target, amount and currency.';
