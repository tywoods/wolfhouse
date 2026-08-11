-- 072_messages_staff_email_reply_approval_uq.sql
-- Atomic idempotency for staff email outbound thread mirrors after Graph commit.
--
-- One durable messages bubble per (client_id, conversation_id, approval_id) for
-- staff_email_reply outbound email rows. Concurrent/retried approve-send mirrors
-- converge: INSERT ... ON CONFLICT DO NOTHING; only the inserting invocation
-- may touch conversations.last_message_preview / last_staff_reply_at.
--
-- Partial index only — WhatsApp and other message rows are unconstrained.
-- approval_id lives in metadata (no schema column). Empty on migrate (no backfill).
-- Rollback: 072_messages_staff_email_reply_approval_uq_down.sql

BEGIN;

CREATE UNIQUE INDEX messages_staff_email_reply_approval_uq
  ON messages (
    client_id,
    conversation_id,
    (metadata->>'approval_id')
  )
  WHERE direction = 'outbound'
    AND source = 'staff_email_reply'
    AND route = 'email'
    AND (metadata->>'approval_id') IS NOT NULL
    AND (metadata->>'approval_id') <> '';

COMMENT ON INDEX messages_staff_email_reply_approval_uq IS
  'At most one staff email outbound mirror bubble per (client_id, conversation_id, approval_id). Partial: outbound + source=staff_email_reply + route=email only. Concurrent insert race → one row; losers ON CONFLICT DO NOTHING.';

COMMIT;
