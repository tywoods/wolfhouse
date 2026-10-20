BEGIN;

-- Run scripts/bootstrap-crowsnest-comms-roles.sh first with the Azure admin DSN.
-- Runtime LOGIN membership is provisioned separately after this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_comms_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_api') THEN
    RAISE EXCEPTION 'role bootstrap prerequisite missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('crowsnest_comms_owner','crowsnest_api') AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'crowsnest role attributes are unsafe';
  END IF;
END $$;

SET LOCAL ROLE crowsnest_comms_owner;

CREATE SCHEMA IF NOT EXISTS crowsnest_comms AUTHORIZATION crowsnest_comms_owner;

CREATE TABLE IF NOT EXISTS crowsnest_comms.number_route_operations (
  operation_id uuid PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('flip_to_sunset','rollback_to_wolfhouse')),
  expected_revision text NOT NULL CHECK (expected_revision ~ '^[0-9a-fA-F]{64}$'),
  actor_account_id text NOT NULL CHECK (actor_account_id IN ('earthling','monshies')),
  actor_username text NOT NULL,
  -- Selected confirmation tuple, written only on insert. All null means unselected.
  -- Do not backfill or relabel existing rows; a missing tuple is not a wildcard.
  number_id text,
  phone_number_id text,
  number_e164 text,
  state text NOT NULL CHECK (state IN ('requested','succeeded','rejected','indeterminate')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- All null, or all three non-null and nonempty. <> alone is UNKNOWN for NULL,
  -- and a CHECK accepts UNKNOWN, so the complete branch must be explicitly NOT NULL.
  CONSTRAINT number_route_identity_complete CHECK (
    (number_id IS NULL AND phone_number_id IS NULL AND number_e164 IS NULL)
    OR (
      number_id IS NOT NULL AND number_id <> ''
      AND phone_number_id IS NOT NULL AND phone_number_id <> ''
      AND number_e164 IS NOT NULL AND number_e164 <> ''
    )
  )
);

-- Forward upgrade for a table created by an earlier revision of this file.
-- CREATE TABLE IF NOT EXISTS does not add columns or replace a constraint.
-- Existing rows stay all-null. Do not backfill an identity. A null tuple is
-- not a wildcard. A same-name weak check is replaced, not skipped: <> alone
-- is UNKNOWN for NULL, and a CHECK accepts UNKNOWN.
ALTER TABLE crowsnest_comms.number_route_operations
  ADD COLUMN IF NOT EXISTS number_id text,
  ADD COLUMN IF NOT EXISTS phone_number_id text,
  ADD COLUMN IF NOT EXISTS number_e164 text;

ALTER TABLE crowsnest_comms.number_route_operations
  DROP CONSTRAINT IF EXISTS number_route_identity_complete;

ALTER TABLE crowsnest_comms.number_route_operations
  ADD CONSTRAINT number_route_identity_complete CHECK (
    (number_id IS NULL AND phone_number_id IS NULL AND number_e164 IS NULL)
    OR (
      number_id IS NOT NULL AND number_id <> ''
      AND phone_number_id IS NOT NULL AND phone_number_id <> ''
      AND number_e164 IS NOT NULL AND number_e164 <> ''
    )
  );

CREATE TABLE IF NOT EXISTS crowsnest_comms.number_route_events (
  event_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES crowsnest_comms.number_route_operations(operation_id),
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  event_type text NOT NULL CHECK (event_type IN ('requested','precondition','applied','readback','rollback')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_account_id text NOT NULL CHECK (actor_account_id IN ('earthling','monshies')),
  actor_username text NOT NULL,
  action text NOT NULL CHECK (action IN ('flip_to_sunset','rollback_to_wolfhouse')),
  expected_revision text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (operation_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS number_route_events_operation_idx ON crowsnest_comms.number_route_events(operation_id, sequence_no);

CREATE OR REPLACE FUNCTION crowsnest_comms.reject_number_route_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'number_route_events is append-only'; END; $$;

DROP TRIGGER IF EXISTS number_route_events_append_only ON crowsnest_comms.number_route_events;
CREATE TRIGGER number_route_events_append_only BEFORE UPDATE OR DELETE ON crowsnest_comms.number_route_events
FOR EACH ROW EXECUTE FUNCTION crowsnest_comms.reject_number_route_event_mutation();

REVOKE ALL ON SCHEMA crowsnest_comms FROM PUBLIC;
REVOKE ALL ON crowsnest_comms.number_route_events, crowsnest_comms.number_route_operations FROM PUBLIC;
REVOKE ALL ON FUNCTION crowsnest_comms.reject_number_route_event_mutation() FROM PUBLIC;
GRANT USAGE ON SCHEMA crowsnest_comms TO crowsnest_api;
GRANT SELECT, INSERT ON crowsnest_comms.number_route_events TO crowsnest_api;
GRANT SELECT, INSERT, UPDATE (state, response, updated_at) ON crowsnest_comms.number_route_operations TO crowsnest_api;
COMMIT;
