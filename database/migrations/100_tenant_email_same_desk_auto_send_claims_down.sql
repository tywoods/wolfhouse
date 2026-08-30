-- Explicit down for 100_tenant_email_same_desk_auto_send_claims.
-- Fail closed while claim rows exist. Empty or absent table: drop protect
-- trigger, table, and function. Trigger drops are guarded by table existence
-- so partial prior-head / absent-table cleanup is safe. Does not delete or
-- rewrite tenant_email_reply_approvals.

BEGIN;

-- Partial prior-head cleanup: withdrawn global unique on generic drafts.
DROP INDEX IF EXISTS tenant_email_reply_approvals_inbound_claim_uq;

DO $$
BEGIN
  IF to_regclass('public.tenant_email_same_desk_auto_send_claims') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.tenant_email_same_desk_auto_send_claims) THEN
      RAISE EXCEPTION '100_down_refused: same-desk auto-send claim rows present — refuse silent exactly-once evidence loss';
    END IF;
    EXECUTE 'DROP TRIGGER IF EXISTS tenant_email_same_desk_auto_send_claims_protect ON public.tenant_email_same_desk_auto_send_claims';
    EXECUTE 'DROP TRIGGER IF EXISTS tenant_email_same_desk_auto_send_claims_updated_at ON public.tenant_email_same_desk_auto_send_claims';
  END IF;
END $$;

DROP TABLE IF EXISTS public.tenant_email_same_desk_auto_send_claims;
DROP FUNCTION IF EXISTS public.tenant_email_same_desk_auto_send_claims_protect();

COMMIT;
