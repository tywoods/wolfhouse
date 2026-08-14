BEGIN;
DROP TABLE IF EXISTS tenant_email_delta_activation_boundaries;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_inbound_delta_states) THEN
    RAISE EXCEPTION '080 down refuses existing delta state';
  END IF;
END $$;
ALTER TABLE tenant_email_inbound_delta_states
  DROP CONSTRAINT tenant_email_inbound_delta_states_query_version_exact;
ALTER TABLE tenant_email_inbound_delta_states
  ADD CONSTRAINT tenant_email_inbound_delta_states_query_version_exact
  CHECK (query_version = 'ms_messages_delta_v1');
COMMENT ON COLUMN tenant_email_inbound_delta_states.query_version IS
  'Production-exact text identifier of the messages-delta query contract: ms_messages_delta_v1 only.';
COMMIT;
