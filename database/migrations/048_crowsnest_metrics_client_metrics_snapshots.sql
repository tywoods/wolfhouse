-- 048_crowsnest_metrics_client_metrics_snapshots.sql
-- Pupil: Crowsnest client-metrics durable snapshots (Model A).
--
-- Creates crowsnest_metrics.client_metrics_snapshots for latest-wins snapshots
-- pushed by tenant reporters via CROWSNEST_METRICS_DATABASE_URL.
-- Idempotent + transactional. Safe to re-run.
--
-- Least-privilege / schema-scoped SQL assumptions (documented; role provisioning
-- is out of band for this slice — do not hardcode role privilege statements for
-- staging or production principals here):
--   * Application runtime uses CROWSNEST_METRICS_DATABASE_URL only (never
--     WOLFHOUSE_DATABASE_URL / DATABASE_URL).
--   * Dedicated DB role should have: USAGE on schema crowsnest_metrics;
--     SELECT, INSERT, UPDATE on crowsnest_metrics.client_metrics_snapshots;
--     no CREATE/DROP, no access to public Wolfhouse booking tables required.
--   * All application SQL must qualify crowsnest_metrics.* (do not rely on search_path).
--   * Production runtime must NOT auto-DDL — this migration is the sole provisioner.
--   * Migration apply / Azure secret wiring is intentionally out of scope here.

BEGIN;

CREATE SCHEMA IF NOT EXISTS crowsnest_metrics;

CREATE TABLE IF NOT EXISTS crowsnest_metrics.client_metrics_snapshots (
  client_slug TEXT PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  event       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
