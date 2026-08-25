-- Explicit down for 095_tenant_email_luna_automation_claim_scoped.
-- Drops only the scoped next-claim function. Does not restore or rewrite
-- 088 tenant_email_luna_automation_claim(uuid, uuid). Does not GRANT or
-- CREATE ROLE. Refuses if the 086 queue table is absent. Second execution
-- is safe (DROP FUNCTION IF EXISTS).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.tenant_email_luna_automation_queue') IS NULL THEN
    RAISE EXCEPTION '095_down_refused: 086 queue table missing' USING ERRCODE = '23514';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.tenant_email_luna_automation_claim_scoped(uuid, uuid, uuid, text, uuid);

COMMIT;
