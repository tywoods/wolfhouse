BEGIN;

-- Crow's Nest server-side login sessions. Run after the existing Crowsnest role
-- bootstrap; the runtime receives only SELECT/INSERT/DELETE on this table.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_comms_owner')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='crowsnest_api') THEN
    RAISE EXCEPTION 'Crowsnest role bootstrap prerequisite missing';
  END IF;
END $$;

SET LOCAL ROLE crowsnest_comms_owner;
CREATE SCHEMA IF NOT EXISTS crowsnest_auth AUTHORIZATION crowsnest_comms_owner;
CREATE TABLE IF NOT EXISTS crowsnest_auth.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  username text NOT NULL CHECK (length(username) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS crowsnest_auth_sessions_expiry_idx ON crowsnest_auth.sessions(expires_at);
REVOKE ALL ON SCHEMA crowsnest_auth FROM PUBLIC;
REVOKE ALL ON crowsnest_auth.sessions FROM PUBLIC;
GRANT USAGE ON SCHEMA crowsnest_auth TO crowsnest_api;
GRANT SELECT, INSERT, DELETE ON crowsnest_auth.sessions TO crowsnest_api;

COMMIT;
