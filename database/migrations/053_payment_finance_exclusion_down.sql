-- Down for 053_payment_finance_exclusion.sql

BEGIN;

DROP INDEX IF EXISTS payments_finance_exclusion_client_idx;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_finance_exclusion_check;

ALTER TABLE payments DROP COLUMN IF EXISTS finance_exclusion;

COMMIT;
