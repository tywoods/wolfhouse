-- Down for 075: refuse destructive rollback while Google OAuth transactions exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tenant_email_google_oauth_transactions) THEN
    RAISE EXCEPTION '075 rollback refused: tenant_email_google_oauth_transactions is nonempty'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

BEGIN;
DROP TABLE tenant_email_google_oauth_transactions;
DROP FUNCTION tenant_email_google_oauth_transactions_require_endpoint();
COMMIT;
