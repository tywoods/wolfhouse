-- 100_tenant_email_reply_approvals_inbound_claim.sql
-- SAME-DESK-004: durable exactly-once claim for one reply approval per inbound.
--
-- Natural key is (client_id, conversation_id, source_inbound_event_id). Provider
-- and mailbox remain on the row as authority identity; the inbound event FK
-- already binds them. Concurrent auto-send workers claim by INSERT; losers
-- ON CONFLICT DO NOTHING / 23505 skip without a second provider send.
-- Does not rewrite 070 operation_id uniqueness or approve-send CAS.
--
-- Rollback: 100_tenant_email_reply_approvals_inbound_claim_down.sql

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tenant_email_reply_approvals
     GROUP BY client_id, conversation_id, source_inbound_event_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION '100: duplicate inbound approval identities exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tenant_email_reply_approvals_inbound_claim_uq
  ON tenant_email_reply_approvals (
    client_id,
    conversation_id,
    source_inbound_event_id
  );

COMMENT ON INDEX tenant_email_reply_approvals_inbound_claim_uq IS
  'SAME-DESK-004: at most one reply approval per (client_id, conversation_id, source_inbound_event_id). Concurrent auto-send workers claim by INSERT; losers skip without provider send.';

COMMIT;
