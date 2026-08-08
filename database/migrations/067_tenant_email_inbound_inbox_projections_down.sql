-- Explicit down/rollback for 067_tenant_email_inbound_inbox_projections.
-- Fail closed when any projection journal rows exist — never silently drop
-- exactly-once evidence while leaving projected conversations/messages intact
-- (which would allow duplicate Inbox messages on re-apply + replay).
--
-- When the journal is empty: drop the table and the supporting parent uniques
-- introduced by 067. The email-namespace skip inside sync_customer_from_touch
-- remains as durable phone-namespace safety (compatible no-op for telephone
-- customers; never reintroduces email→customers.phone pollution).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_email_inbound_inbox_projections'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_inbound_inbox_projections
  ) THEN
    RAISE EXCEPTION
      '067_down_refused: projection rows present — refuse silent exactly-once evidence loss';
  END IF;
END $$;

DROP TABLE IF EXISTS tenant_email_inbound_inbox_projections;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_client_id_conversation_id_id_uq;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_client_id_id_uq;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_client_id_id_uq;

ALTER TABLE tenant_email_inbound_events
  DROP CONSTRAINT IF EXISTS tenant_email_inbound_events_client_id_id_uq;

COMMIT;
