-- Explicit down for 061: remove new FK, owner-endpoint index, and endpoint_id only.
-- Does not drop tenant_email_oauth_transactions or 060 parent uniqueness constraints.

BEGIN;

DROP INDEX IF EXISTS tenant_email_oauth_transactions_owner_endpoint_idx;

ALTER TABLE tenant_email_oauth_transactions
  DROP CONSTRAINT IF EXISTS tenant_email_oauth_transactions_endpoint_fk;

ALTER TABLE tenant_email_oauth_transactions
  DROP COLUMN IF EXISTS endpoint_id;

COMMIT;
