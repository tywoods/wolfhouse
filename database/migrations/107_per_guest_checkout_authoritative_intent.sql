-- One collectible per-guest checkout intent.  Deposit and remaining-share
-- products overlap, so target/amount are deliberately not part of identity.
DO $$
DECLARE conflict_groups integer; conflict_rows integer;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(n),0)::integer INTO conflict_groups, conflict_rows
  FROM (SELECT client_id,booking_id,booking_guest_id,COUNT(*)::integer n FROM payments
    WHERE metadata->>'source'='bot_guest_payment_link_slice_a' AND booking_guest_id IS NOT NULL
      AND status IN ('draft'::payment_record_status,'checkout_created'::payment_record_status)
    GROUP BY client_id,booking_id,booking_guest_id HAVING COUNT(*)>1) conflicts;
  IF conflict_groups>0 THEN
    RAISE EXCEPTION 'migration_107_preflight_failed: % per-guest checkout conflict group(s), % active row(s)', conflict_groups, conflict_rows;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS payments_per_guest_checkout_intent_unique
  ON payments (client_id,booking_id,booking_guest_id)
  WHERE metadata->>'source'='bot_guest_payment_link_slice_a'
    AND booking_guest_id IS NOT NULL
    AND status IN ('draft'::payment_record_status,'checkout_created'::payment_record_status);

COMMENT ON INDEX payments_per_guest_checkout_intent_unique IS
  'Exactly one active collectible checkout intent per tenant, booking and guest.';
