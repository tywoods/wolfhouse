-- Phase 9.4a — Luna guest bot pause/resume state (schema spec)
--
-- Purpose:
--   Staff-controlled pause/resume for automated guest Luna replies per conversation/thread.
--
-- Source of truth:
--   bot_pause_states is the authoritative pause/resume store for Phase 9 Control & Safety.
--   Do NOT use conversations.bot_mode as the source of truth for Phase 9 pause/resume.
--   (conversations.bot_mode is a legacy/session enum; bot_pause_states is auditable ops state.)
--
-- Scope:
--   Pause/resume blocks automated guest replies only.
--   Staff Ask Luna (staff_portal / staff_whatsapp) is NOT blocked by this table.
--
-- NOT YET APPLIED — spec only (Phase 9.4a). Do not run without explicit approval.

BEGIN;

-- ---------------------------------------------------------------------------
-- bot_pause_states
-- ---------------------------------------------------------------------------
-- One row per pause/resume event scope. Active pause: paused = true.
-- On resume: set paused = false, resumed_by, resumed_at; retain row for audit.

CREATE TABLE IF NOT EXISTS bot_pause_states (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_slug       TEXT NOT NULL,
  guest_phone       TEXT,
  conversation_id   TEXT,
  booking_id        UUID REFERENCES bookings(id) ON DELETE SET NULL,
  booking_code      TEXT,
  paused            BOOLEAN NOT NULL DEFAULT TRUE,
  pause_reason      TEXT,
  paused_by         TEXT NOT NULL,
  paused_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumed_by        TEXT,
  resumed_at        TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_pause_states_scope_required
    CHECK (guest_phone IS NOT NULL OR conversation_id IS NOT NULL)
);

COMMENT ON TABLE bot_pause_states IS
  'Phase 9 pause/resume source of truth for staff-controlled Luna guest automation. '
  'Blocks automated guest replies only; Staff Ask Luna is not blocked. '
  'Do not use conversations.bot_mode as pause/resume source of truth.';

COMMENT ON COLUMN bot_pause_states.client_slug IS
  'Tenant slug (e.g. wolfhouse-somo). Required on every row.';

COMMENT ON COLUMN bot_pause_states.conversation_id IS
  'UUID string matching conversations.id when Inbox thread exists; preferred lookup key.';

COMMENT ON COLUMN bot_pause_states.guest_phone IS
  'Guest phone (E.164 preferred); fallback scope when conversation_id absent.';

COMMENT ON COLUMN bot_pause_states.paused IS
  'true = guest automation blocked until staff resumes; manual-only MVP (no auto-expiry).';

COMMENT ON COLUMN bot_pause_states.paused_by IS
  'Staff actor (staff_users.id or email) at pause time; required audit field.';

-- Lookup indexes
CREATE INDEX IF NOT EXISTS idx_bot_pause_states_client_slug
  ON bot_pause_states (client_slug);

CREATE INDEX IF NOT EXISTS idx_bot_pause_states_conversation_id
  ON bot_pause_states (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_pause_states_guest_phone
  ON bot_pause_states (guest_phone)
  WHERE guest_phone IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bot_pause_states_booking_code
  ON bot_pause_states (booking_code)
  WHERE booking_code IS NOT NULL;

-- At most one active paused row per client + conversation
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pause_states_active_conversation
  ON bot_pause_states (client_slug, conversation_id)
  WHERE paused = TRUE AND conversation_id IS NOT NULL;

-- At most one active paused row per client + phone when no conversation_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_pause_states_active_phone
  ON bot_pause_states (client_slug, guest_phone)
  WHERE paused = TRUE AND conversation_id IS NULL AND guest_phone IS NOT NULL;

CREATE TRIGGER bot_pause_states_updated_at
  BEFORE UPDATE ON bot_pause_states FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
