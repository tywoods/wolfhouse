-- Explicit down/rollback for 063_tenant_email_inbound_events.
-- Drops the empty-or-populated event store table + indexes only.
-- Leaves 057–062 registry / grants / oauth tables intact.

BEGIN;

DROP TABLE IF EXISTS tenant_email_inbound_events;

COMMIT;
