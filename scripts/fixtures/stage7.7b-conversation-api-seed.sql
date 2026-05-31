-- Stage 7.7b — Conversation API read endpoints: fixture seed
--
-- Seeds one test conversation for phone +34600000191 with:
--   • a staff_reply_draft (pre-populated Luna draft)
--   • needs_human=true and bot_mode='bot'
--   • one inbound message in the messages table
--
-- Client: wolfhouse-somo (resolved via subquery — no hardcoded UUIDs).
-- Cleanup: run stage7.7b-conversation-api-cleanup.sql after the proof.
--
-- CONVERSATIONS table: uses client_id (renamed from hostel_id via migration 003).
-- MESSAGES table: uses client_id (renamed from hostel_id via migration 003).
--
-- NOT for production. NOT for staging. Local/dev only.

BEGIN;

-- ── Conversation row ─────────────────────────────────────────────────────────
INSERT INTO conversations (
  client_id,
  phone,
  language,
  display_name,
  needs_human,
  bot_mode,
  status,
  conversation_stage,
  staff_reply_draft,
  last_message_preview,
  last_bot_reply,
  human_notes,
  metadata
)
SELECT
  c.id,
  '+34600000191',
  'en',
  'Test Guest 7.7b',
  true,
  'bot',
  'open',
  'booking_flow',
  'Hi! We have availability for the week of July 15–22. Would you like to proceed with a reservation? The deposit is €200.',
  '[Fixture] Latest guest: "Do you have beds available for next week?"',
  'Hi! We have availability for the week of July 15–22. Would you like to proceed with a reservation?',
  'Test fixture conversation for Stage 7.7b conversation API proof.',
  '{}'
FROM clients c
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, phone) DO UPDATE
  SET display_name         = EXCLUDED.display_name,
      needs_human          = EXCLUDED.needs_human,
      bot_mode             = EXCLUDED.bot_mode,
      conversation_stage   = EXCLUDED.conversation_stage,
      staff_reply_draft    = EXCLUDED.staff_reply_draft,
      last_message_preview = EXCLUDED.last_message_preview,
      last_bot_reply       = EXCLUDED.last_bot_reply,
      human_notes          = EXCLUDED.human_notes,
      status               = 'open',
      updated_at           = NOW();

-- ── Inbound message ──────────────────────────────────────────────────────────
-- Inserts one inbound message to ensure /messages endpoint returns at least one row.
-- No whatsapp_message_id so the uniqueness constraint is not triggered.
INSERT INTO messages (
  client_id,
  conversation_id,
  direction,
  message_text,
  message_type,
  language,
  source,
  conversation_stage,
  created_at
)
SELECT
  c.id,
  conv.id,
  'inbound',
  'Do you have beds available for next week?',
  'text',
  'en',
  'whatsapp',
  'booking_flow',
  NOW() - INTERVAL '3 minutes'
FROM clients c
JOIN conversations conv
  ON conv.client_id = c.id AND conv.phone = '+34600000191'
WHERE c.slug = 'wolfhouse-somo';

COMMIT;
