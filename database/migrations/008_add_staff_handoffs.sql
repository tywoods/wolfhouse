-- Stage 5.7 — Staff handoffs / staff tasks schema
-- Creates tables for human-handoff and staff-task tracking:
--   staff_handoffs — one record per conversation/booking that needs a human
--   staff_tasks    — optional follow-up task list (linked to a handoff or booking)
--
-- Design principles:
--   * reason_code / task_type are TEXT (config-driven, not enums — easy to extend).
--   * priority and status use CHECK constraints (same style as migration 007).
--   * Migration is IDEMPOTENT via CREATE TABLE IF NOT EXISTS.
--   * No changes to existing tables.
--   * Staff UI consumes these in Stage 6; bot only writes handoff rows.
--
-- NOT YET APPLIED — stub for Stage 5.7. Apply only when approved for pilot.

BEGIN;

-- ---------------------------------------------------------------------------
-- staff_handoffs
-- ---------------------------------------------------------------------------
-- One record per conversation/booking that requires a human reply or review.
-- Created by the bot when it cannot or must not act autonomously (low confidence,
-- payment claim, cancellation/refund, angry guest, etc.). Resolved by staff.

CREATE TABLE IF NOT EXISTS staff_handoffs (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id         UUID REFERENCES conversations(id) ON DELETE SET NULL,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  phone                   TEXT,
  source_channel          TEXT NOT NULL DEFAULT 'whatsapp'
                          CHECK (source_channel IN ('whatsapp', 'staff', 'other')),
  reason_code             TEXT NOT NULL,
  summary                 TEXT,
  guest_message           TEXT,
  language                TEXT DEFAULT 'en',
  priority                TEXT NOT NULL DEFAULT 'normal'
                          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status                  TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'assigned', 'waiting_guest',
                                            'resolved', 'cancelled')),
  assigned_staff          TEXT,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_response_due_at   TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  resolution_summary      TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_handoffs_client
  ON staff_handoffs (client_id);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_status
  ON staff_handoffs (client_id, status);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_reason_code
  ON staff_handoffs (client_id, reason_code);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_priority
  ON staff_handoffs (client_id, priority);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_opened_at
  ON staff_handoffs (client_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_assigned_staff
  ON staff_handoffs (assigned_staff)
  WHERE assigned_staff IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_booking
  ON staff_handoffs (booking_id);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_conversation
  ON staff_handoffs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_phone
  ON staff_handoffs (phone)
  WHERE phone IS NOT NULL;
-- Partial index: fast lookup of still-open handoffs (the common staff query).
CREATE INDEX IF NOT EXISTS idx_staff_handoffs_open
  ON staff_handoffs (client_id, priority, opened_at)
  WHERE status IN ('open', 'assigned', 'waiting_guest');

CREATE TRIGGER staff_handoffs_updated_at
  BEFORE UPDATE ON staff_handoffs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- staff_tasks
-- ---------------------------------------------------------------------------
-- Optional follow-up task list. A handoff may spawn one or more concrete tasks
-- (e.g. "call guest back", "process refund", "assign driver"). Kept minimal;
-- richer task workflow is deferred to Stage 6 staff UI.

CREATE TABLE IF NOT EXISTS staff_tasks (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  handoff_id              UUID REFERENCES staff_handoffs(id) ON DELETE SET NULL,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  task_type               TEXT NOT NULL DEFAULT 'general',
  title                   TEXT,
  description             TEXT,
  priority                TEXT NOT NULL DEFAULT 'normal'
                          CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status                  TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'assigned', 'in_progress',
                                            'resolved', 'cancelled')),
  assigned_staff          TEXT,
  due_at                  TIMESTAMPTZ,
  resolved_at             TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_staff_tasks_client
  ON staff_tasks (client_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_status
  ON staff_tasks (client_id, status);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_handoff
  ON staff_tasks (handoff_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_booking
  ON staff_tasks (booking_id);
CREATE INDEX IF NOT EXISTS idx_staff_tasks_assigned_staff
  ON staff_tasks (assigned_staff)
  WHERE assigned_staff IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_staff_tasks_due_at
  ON staff_tasks (due_at)
  WHERE due_at IS NOT NULL;

CREATE TRIGGER staff_tasks_updated_at
  BEFORE UPDATE ON staff_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
