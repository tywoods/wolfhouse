-- 061_tenant_email_oauth_transaction_endpoint_binding.sql
-- Stage 6 prerequisite: bind each Microsoft OAuth transaction to the exact
-- tenant email endpoint selected at start so later callback custody cannot
-- choose or derive an endpoint.
--
-- Fail-closed: OAuth is still disabled and legacy rows must not exist. If any
-- preexisting tenant_email_oauth_transactions rows are present, refuse to add
-- NOT NULL endpoint_id — never guess, backfill, or delete.
--
-- Down: 061_tenant_email_oauth_transaction_endpoint_binding_down.sql
-- (drops new FK / owner-endpoint index / column only).

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_oauth_transactions) THEN
    RAISE EXCEPTION
      '061_tenant_email_oauth_transaction_endpoint_binding: preexisting tenant_email_oauth_transactions rows prevent safe NOT NULL endpoint_id; refuse backfill/delete/guess'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

ALTER TABLE tenant_email_oauth_transactions
  ADD COLUMN endpoint_id UUID NOT NULL;

ALTER TABLE tenant_email_oauth_transactions
  ADD CONSTRAINT tenant_email_oauth_transactions_endpoint_fk
    FOREIGN KEY (client_id, endpoint_id)
    REFERENCES tenant_channel_endpoints (client_id, id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;

COMMENT ON COLUMN tenant_email_oauth_transactions.endpoint_id IS
  'Exact tenant_channel_endpoints row selected at OAuth start. Callback custody must use this bound endpoint_id; never re-derive from address, location, or caller hint.';

-- Owner lookup including the bound endpoint (additive; 060 owner_idx retained).
CREATE INDEX tenant_email_oauth_transactions_owner_endpoint_idx
  ON tenant_email_oauth_transactions (client_id, auth_session_id, location_id, endpoint_id);

COMMIT;
