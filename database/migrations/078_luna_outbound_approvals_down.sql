-- Explicit down for 078. Refuse nonempty so pending WhatsApp drafts cannot
-- disappear silently. Do not run against a live DB from this PR.

BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'luna_outbound_approvals'
  ) AND EXISTS (SELECT 1 FROM luna_outbound_approvals) THEN
    RAISE EXCEPTION '078_down_refused: luna_outbound_approvals rows present — refuse silent draft evidence loss';
  END IF;
END $$;
DROP TRIGGER IF EXISTS luna_outbound_approvals_protect ON luna_outbound_approvals;
DROP TRIGGER IF EXISTS luna_outbound_approvals_updated_at ON luna_outbound_approvals;
DROP TABLE IF EXISTS luna_outbound_approvals;
DROP FUNCTION IF EXISTS luna_outbound_approvals_protect();
COMMIT;
