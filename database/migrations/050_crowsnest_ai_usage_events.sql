-- 050_crowsnest_ai_usage_events.sql
-- Crowsnest product AI usage durable ledger (ledger foundation).
--
-- Creates public.crowsnest_ai_usage_events for secret-free, contract-valid
-- per-call receipts (crowsnest.ai_usage.v1). Append-oriented inserts with
-- unique event_id. Idempotent + transactional. Safe to re-run.
--
-- Persists only opaque identifiers, occurred_at, provider/model/status,
-- opaque error_code, measured-or-unavailable tokens, latency, and cost
-- state/amount/currency. No JSON blob. No prompt/response/guest/booking/
-- conversation/message/email/phone/raw provider payload/account/credential
-- columns.
--
-- Least-privilege / apply assumptions (documented; role provisioning and
-- migration apply are out of band for this slice — do not apply credentials
-- or run this migration as part of the store unit gate):
--   * Application runtime injects a query-capable db into the store module
--     (scripts/lib/crowsnest/crowsnest-ai-usage-store.js); the store never
--     opens pools or reads WOLFHOUSE_DATABASE_URL / DATABASE_URL.
--   * Dedicated role should have: SELECT, INSERT on crowsnest_ai_usage_events
--     (append-oriented; no UPDATE/DELETE required for this slice).
--   * client_slug and tenant_id remain independent columns — never derive one
--     from the other at the database layer.
-- Migration apply / Azure secret wiring remains out of scope.

BEGIN;

CREATE TABLE IF NOT EXISTS crowsnest_ai_usage_events (
  event_id              TEXT PRIMARY KEY,
  occurred_at           TIMESTAMPTZ NOT NULL,
  client_slug           TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  source_service        TEXT NOT NULL,
  operation             TEXT NOT NULL,
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  status                TEXT NOT NULL,
  error_code            TEXT,
  tokens_availability   TEXT NOT NULL,
  input_tokens          BIGINT,
  output_tokens         BIGINT,
  total_tokens          BIGINT,
  latency_ms            BIGINT NOT NULL,
  cost_state            TEXT NOT NULL,
  cost_amount_micros    BIGINT,
  cost_currency         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT crowsnest_ai_usage_events_provider_check CHECK (
    provider IN ('openai', 'anthropic')
  ),
  CONSTRAINT crowsnest_ai_usage_events_status_check CHECK (
    status IN ('succeeded', 'failed')
  ),
  CONSTRAINT crowsnest_ai_usage_events_tokens_availability_check CHECK (
    tokens_availability IN ('measured', 'unavailable')
  ),
  CONSTRAINT crowsnest_ai_usage_events_cost_state_check CHECK (
    cost_state IN ('provider_reported', 'estimated', 'unavailable')
  ),
  CONSTRAINT crowsnest_ai_usage_events_error_code_check CHECK (
    (
      status = 'failed'
      AND error_code IS NOT NULL
      AND length(btrim(error_code)) > 0
    )
    OR (
      status = 'succeeded'
      AND error_code IS NULL
    )
  ),
  CONSTRAINT crowsnest_ai_usage_events_tokens_shape_check CHECK (
    (
      tokens_availability = 'measured'
      AND input_tokens IS NOT NULL
      AND output_tokens IS NOT NULL
      AND total_tokens IS NOT NULL
      AND input_tokens >= 0
      AND output_tokens >= 0
      AND total_tokens >= 0
      AND total_tokens = input_tokens + output_tokens
    )
    OR (
      tokens_availability = 'unavailable'
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND total_tokens IS NULL
    )
  ),
  CONSTRAINT crowsnest_ai_usage_events_cost_shape_check CHECK (
    (
      cost_state IN ('provider_reported', 'estimated')
      AND cost_amount_micros IS NOT NULL
      AND cost_amount_micros >= 0
      AND cost_currency IS NOT NULL
      AND length(cost_currency) = 3
    )
    OR (
      cost_state = 'unavailable'
      AND cost_amount_micros IS NULL
      AND cost_currency IS NULL
    )
  ),
  CONSTRAINT crowsnest_ai_usage_events_latency_check CHECK (
    latency_ms >= 0
  ),
  CONSTRAINT crowsnest_ai_usage_events_client_slug_nonempty CHECK (
    length(btrim(client_slug)) > 0
  ),
  CONSTRAINT crowsnest_ai_usage_events_tenant_id_nonempty CHECK (
    length(btrim(tenant_id)) > 0
  ),
  CONSTRAINT crowsnest_ai_usage_events_event_id_nonempty CHECK (
    length(btrim(event_id)) > 0
  )
);

CREATE INDEX IF NOT EXISTS idx_crowsnest_ai_usage_events_occurred_at
  ON crowsnest_ai_usage_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_crowsnest_ai_usage_events_tenant_occurred
  ON crowsnest_ai_usage_events (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_crowsnest_ai_usage_events_client_occurred
  ON crowsnest_ai_usage_events (client_slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_crowsnest_ai_usage_events_provider_occurred
  ON crowsnest_ai_usage_events (provider, occurred_at DESC);

COMMIT;
