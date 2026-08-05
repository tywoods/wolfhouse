BEGIN;
DROP TABLE IF EXISTS tenant_email_oauth_transactions;
ALTER TABLE tenant_locations DROP CONSTRAINT IF EXISTS tenant_locations_client_id_id_uq;
ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_client_id_id_staff_user_id_uq;
ALTER TABLE staff_users DROP CONSTRAINT IF EXISTS staff_users_client_id_id_uq;
COMMIT;
