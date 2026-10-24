-- 122_luna_v3_group_payment_targets.sql
-- Add explicit payment scope while preserving every historical personal receipt.
BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.luna_v3_payment_links') IS NULL THEN
    RAISE EXCEPTION '122_refused: luna_v3_payment_links missing';
  END IF;
  IF obj_description('public.luna_v3_payment_links'::regclass,'pg_class')
       IS DISTINCT FROM '115_luna_v3_guest_operations v1' THEN
    RAISE EXCEPTION '122_refused: payment links table is foreign/newer';
  END IF;
END $preflight$;

ALTER TABLE luna_v3_payment_links
  ADD COLUMN IF NOT EXISTS payment_scope text DEFAULT 'individual';
UPDATE luna_v3_payment_links SET payment_scope='individual' WHERE payment_scope IS NULL;
ALTER TABLE luna_v3_payment_links ALTER COLUMN payment_scope SET DEFAULT 'individual';
ALTER TABLE luna_v3_payment_links ALTER COLUMN payment_scope SET NOT NULL;
ALTER TABLE luna_v3_payment_links ALTER COLUMN booking_guest_id DROP NOT NULL;

ALTER TABLE luna_v3_payment_links
  DROP CONSTRAINT IF EXISTS luna_v3_payment_links_guest_payment_history_fk;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.luna_v3_payment_links'::regclass AND conname='luna_v3_payment_links_scope_ck_122') THEN
    ALTER TABLE luna_v3_payment_links ADD CONSTRAINT luna_v3_payment_links_scope_ck_122 CHECK (
      (payment_scope='individual' AND booking_guest_id IS NOT NULL)
      OR (payment_scope='booking' AND booking_guest_id IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.luna_v3_payment_links'::regclass AND conname='luna_v3_payment_links_individual_history_fk_122') THEN
    ALTER TABLE luna_v3_payment_links ADD CONSTRAINT luna_v3_payment_links_individual_history_fk_122
      FOREIGN KEY(client_id,booking_id,booking_guest_id,payment_id)
      REFERENCES luna_v3_guest_payments(client_id,booking_id,booking_guest_id,payment_id)
      ON DELETE RESTRICT;
  END IF;
END $constraints$;

COMMENT ON COLUMN luna_v3_payment_links.payment_scope IS '122_luna_v3_group_payment_targets v1';
COMMENT ON CONSTRAINT luna_v3_payment_links_scope_ck_122 ON luna_v3_payment_links IS '122_luna_v3_group_payment_targets v1';
COMMENT ON CONSTRAINT luna_v3_payment_links_individual_history_fk_122 ON luna_v3_payment_links IS '122_luna_v3_group_payment_targets v1';
COMMIT;
