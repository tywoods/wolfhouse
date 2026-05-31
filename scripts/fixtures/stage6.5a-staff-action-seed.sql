-- Stage 6.5a fixture seed: one open staff_handoff for proposal proof.
-- Phone: +34600000190 (fake, not used in any real booking).
-- Run AFTER cleanup to ensure idempotency.

BEGIN;

INSERT INTO staff_handoffs (
  client_id,
  phone,
  source_channel,
  reason_code,
  summary,
  guest_message,
  language,
  priority,
  status,
  metadata
)
SELECT
  c.id,
  '+34600000190',
  'whatsapp',
  'unclear_request',
  'Stage 6.5a proposal proof fixture — safe to delete',
  'Hi, I need some help please',
  'en',
  'normal',
  'open',
  '{"fixture": true, "stage": "6.5a", "auto_cleanup": true}'::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

COMMIT;
