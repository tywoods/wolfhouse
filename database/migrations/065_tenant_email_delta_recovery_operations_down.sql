-- Explicit down/rollback for 065_tenant_email_delta_recovery_operations.
-- Drops the empty-or-populated recovery journal table + indexes only.
-- Leaves 057–064 registry / grants / oauth / events / delta states / staff_users intact.

BEGIN;

DROP TABLE IF EXISTS tenant_email_delta_recovery_operations;

COMMIT;
