-- Sunset Admin business config tables (prices, lesson capacity, lesson times, audit log).
--
-- NOT YET APPLIED — Captain approval required before running against any database.
-- Spec: docs/sunset/SUNSET-ADMIN-CONFIG-SPEC.md
--
-- Purpose:
--   Additive DDL for DB-backed Sunset Admin business config. Empty on apply;
--   runtime behavior unchanged until SUNSET_ADMIN_DB_READ_ENABLED is enabled.
--
-- Safety:
--   * CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS — idempotent re-run.
--   * No INSERT/UPDATE/DELETE data migration in this file.
--   * No RLS, no GRANT changes.
--   * Safe no-op on Wolfhouse-only databases (empty tables, no app reads yet).
--
-- Apply order: after 020_wolfhouse_room_gender_metadata.sql (see database/migrations/README.md).
--
-- Rollback (manual — do NOT auto-execute):
--   BEGIN;
--   DROP TABLE IF EXISTS tenant_config_audit_log;
--   DROP TABLE IF EXISTS tenant_lesson_time_rules;
--   DROP TABLE IF EXISTS tenant_lesson_capacity_rules;
--   DROP TABLE IF EXISTS tenant_price_rules;
--   COMMIT;
-- If audit log contains production edits, disable writes and retain tables instead of DROP.

BEGIN;

-- ---------------------------------------------------------------------------
-- tenant_price_rules
-- ---------------------------------------------------------------------------
-- Authoritative price rows for lessons, rentals, and packages.

CREATE TABLE IF NOT EXISTS tenant_price_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  client_slug     TEXT NOT NULL,
  item_type       TEXT NOT NULL
                  CHECK (item_type IN ('lesson', 'rental', 'package')),
  item_code       TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  amount_cents    INTEGER NOT NULL
                  CHECK (amount_cents >= 0),
  unit            TEXT NOT NULL
                  CHECK (unit IN ('person', 'day', 'session', 'item')),
  active          BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE,
  effective_to    DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_price_rules_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE tenant_price_rules IS
  'Sunset Admin price rules per tenant/client. Staff API filters on client_slug. '
  'Resolver reads when SUNSET_ADMIN_DB_READ_ENABLED=true; config file fallback until backfill.';

COMMENT ON COLUMN tenant_price_rules.tenant_id IS
  'Engine/deployment scope (Sunset: sunset).';

COMMENT ON COLUMN tenant_price_rules.client_slug IS
  'Staff portal session scope (Sunset: sunset). All queries must filter on this column.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_price_rules_active_window
  ON tenant_price_rules (client_slug, item_type, item_code, unit, COALESCE(effective_from, DATE '1970-01-01'))
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_tenant_price_rules_client_active
  ON tenant_price_rules (client_slug, active, item_type);

CREATE INDEX IF NOT EXISTS idx_tenant_price_rules_tenant_item
  ON tenant_price_rules (tenant_id, item_code);

CREATE INDEX IF NOT EXISTS idx_tenant_price_rules_client_effective
  ON tenant_price_rules (client_slug, active, effective_from, effective_to)
  WHERE active = true;

CREATE TRIGGER tenant_price_rules_updated_at
  BEFORE UPDATE ON tenant_price_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_lesson_capacity_rules
-- ---------------------------------------------------------------------------
-- Daily lesson seat caps: default, weekday, or date overrides.
-- Resolution order: date > weekday > default > fallback 24.

CREATE TABLE IF NOT EXISTS tenant_lesson_capacity_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  client_slug     TEXT NOT NULL,
  scope           TEXT NOT NULL
                  CHECK (scope IN ('default', 'weekday', 'date')),
  weekday         SMALLINT,
  service_date    DATE,
  capacity        INTEGER NOT NULL
                  CHECK (capacity >= 0 AND capacity <= 999),
  active          BOOLEAN NOT NULL DEFAULT true,
  effective_from  DATE,
  effective_to    DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_lesson_capacity_rules_scope_columns
    CHECK (
      (scope = 'default' AND weekday IS NULL AND service_date IS NULL)
      OR (scope = 'weekday' AND weekday BETWEEN 0 AND 6 AND service_date IS NULL)
      OR (scope = 'date' AND service_date IS NOT NULL AND weekday IS NULL)
    ),
  CONSTRAINT tenant_lesson_capacity_rules_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE tenant_lesson_capacity_rules IS
  'Sunset Admin lesson capacity rules. One active row per scope key per client_slug.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_default
  ON tenant_lesson_capacity_rules (client_slug)
  WHERE scope = 'default' AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_weekday
  ON tenant_lesson_capacity_rules (client_slug, weekday)
  WHERE scope = 'weekday' AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_capacity_date
  ON tenant_lesson_capacity_rules (client_slug, service_date)
  WHERE scope = 'date' AND active = true;

CREATE INDEX IF NOT EXISTS idx_tenant_lesson_capacity_client_scope
  ON tenant_lesson_capacity_rules (client_slug, scope, active);

CREATE INDEX IF NOT EXISTS idx_tenant_lesson_capacity_client_effective
  ON tenant_lesson_capacity_rules (client_slug, active, effective_from, effective_to)
  WHERE active = true;

CREATE TRIGGER tenant_lesson_capacity_rules_updated_at
  BEFORE UPDATE ON tenant_lesson_capacity_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_lesson_time_rules
-- ---------------------------------------------------------------------------
-- Recurring and date-specific lesson slot templates (local wall-clock times).

CREATE TABLE IF NOT EXISTS tenant_lesson_time_rules (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL,
  client_slug      TEXT NOT NULL,
  time_local       TIME NOT NULL,
  time_local_end   TIME,
  label            TEXT NOT NULL,
  lesson_type      TEXT NOT NULL,
  weekdays_active  SMALLINT[] NOT NULL DEFAULT '{}'::smallint[],
  service_date     DATE,
  active           BOOLEAN NOT NULL DEFAULT true,
  effective_from   DATE,
  effective_to     DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT tenant_lesson_time_rules_weekdays_valid
    CHECK (weekdays_active <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  CONSTRAINT tenant_lesson_time_rules_time_window
    CHECK (time_local_end IS NULL OR time_local_end > time_local),
  CONSTRAINT tenant_lesson_time_rules_effective_window
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE tenant_lesson_time_rules IS
  'Sunset Admin lesson time templates. Recurring rows use weekdays_active; '
  'service_date set for one-off overrides (weekdays_active ignored at read time).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_time_recurring
  ON tenant_lesson_time_rules (client_slug, lesson_type, time_local)
  WHERE service_date IS NULL AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_lesson_time_date
  ON tenant_lesson_time_rules (client_slug, service_date, time_local, lesson_type)
  WHERE service_date IS NOT NULL AND active = true;

CREATE INDEX IF NOT EXISTS idx_tenant_lesson_time_client_active
  ON tenant_lesson_time_rules (client_slug, active);

CREATE INDEX IF NOT EXISTS idx_tenant_lesson_time_client_date
  ON tenant_lesson_time_rules (client_slug, service_date)
  WHERE service_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_lesson_time_client_effective
  ON tenant_lesson_time_rules (client_slug, active, effective_from, effective_to)
  WHERE active = true;

CREATE TRIGGER tenant_lesson_time_rules_updated_at
  BEFORE UPDATE ON tenant_lesson_time_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_config_audit_log
-- ---------------------------------------------------------------------------
-- Append-only audit trail for Admin config mutations (future write slice).

CREATE TABLE IF NOT EXISTS tenant_config_audit_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  client_slug     TEXT NOT NULL,
  actor_user_id   UUID REFERENCES staff_users(id) ON DELETE SET NULL,
  actor_email     TEXT NOT NULL,
  action          TEXT NOT NULL
                  CHECK (action IN ('create', 'update', 'deactivate', 'import', 'rollback')),
  entity_type     TEXT NOT NULL
                  CHECK (entity_type IN ('price_rule', 'capacity_rule', 'lesson_time_rule')),
  entity_id       UUID NOT NULL,
  before_json     JSONB,
  after_json      JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenant_config_audit_log IS
  'Append-only Sunset Admin config audit log. One row per mutation; never UPDATE/DELETE.';

CREATE INDEX IF NOT EXISTS idx_tenant_config_audit_client_created
  ON tenant_config_audit_log (client_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_config_audit_entity
  ON tenant_config_audit_log (entity_type, entity_id);

COMMIT;
