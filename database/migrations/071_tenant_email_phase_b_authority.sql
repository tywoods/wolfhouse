-- 071: Phase B authority columns (oauth intent/scope/prior + grant scope_version).
-- Safe backfill for deployed rows; Phase A DEFAULTs preserve insert paths.
BEGIN;
ALTER TABLE tenant_email_oauth_transactions
  ADD COLUMN authorization_intent TEXT NULL,
  ADD COLUMN scope_version TEXT NULL,
  ADD COLUMN prior_grant_generation BIGINT NULL;
UPDATE tenant_email_oauth_transactions
   SET authorization_intent = 'initial_connect',
       scope_version = 'phase_a_v2',
       prior_grant_generation = NULL
 WHERE authorization_intent IS NULL OR scope_version IS NULL;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM tenant_email_oauth_transactions
     WHERE authorization_intent IS NULL OR scope_version IS NULL
  ) THEN
    RAISE EXCEPTION '071_up_refused: oauth transaction intent/version backfill incomplete'
      USING ERRCODE = '23514';
  END IF;
END $$;
ALTER TABLE tenant_email_oauth_transactions
  ADD CONSTRAINT tenant_email_oauth_transactions_intent_values
    CHECK (authorization_intent IN ('initial_connect', 'phase_b_reauthorization')),
  ADD CONSTRAINT tenant_email_oauth_transactions_scope_version_values
    CHECK (scope_version IN ('phase_a_v2', 'phase_b_v1')),
  ADD CONSTRAINT tenant_email_oauth_transactions_intent_scope_coupling CHECK (
    (authorization_intent = 'initial_connect' AND scope_version = 'phase_a_v2'
      AND prior_grant_generation IS NULL)
    OR (authorization_intent = 'phase_b_reauthorization' AND scope_version = 'phase_b_v1'
      AND prior_grant_generation IS NOT NULL AND prior_grant_generation >= 1)
  );
ALTER TABLE tenant_email_oauth_transactions
  ALTER COLUMN authorization_intent SET DEFAULT 'initial_connect',
  ALTER COLUMN authorization_intent SET NOT NULL,
  ALTER COLUMN scope_version SET DEFAULT 'phase_a_v2',
  ALTER COLUMN scope_version SET NOT NULL;
COMMENT ON COLUMN tenant_email_oauth_transactions.authorization_intent IS
  'Server-owned start intent: initial_connect or phase_b_reauthorization.';
COMMENT ON COLUMN tenant_email_oauth_transactions.scope_version IS
  'Scope plan version at start: phase_a_v2 or phase_b_v1.';
COMMENT ON COLUMN tenant_email_oauth_transactions.prior_grant_generation IS
  'Phase B reauth only: expected grant_generation; NULL for initial_connect.';
ALTER TABLE tenant_email_delegated_grants ADD COLUMN scope_version TEXT NULL;
UPDATE tenant_email_delegated_grants SET scope_version = 'phase_a_v2' WHERE scope_version IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_delegated_grants WHERE scope_version IS NULL) THEN
    RAISE EXCEPTION '071_up_refused: grant scope_version backfill incomplete'
      USING ERRCODE = '23514';
  END IF;
END $$;
ALTER TABLE tenant_email_delegated_grants
  ADD CONSTRAINT tenant_email_delegated_grants_scope_version_values
    CHECK (scope_version IN ('phase_a_v2', 'phase_b_v1'));
ALTER TABLE tenant_email_delegated_grants
  ALTER COLUMN scope_version SET DEFAULT 'phase_a_v2',
  ALTER COLUMN scope_version SET NOT NULL;
COMMENT ON COLUMN tenant_email_delegated_grants.scope_version IS
  'Sealed grant scope version: phase_a_v2 or phase_b_v1.';
COMMIT;
