-- Phase 2b fix: allow multiple NULL stripe_payment_intent_id (checkout before PI exists).
-- UNIQUE only when intent id is present.

BEGIN;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_stripe_payment_intent_id_key;

DROP INDEX IF EXISTS payments_stripe_payment_intent_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_payment_intent_id_unique
  ON payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

COMMENT ON INDEX payments_stripe_payment_intent_id_unique IS
  'Stripe PI id unique when set; multiple rows may have NULL until checkout completes';

COMMIT;
