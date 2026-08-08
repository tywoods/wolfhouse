-- Explicit down for 068_tenant_email_outbound_send_journal.
-- Fail closed when journal rows exist (refuse silent exactly-once evidence loss).
-- When empty: DROP TABLE + protect function + composite parent uniques owned here.
-- Does not drop conversations_client_id_id_uq (owned by 067 when present).
BEGIN;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'tenant_email_outbound_send_journal'
  ) AND EXISTS (SELECT 1 FROM tenant_email_outbound_send_journal) THEN
    RAISE EXCEPTION '068_down_refused: outbound send journal rows present — refuse silent exactly-once evidence loss';
  END IF;
END $$;
DROP TRIGGER IF EXISTS tenant_email_outbound_send_journal_protect ON tenant_email_outbound_send_journal;
DROP TRIGGER IF EXISTS tenant_email_outbound_send_journal_updated_at ON tenant_email_outbound_send_journal;
DROP TABLE IF EXISTS tenant_email_outbound_send_journal;
DROP FUNCTION IF EXISTS tenant_email_outbound_send_journal_protect();
ALTER TABLE tenant_channel_endpoints DROP CONSTRAINT IF EXISTS tenant_channel_endpoints_client_id_id_location_key_uq;
ALTER TABLE tenant_locations DROP CONSTRAINT IF EXISTS tenant_locations_client_id_id_location_key_uq;
COMMIT;
