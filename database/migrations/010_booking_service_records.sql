-- Stage 8.8.7 — Flat booking service records for Staff Ask Luna (MVP)
--
-- Purpose:
--   Persist operational add-on/service rows (yoga, meals, lessons, wetsuits, surfboards)
--   so POST /staff/ask-luna can answer from structured Postgres data — never chat logs.
--
-- Data ownership:
--   * Staff API / Postgres is the source of truth for service records.
--   * n8n is a message pipe only; it does not own service record truth.
--   * payment_status = 'paid' requires Stripe webhook truth or staff manual mark-paid
--     (future write path) — never inferred from conversation text.
--   * Ask Luna reads this table via fixed parameterized intents only (Stage 8.8.9+).
--
-- Relation to 007_add_addon_orders.sql:
--   Migration 007 is a normalized add-on order model (not yet applied).
--   This flat table is the MVP path per STAGE-8.8.6; a SQL view may unify later.
--
-- NOT YET APPLIED — spec only (Stage 8.8.7). Do not run without explicit approval.

BEGIN;

CREATE TABLE IF NOT EXISTS booking_service_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug         TEXT NOT NULL,
  booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,
  booking_code        TEXT,
  guest_name          TEXT,
  service_type        TEXT NOT NULL
                      CHECK (service_type IN ('yoga', 'meal', 'surf_lesson', 'wetsuit', 'surfboard')),
  service_date        DATE NOT NULL,
  quantity            INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status              TEXT NOT NULL DEFAULT 'requested'
                      CHECK (status IN ('requested', 'confirmed', 'paid', 'cancelled')),
  amount_due_cents    INTEGER NOT NULL DEFAULT 0 CHECK (amount_due_cents >= 0),
  amount_paid_cents   INTEGER NOT NULL DEFAULT 0 CHECK (amount_paid_cents >= 0),
  payment_status      TEXT NOT NULL DEFAULT 'not_requested'
                      CHECK (payment_status IN ('not_requested', 'pending', 'paid', 'refunded', 'waived')),
  source              TEXT NOT NULL DEFAULT 'staff_manual'
                      CHECK (source IN ('staff_manual', 'luna_guest', 'import', 'stripe')),
  notes               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE booking_service_records IS
  'Flat operational service/add-on rows for Staff Ask Luna. Staff API/Postgres is source of truth; n8n pipes messages only; no chat-log answers; paid status requires Stripe webhook or staff manual truth.';

COMMENT ON COLUMN booking_service_records.client_slug IS
  'Tenant slug (e.g. wolfhouse-somo). Matches Staff API client_slug filter.';

COMMENT ON COLUMN booking_service_records.service_type IS
  'Operational service category: yoga, meal, surf_lesson, wetsuit, surfboard.';

COMMENT ON COLUMN booking_service_records.service_date IS
  'Date staff operational queries filter on (class night, rental day, meal date).';

COMMENT ON COLUMN booking_service_records.payment_status IS
  'Payment truth: paid only after Stripe webhook or staff manual mark-paid — never from chat.';

CREATE INDEX IF NOT EXISTS idx_booking_service_records_client_date
  ON booking_service_records (client_slug, service_date);

CREATE INDEX IF NOT EXISTS idx_booking_service_records_client_type_date
  ON booking_service_records (client_slug, service_type, service_date);

CREATE INDEX IF NOT EXISTS idx_booking_service_records_booking
  ON booking_service_records (booking_id)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_booking_service_records_payment_status
  ON booking_service_records (payment_status);

CREATE TRIGGER booking_service_records_updated_at
  BEFORE UPDATE ON booking_service_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
