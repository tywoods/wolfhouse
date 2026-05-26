-- Wolfhouse Booking Platform — initial schema
-- Requires PostgreSQL 15+ (gen_random_uuid)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE booking_status AS ENUM (
  'hold',
  'payment_pending',
  'confirmed',
  'cancelled',
  'expired',
  'needs_review',
  'checked_in',
  'blocked'
);

CREATE TYPE payment_status AS ENUM (
  'not_requested',
  'waiting_payment',
  'deposit_paid',
  'paid',
  'refunded',
  'failed'
);

CREATE TYPE assignment_status AS ENUM (
  'unassigned',
  'assigning',
  'assigned',
  'needs_review'
);

CREATE TYPE availability_check_status AS ENUM (
  'unknown',
  'available',
  'conflict',
  'needs_review'
);

CREATE TYPE booking_source AS ENUM (
  'whatsapp',
  'manual_staff',
  'operator',
  'other'
);

CREATE TYPE block_type AS ENUM (
  'none',
  'whole_room',
  'partial',
  'other'
);

CREATE TYPE conversation_status AS ENUM (
  'open',
  'closed',
  'on_hold'
);

CREATE TYPE bot_mode AS ENUM (
  'bot',
  'staff',
  'paused'
);

CREATE TYPE message_direction AS ENUM (
  'inbound',
  'outbound'
);

CREATE TYPE manual_entry_action AS ENUM (
  'create',
  'update',
  'delete',
  'sync'
);

CREATE TYPE manual_entry_sync_status AS ENUM (
  'pending',
  'processing',
  'synced',
  'error',
  'deleted'
);

CREATE TYPE payment_record_status AS ENUM (
  'draft',
  'checkout_created',
  'pending',
  'paid',
  'expired',
  'cancelled',
  'failed'
);

CREATE TYPE payment_kind AS ENUM (
  'deposit',
  'balance',
  'full',
  'custom'
);

CREATE TYPE operator_release_status AS ENUM (
  'pending',
  'processing',
  'completed',
  'failed'
);

CREATE TYPE automation_error_status AS ENUM (
  'open',
  'retrying',
  'resolved',
  'ignored'
);

CREATE TYPE workflow_event_level AS ENUM (
  'debug',
  'info',
  'warn',
  'error'
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- hostels
-- ---------------------------------------------------------------------------

CREATE TABLE hostels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Europe/Madrid',
  currency        CHAR(3) NOT NULL DEFAULT 'EUR',
  whatsapp_phone_number_id TEXT,
  stripe_account_id TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  settings        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER hostels_updated_at
  BEFORE UPDATE ON hostels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- packages (pricing rules per hostel)
-- ---------------------------------------------------------------------------

CREATE TABLE packages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id       UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  deposit_amount_cents INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, code)
);

CREATE INDEX idx_packages_hostel ON packages (hostel_id);

CREATE TRIGGER packages_updated_at
  BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- rooms & beds
-- ---------------------------------------------------------------------------

CREATE TABLE rooms (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  airtable_record_id      TEXT UNIQUE,
  room_code               TEXT NOT NULL,
  name                    TEXT,
  house                   TEXT,
  room_type               TEXT,
  capacity                INTEGER NOT NULL DEFAULT 0,
  fill_priority           INTEGER NOT NULL DEFAULT 50,
  private_priority        INTEGER NOT NULL DEFAULT 50,
  gender_strategy         TEXT NOT NULL DEFAULT 'Flexible',
  can_be_matrimonial      BOOLEAN NOT NULL DEFAULT FALSE,
  often_used_by_operator  BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order              INTEGER,
  avoid_until_needed      BOOLEAN NOT NULL DEFAULT FALSE,
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  notes                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, room_code)
);

CREATE INDEX idx_rooms_hostel ON rooms (hostel_id);

CREATE TRIGGER rooms_updated_at
  BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE beds (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id           UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  room_id             UUID NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  airtable_record_id  TEXT UNIQUE,
  bed_code            TEXT NOT NULL,
  bed_number          INTEGER,
  bed_label           TEXT,
  planning_row_label  TEXT,
  active              BOOLEAN NOT NULL DEFAULT TRUE,
  sellable            BOOLEAN NOT NULL DEFAULT TRUE,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, bed_code)
);

CREATE INDEX idx_beds_hostel_room ON beds (hostel_id, room_id);

CREATE TRIGGER beds_updated_at
  BEFORE UPDATE ON beds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- guests
-- ---------------------------------------------------------------------------

CREATE TABLE guests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id           UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  airtable_record_id  TEXT UNIQUE,
  full_name           TEXT,
  phone               TEXT,
  email               TEXT,
  language            TEXT DEFAULT 'en',
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_guests_hostel_phone
  ON guests (hostel_id, phone)
  WHERE phone IS NOT NULL;

CREATE INDEX idx_guests_hostel_email ON guests (hostel_id, email);

CREATE TRIGGER guests_updated_at
  BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------------

CREATE TABLE bookings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  guest_id                UUID REFERENCES guests(id) ON DELETE SET NULL,
  package_id              UUID REFERENCES packages(id) ON DELETE SET NULL,
  airtable_record_id      TEXT UNIQUE,
  booking_code            TEXT NOT NULL,
  guest_name              TEXT,
  phone                   TEXT,
  email                   TEXT,
  status                  booking_status NOT NULL DEFAULT 'hold',
  payment_status          payment_status NOT NULL DEFAULT 'not_requested',
  assignment_status       assignment_status NOT NULL DEFAULT 'unassigned',
  availability_check_status availability_check_status NOT NULL DEFAULT 'unknown',
  check_in                DATE NOT NULL,
  check_out               DATE NOT NULL,
  guest_count             INTEGER NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  package_code            TEXT,
  hold_expires_at         TIMESTAMPTZ,
  send_confirmation       BOOLEAN NOT NULL DEFAULT FALSE,
  guest_gender_group_type TEXT,
  requested_room_type     TEXT,
  room_preference         TEXT,
  rooming_notes           TEXT,
  rooming_confidence      NUMERIC(4,3),
  needs_rooming_review    BOOLEAN NOT NULL DEFAULT FALSE,
  booking_source          booking_source NOT NULL DEFAULT 'whatsapp',
  staff_notes             TEXT,
  conflict_notes          TEXT,
  operator_name           TEXT,
  block_type              block_type NOT NULL DEFAULT 'none',
  room_to_block_id        UUID REFERENCES rooms(id) ON DELETE SET NULL,
  payment_option          TEXT,
  payment_notes           TEXT,
  deposit_required_cents  INTEGER,
  deposit_paid_cents      INTEGER,
  balance_due_cents       INTEGER,
  total_amount_cents      INTEGER,
  amount_paid_cents       INTEGER,
  primary_room_code       TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, booking_code),
  CHECK (check_out > check_in)
);

CREATE INDEX idx_bookings_hostel_dates ON bookings (hostel_id, check_in, check_out);
CREATE INDEX idx_bookings_hostel_status ON bookings (hostel_id, status);
CREATE INDEX idx_bookings_phone ON bookings (hostel_id, phone);
CREATE INDEX idx_bookings_hold_expires ON bookings (hostel_id, hold_expires_at)
  WHERE status = 'hold';

CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- booking_beds
-- ---------------------------------------------------------------------------

CREATE TABLE booking_beds (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  bed_id                  UUID NOT NULL REFERENCES beds(id) ON DELETE RESTRICT,
  airtable_record_id      TEXT UNIQUE,
  assignment_label        TEXT,
  assignment_type         TEXT,
  assignment_notes        TEXT,
  assignment_start_date   DATE NOT NULL,
  assignment_end_date     DATE NOT NULL,
  planning_row_label      TEXT,
  guest_name              TEXT,
  room_code               TEXT,
  bed_code                TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (assignment_end_date > assignment_start_date)
);

CREATE INDEX idx_booking_beds_availability
  ON booking_beds (hostel_id, bed_id, assignment_start_date, assignment_end_date);

CREATE INDEX idx_booking_beds_booking ON booking_beds (booking_id);

CREATE TRIGGER booking_beds_updated_at
  BEFORE UPDATE ON booking_beds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations & messages
-- ---------------------------------------------------------------------------

CREATE TABLE conversations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  guest_id                UUID REFERENCES guests(id) ON DELETE SET NULL,
  airtable_record_id      TEXT UNIQUE,
  display_name            TEXT,
  phone                   TEXT NOT NULL,
  email                   TEXT,
  language                TEXT DEFAULT 'en',
  session_state           JSONB NOT NULL DEFAULT '{}',
  conversation_summary    TEXT,
  last_message_preview    TEXT,
  last_bot_reply          TEXT,
  needs_human             BOOLEAN NOT NULL DEFAULT FALSE,
  status                  conversation_status NOT NULL DEFAULT 'open',
  conversation_stage      TEXT,
  bot_mode                bot_mode NOT NULL DEFAULT 'bot',
  current_hold_booking_id UUID REFERENCES bookings(id) ON DELETE SET NULL,
  pending_action          TEXT,
  staff_reply_draft       TEXT,
  human_notes             TEXT,
  internal_staff_notes    TEXT,
  last_staff_reply_at     TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, phone)
);

CREATE INDEX idx_conversations_hostel_status ON conversations (hostel_id, status);

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  conversation_id         UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  airtable_record_id      TEXT UNIQUE,
  direction               message_direction NOT NULL,
  message_text            TEXT NOT NULL,
  message_type            TEXT,
  language                TEXT,
  route                   TEXT,
  whatsapp_message_id     TEXT,
  source                  TEXT NOT NULL DEFAULT 'whatsapp',
  conversation_stage      TEXT,
  chat_line               TEXT,
  chat_display            TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at DESC);
CREATE UNIQUE INDEX idx_messages_whatsapp_id
  ON messages (hostel_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

CREATE TRIGGER messages_updated_at
  BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------

CREATE TABLE payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  booking_id              UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  status                  payment_record_status NOT NULL DEFAULT 'draft',
  kind                    payment_kind NOT NULL DEFAULT 'deposit',
  currency                CHAR(3) NOT NULL DEFAULT 'EUR',
  amount_cents            INTEGER NOT NULL CHECK (amount_cents >= 0),
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id   TEXT,
  checkout_url            TEXT,
  paid_at                 TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_booking ON payments (booking_id);
CREATE INDEX idx_payments_hostel_status ON payments (hostel_id, status);
CREATE UNIQUE INDEX payments_stripe_payment_intent_id_unique
  ON payments (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TRIGGER payments_updated_at
  BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  payment_id              UUID REFERENCES payments(id) ON DELETE SET NULL,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  stripe_event_id         TEXT UNIQUE,
  event_type              TEXT NOT NULL,
  payload                 JSONB NOT NULL,
  processed               BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_events_payment ON payment_events (payment_id);

-- ---------------------------------------------------------------------------
-- manual entries (Google Sheets queue)
-- ---------------------------------------------------------------------------

CREATE TABLE manual_entries (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  manual_entry_code       TEXT NOT NULL,
  sheet_row_number        INTEGER,
  action                  manual_entry_action NOT NULL DEFAULT 'create',
  sync_status             manual_entry_sync_status NOT NULL DEFAULT 'pending',
  guest_name              TEXT,
  package_code            TEXT,
  deposit_paid_cents      INTEGER,
  phone                   TEXT,
  email                   TEXT,
  check_in                DATE,
  check_out               DATE,
  guest_count             INTEGER,
  room_bed_raw            TEXT,
  status_text             TEXT,
  payment_status_text     TEXT,
  notes                   TEXT,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  error_message           TEXT,
  created_by              TEXT,
  synced_at               TIMESTAMPTZ,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (hostel_id, manual_entry_code)
);

CREATE INDEX idx_manual_entries_sync ON manual_entries (hostel_id, sync_status);

CREATE TRIGGER manual_entries_updated_at
  BEFORE UPDATE ON manual_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- operator room release
-- ---------------------------------------------------------------------------

CREATE TABLE operator_room_release_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID NOT NULL REFERENCES hostels(id) ON DELETE CASCADE,
  airtable_record_id      TEXT UNIQUE,
  request_code            TEXT,
  operator_name           TEXT NOT NULL,
  room_id                 UUID REFERENCES rooms(id) ON DELETE SET NULL,
  room_code               TEXT,
  release_start_date      DATE NOT NULL,
  release_end_date        DATE NOT NULL,
  status                  operator_release_status NOT NULL DEFAULT 'pending',
  notes                   TEXT,
  original_booking_id     UUID REFERENCES bookings(id) ON DELETE SET NULL,
  new_booking_a_id        UUID REFERENCES bookings(id) ON DELETE SET NULL,
  new_booking_b_id        UUID REFERENCES bookings(id) ON DELETE SET NULL,
  error_notes             TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (release_end_date > release_start_date)
);

CREATE INDEX idx_operator_release_hostel_status
  ON operator_room_release_requests (hostel_id, status);

CREATE TRIGGER operator_room_release_requests_updated_at
  BEFORE UPDATE ON operator_room_release_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- automation_errors & workflow_events
-- ---------------------------------------------------------------------------

CREATE TABLE automation_errors (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID REFERENCES hostels(id) ON DELETE SET NULL,
  workflow_name           TEXT NOT NULL,
  node_name               TEXT,
  execution_id            TEXT,
  execution_url           TEXT,
  error_message           TEXT NOT NULL,
  error_stack             TEXT,
  severity                TEXT NOT NULL DEFAULT 'error',
  status                  automation_error_status NOT NULL DEFAULT 'open',
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  conversation_id         UUID REFERENCES conversations(id) ON DELETE SET NULL,
  manual_entry_id         UUID REFERENCES manual_entries(id) ON DELETE SET NULL,
  payload                 JSONB NOT NULL DEFAULT '{}',
  retry_count             INTEGER NOT NULL DEFAULT 0,
  resolved_at             TIMESTAMPTZ,
  resolved_by             TEXT,
  staff_alert_sent        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_automation_errors_status ON automation_errors (status, created_at DESC);

CREATE TRIGGER automation_errors_updated_at
  BEFORE UPDATE ON automation_errors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workflow_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostel_id               UUID REFERENCES hostels(id) ON DELETE SET NULL,
  workflow_name           TEXT NOT NULL,
  node_name               TEXT,
  execution_id            TEXT,
  event_level             workflow_event_level NOT NULL DEFAULT 'info',
  message                 TEXT NOT NULL,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  conversation_id         UUID REFERENCES conversations(id) ON DELETE SET NULL,
  payload                 JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_events_execution ON workflow_events (execution_id);
CREATE INDEX idx_workflow_events_created ON workflow_events (created_at DESC);
