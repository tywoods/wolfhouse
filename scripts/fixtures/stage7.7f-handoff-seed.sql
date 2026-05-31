-- Stage 7.7f — Handoff queue: fixture seed
--
-- Requires the Stage 7.7b conversation fixture to already be applied
-- (phone +34600000191, wolfhouse-somo).
--
-- Inserts one open staff_handoff row linked to that conversation so the
-- handoff queue endpoint and UI can be proven locally.
--
-- Cleanup: run stage7.7f-handoff-cleanup.sql after proof.
-- NOT for production. NOT for staging. Local/dev only.

BEGIN;

INSERT INTO staff_handoffs (
  client_id,
  conversation_id,
  booking_id,
  phone,
  language,
  reason_code,
  summary,
  priority,
  status,
  source_channel,
  assigned_staff,
  opened_at
)
SELECT
  c.id,
  conv.id,
  NULL,
  conv.phone,
  conv.language,
  'payment_inquiry',
  '[Fixture 7.7f] Guest is asking about payment for July booking. Needs staff review.',
  'high',
  'open',
  'whatsapp',
  NULL,
  NOW() - INTERVAL '2 hours'
FROM clients c
JOIN conversations conv
  ON conv.client_id = c.id AND conv.phone = '+34600000191'
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT DO NOTHING;

COMMIT;
