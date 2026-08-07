-- Explicit down/rollback for 064_tenant_email_inbound_delta_states.
-- Drops the empty-or-populated delta state table + indexes only.
-- Leaves 057–063 registry / grants / oauth / inbound events intact.

BEGIN;

DROP TABLE IF EXISTS tenant_email_inbound_delta_states;

COMMIT;
