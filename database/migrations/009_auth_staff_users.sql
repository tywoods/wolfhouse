-- Stage 7.2b — Staff auth schema: per-user staff accounts + sessions
-- Creates tables for production authentication:
--   staff_users    — one row per staff member per client (email/password, role, status)
--   auth_sessions  — one row per active browser session (opaque token hash, expiry)
--
-- Design principles:
--   * Follows migration 007/008 conventions exactly:
--       BEGIN/COMMIT, CREATE TABLE IF NOT EXISTS, UUID PKs via gen_random_uuid(),
--       client_id FK → clients(id), CHECK constraints (no enums — easy to extend),
--       JSONB metadata column, set_updated_at() trigger, named indexes.
--   * IDEMPOTENT — safe to re-run against a DB that already has these tables.
--   * No seed users, no passwords, no secrets.
--   * Local/dev only in 7.2b. Staging/prod auth wiring is done in 7.2c+.
--
-- Deferred (documented here, not implemented):
--   * staff_user_client_access — multi-client access join table. Deferred because
--     the pilot has a fixed small user set per single client. Will be added when
--     multi-client admin (Pillar 14) is implemented.
--   * Partial index "active sessions WHERE revoked_at IS NULL AND expires_at > NOW()"
--     — Postgres requires immutable expressions in partial index predicates; NOW()
--     is stable/volatile, not immutable, so it cannot appear there. Instead we index
--     revoked_at and expires_at separately; the application/query layer supplies the
--     time filter.
--
-- Related design:  docs/PHASE-7.2-AUTH-STAFF-ACCOUNTS-PLAN.md
-- Related plan:    docs/PHASE-7-PRODUCTION-HARDENING-PILOT-PLAN.md (Workstream B)

BEGIN;

-- ---------------------------------------------------------------------------
-- staff_users
-- ---------------------------------------------------------------------------
-- One row per staff member per client. Login identifier is email (lower-cased).
-- Roles are single-column for the pilot (viewer < operator < admin).
-- Multi-role per user is handled by treating admin as a superset of operator
-- (hierarchy enforced in middleware, not in this table).
-- Promote to a role join table only if multi-role independent of hierarchy is needed.

CREATE TABLE IF NOT EXISTS staff_users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,
  display_name      TEXT,
  role              TEXT NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('viewer', 'operator', 'admin', 'owner')),
  -- password_hash stores a bcrypt/argon2 hash; NULL until the auth flow sets it.
  -- auth middleware will reject login for any account where password_hash IS NULL.
  password_hash     TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'invited', 'disabled')),
  last_login_at     TIMESTAMPTZ,
  disabled_at       TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Unique email per client, case-insensitive.
-- lower() is immutable in Postgres, so a functional unique index is safe here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_users_client_email
  ON staff_users (client_id, lower(email));

CREATE INDEX IF NOT EXISTS idx_staff_users_client
  ON staff_users (client_id);
CREATE INDEX IF NOT EXISTS idx_staff_users_email
  ON staff_users (lower(email));
CREATE INDEX IF NOT EXISTS idx_staff_users_role
  ON staff_users (client_id, role);
CREATE INDEX IF NOT EXISTS idx_staff_users_status
  ON staff_users (client_id, status);
-- Fast lookup for active accounts only.
CREATE INDEX IF NOT EXISTS idx_staff_users_active
  ON staff_users (client_id, role)
  WHERE status = 'active';

CREATE TRIGGER staff_users_updated_at
  BEFORE UPDATE ON staff_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- auth_sessions
-- ---------------------------------------------------------------------------
-- One row per authenticated browser session. The actual session cookie value
-- is NEVER stored; only an opaque hash (SHA-256 or similar) is recorded here
-- so that a stolen DB row cannot be used to replay sessions.
--
-- Active session query: WHERE revoked_at IS NULL AND expires_at > NOW()
-- (the NOW() filter is applied at query time, not in a partial index — see note
-- at the top of this file about Postgres immutability restrictions).

CREATE TABLE IF NOT EXISTS auth_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_user_id       UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  client_id           UUID NOT NULL REFERENCES clients(id),
  -- Hashed session token only — raw token is never persisted.
  session_token_hash  TEXT NOT NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  last_seen_at        TIMESTAMPTZ,
  -- Optional forensic metadata (hashed to avoid PII).
  ip_hash             TEXT,
  user_agent_hash     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_auth_sessions_token_hash
  ON auth_sessions (session_token_hash);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_staff_user
  ON auth_sessions (staff_user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_client
  ON auth_sessions (client_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at
  ON auth_sessions (expires_at);
-- Index on revoked_at to efficiently find unrevoked sessions (IS NULL check).
CREATE INDEX IF NOT EXISTS idx_auth_sessions_revoked_at
  ON auth_sessions (revoked_at)
  WHERE revoked_at IS NULL;
-- Composite index for the common active-session lookup by user.
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_active
  ON auth_sessions (staff_user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TRIGGER auth_sessions_updated_at
  BEFORE UPDATE ON auth_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
