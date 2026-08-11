-- Explicit down for 072_messages_staff_email_reply_approval_uq.
-- Drops the partial unique index only. Does not delete messages rows.

BEGIN;

DROP INDEX IF EXISTS messages_staff_email_reply_approval_uq;

COMMIT;
