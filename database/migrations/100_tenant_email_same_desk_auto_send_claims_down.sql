-- Explicit down for 100_tenant_email_same_desk_auto_send_claims.
-- Fail closed while claim rows exist. Empty table: drop protect trigger,
-- table, and function. Does not delete or rewrite tenant_email_reply_approvals.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_email_same_desk_auto_send_claims'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_same_desk_auto_send_claims
  ) THEN
    RAISE EXCEPTION '100_down_refused: same-desk auto-send claim rows present — refuse silent exactly-once evidence loss';
  END IF;
END $$;

DROP INDEX IF EXISTS tenant_email_reply_approvals_inbound_claim_uq;
DROP TRIGGER IF EXISTS tenant_email_same_desk_auto_send_claims_protect ON tenant_email_same_desk_auto_send_claims;
DROP TRIGGER IF EXISTS tenant_email_same_desk_auto_send_claims_updated_at ON tenant_email_same_desk_auto_send_claims;
DROP TABLE IF EXISTS tenant_email_same_desk_auto_send_claims;
DROP FUNCTION IF EXISTS tenant_email_same_desk_auto_send_claims_protect();

COMMIT;
