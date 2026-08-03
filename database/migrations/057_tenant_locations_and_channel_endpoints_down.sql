-- Down for 057_tenant_locations_and_channel_endpoints.sql
-- Removes only Slice 1B registry tables. Safe on a fresh 057-applied DB and
-- on repeated / partially recovered rollback (DROP TABLE IF EXISTS is
-- idempotent; table drops cascade their own triggers and indexes).
-- Does NOT drop shared set_updated_at(), clients, staff_users, free-text
-- location columns, or migration 039 objects.
--
-- Order: endpoints first (child FK), then locations (parent).

BEGIN;

DROP TABLE IF EXISTS tenant_channel_endpoints;
DROP TABLE IF EXISTS tenant_locations;

COMMIT;
