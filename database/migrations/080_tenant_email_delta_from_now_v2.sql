-- EMAIL-M1-020: activate a truthful, bounded from-now Graph delta contract.
-- Existing v1 state/cursors cannot be relabelled: cursor AAD and query semantics differ.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_inbound_delta_states) THEN
    RAISE EXCEPTION '080 refuses existing delta state; operator reset is required';
  END IF;
END $$;
ALTER TABLE tenant_email_inbound_delta_states
  DROP CONSTRAINT tenant_email_inbound_delta_states_query_version_exact;
ALTER TABLE tenant_email_inbound_delta_states
  ADD CONSTRAINT tenant_email_inbound_delta_states_query_version_exact
  CHECK (query_version = 'ms_messages_delta_from_now_v2');
COMMENT ON COLUMN tenant_email_inbound_delta_states.query_version IS
  'Exact Graph messages delta contract ms_messages_delta_from_now_v2: initial request is activation-watermark filtered; continuation preserves provider-issued query state.';
CREATE TABLE tenant_email_delta_activation_boundaries (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES tenant_channel_endpoints(id) ON DELETE CASCADE,
  activation_watermark TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, endpoint_id)
);
COMMENT ON TABLE tenant_email_delta_activation_boundaries IS
  'Durable DB-clock from-now boundary initialized before Graph; no cursor or message data.';
COMMIT;
