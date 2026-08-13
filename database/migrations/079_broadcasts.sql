-- 079_broadcasts.sql
-- Inbox Phase 4 smallest slice: email-first segment broadcasts.
--
-- Tables named in docs/INBOX-PORTAL-REDESIGN.md (planned there as 081).
-- 078 is luna_outbound_approvals; 079 is the next free number. Channel-mode
-- persistence and a saved-views table were reserved as 079/080 in that spec
-- and were not needed for this slice (saved views are code-defined).
--
-- contact_suppressions is out of scope: reuse customers.crm_tags.do_not_contact
-- via scripts/lib/staff-customer-outreach-send.js.
--
-- This migration is schema only. Do not apply it to a live DB from this PR.
-- Bulk Graph/mailbox send is a follow-up; the send route persists recipient
-- rows as pending and returns 501 email_broadcast_send_not_implemented.
-- WhatsApp promo blast is refused in the API (channel=whatsapp). Schema
-- allows channel=whatsapp so an operational checked-in path can land later
-- without another table.
--
-- Rollback: 079_broadcasts_down.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_users_client_id_id_uq') THEN
    ALTER TABLE staff_users ADD CONSTRAINT staff_users_client_id_id_uq UNIQUE (client_id, id);
  END IF;
END $$;

CREATE TABLE broadcasts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  view_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  email_subject TEXT NOT NULL,
  email_body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_by_staff_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT broadcasts_client_id_id_uq UNIQUE (client_id, id),
  CONSTRAINT broadcasts_channel_values
    CHECK (channel IN ('email', 'whatsapp')),
  CONSTRAINT broadcasts_status_values
    CHECK (status IN ('draft', 'pending', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT broadcasts_view_id_shape
    CHECK (char_length(view_id) BETWEEN 1 AND 64),
  CONSTRAINT broadcasts_email_subject_shape
    CHECK (char_length(email_subject) BETWEEN 1 AND 200),
  CONSTRAINT broadcasts_email_body_shape
    CHECK (char_length(email_body) BETWEEN 1 AND 20000)
);

COMMENT ON TABLE broadcasts IS
  'Inbox Phase 4 segment broadcasts (079). This slice creates email drafts only; Graph bulk send is not in this migration.';

COMMENT ON COLUMN broadcasts.channel IS
  'email | whatsapp. API refuses whatsapp in this PR (promotions are email-only).';

COMMENT ON COLUMN broadcasts.status IS
  'draft | pending | sending | sent | failed | cancelled. This slice writes draft on create and pending when send snapshots recipients.';

COMMENT ON COLUMN broadcasts.created_by_staff_user_id IS
  'Staff actor id. Not composite-FK''d to (client_id, staff_users.id) because secondary-client staff may broadcast on a tenant that is not their home client_id.';

CREATE INDEX idx_broadcasts_client_status_created
  ON broadcasts (client_id, status, created_at DESC);

CREATE TABLE broadcast_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  broadcast_id UUID NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NULL,
  display_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  skip_reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT broadcast_recipients_broadcast_fk
    FOREIGN KEY (client_id, broadcast_id) REFERENCES broadcasts (client_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT broadcast_recipients_status_values
    CHECK (status IN ('pending', 'skipped', 'sent', 'error')),
  CONSTRAINT broadcast_recipients_phone_shape
    CHECK (char_length(phone) BETWEEN 1 AND 64),
  CONSTRAINT broadcast_recipients_email_shape
    CHECK (email IS NULL OR char_length(email) BETWEEN 1 AND 160),
  CONSTRAINT broadcast_recipients_display_name_shape
    CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 160),
  CONSTRAINT broadcast_recipients_skip_reason_shape
    CHECK (skip_reason IS NULL OR char_length(skip_reason) BETWEEN 1 AND 64),
  CONSTRAINT broadcast_recipients_skip_reason_matches_status
    CHECK (
      (status = 'skipped' AND skip_reason IS NOT NULL)
      OR (status <> 'skipped' AND skip_reason IS NULL)
    ),
  CONSTRAINT broadcast_recipients_broadcast_phone_uq UNIQUE (broadcast_id, phone)
);

COMMENT ON TABLE broadcast_recipients IS
  'Per-recipient snapshot for a broadcast. pending = queued, not delivered. Graph/mailbox send is a follow-up.';

CREATE INDEX idx_broadcast_recipients_broadcast_status
  ON broadcast_recipients (client_id, broadcast_id, status);

CREATE TRIGGER broadcasts_updated_at
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
