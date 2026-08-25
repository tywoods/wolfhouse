-- Explicit down for 085_tenant_email_luna_policy_audit.
-- Fail closed when audit rows exist (refuse silent policy-evidence loss).
-- Does not drop parent uniques owned by 067/068.

BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'tenant_email_luna_policy_audit'
  ) AND EXISTS (SELECT 1 FROM tenant_email_luna_policy_audit) THEN
    RAISE EXCEPTION '085_down_refused: luna policy audit rows present — refuse silent evidence loss';
  END IF;
END $$;
DROP TRIGGER IF EXISTS tenant_email_luna_policy_audit_protect_update ON tenant_email_luna_policy_audit;
DROP TRIGGER IF EXISTS tenant_email_luna_policy_audit_protect_delete ON tenant_email_luna_policy_audit;
DROP TABLE IF EXISTS tenant_email_luna_policy_audit;
DROP FUNCTION IF EXISTS tenant_email_luna_policy_audit_protect();
COMMIT;
