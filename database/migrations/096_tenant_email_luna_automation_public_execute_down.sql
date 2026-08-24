-- Explicit down for 096_tenant_email_luna_automation_public_execute.
-- Intentionally irreversible: exact pre-096 function ACLs and applying-owner
-- default ACLs were not captured. Broad rollback would be unsafe — it would
-- widen functions that were already private before 096, functions created
-- after 096, and future omitted security functions.
-- This paired down exists for canonical manifest conventions. It performs
-- no GRANT, REVOKE, ALTER DEFAULT PRIVILEGES, or other ACL mutation.
-- Always refuses atomically with a stable error. Repeat execution is the
-- same refusal and leaves post-096 ACLs unchanged.

BEGIN;

DO $$
BEGIN
  RAISE EXCEPTION '096_down_refused: exact pre-096 ACL/default-ACL state was not captured; broad rollback would be unsafe'
    USING ERRCODE = '0A000';
END $$;

COMMIT;
