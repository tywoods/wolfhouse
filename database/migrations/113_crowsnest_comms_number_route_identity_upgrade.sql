BEGIN;

-- Forward upgrade for crowsnest_comms.number_route_operations created before
-- the selected-identity columns existed. Migration 103's CREATE TABLE IF NOT
-- EXISTS does not alter an already-created table. Re-running the updated 103
-- performs this same upgrade; this file is the path when 103 will not be
-- executed again.
-- Historical rows stay all-null. Do not backfill an identity. A null tuple
-- is not a wildcard.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_comms_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_api') THEN
    RAISE EXCEPTION 'role bootstrap prerequisite missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('crowsnest_comms_owner','crowsnest_api') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'crowsnest role attributes are unsafe';
  END IF;
  IF to_regclass('crowsnest_comms.number_route_operations') IS NULL THEN
    RAISE EXCEPTION 'number_route_operations is missing; run migration 103 first';
  END IF;
END $$;

SET LOCAL ROLE crowsnest_comms_owner;

ALTER TABLE crowsnest_comms.number_route_operations
  ADD COLUMN IF NOT EXISTS number_id text,
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS number_e164 text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'number_route_identity_complete'
      AND conrelid = 'crowsnest_comms.number_route_operations'::regclass
  ) THEN
    ALTER TABLE crowsnest_comms.number_route_operations
      ADD CONSTRAINT number_route_identity_complete CHECK (
        (number_id IS NULL AND phone_number_id IS NULL AND number_e164 IS NULL)
        OR (number_id <> '' AND phone_number_id <> '' AND number_e164 <> '')
      );
  END IF;
END $$;

COMMIT;
