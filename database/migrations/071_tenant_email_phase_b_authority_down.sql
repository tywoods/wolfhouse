-- Down 071: fail closed on Phase B facts; Phase-A-only may drop columns.
BEGIN;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_email_oauth_transactions'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_oauth_transactions
     WHERE authorization_intent IS DISTINCT FROM 'initial_connect'
        OR scope_version IS DISTINCT FROM 'phase_a_v2'
        OR prior_grant_generation IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      '071_down_refused: Phase B oauth transaction facts or unsafe intent/scope state present'
      USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = 'tenant_email_delegated_grants'
  ) AND EXISTS (
    SELECT 1 FROM tenant_email_delegated_grants
     WHERE scope_version IS DISTINCT FROM 'phase_a_v2'
  ) THEN
    RAISE EXCEPTION
      '071_down_refused: Phase B grant facts or non-phase_a_v2 scope present'
      USING ERRCODE = 'P0001';
  END IF;
END $$;
ALTER TABLE tenant_email_oauth_transactions
  DROP CONSTRAINT IF EXISTS tenant_email_oauth_transactions_intent_scope_coupling,
  DROP CONSTRAINT IF EXISTS tenant_email_oauth_transactions_scope_version_values,
  DROP CONSTRAINT IF EXISTS tenant_email_oauth_transactions_intent_values;
ALTER TABLE tenant_email_oauth_transactions
  DROP COLUMN IF EXISTS prior_grant_generation,
  DROP COLUMN IF EXISTS scope_version,
  DROP COLUMN IF EXISTS authorization_intent;
ALTER TABLE tenant_email_delegated_grants
  DROP CONSTRAINT IF EXISTS tenant_email_delegated_grants_scope_version_values;
ALTER TABLE tenant_email_delegated_grants DROP COLUMN IF EXISTS scope_version;
COMMIT;
