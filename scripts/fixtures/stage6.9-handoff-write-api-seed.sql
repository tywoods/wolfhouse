-- Stage 6.9 fixture seed: one open staff_handoff for HTTP write API proof.
-- Phone: +34600000191 (fake, not used in any real booking).
-- Distinct from 6.5a fixture (+34600000190) to avoid collisions.
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
  '+34600000191',
  'whatsapp',
  'unclear_request',
  'Stage 6.9 HTTP write API proof fixture — safe to delete',
  'Hi, I need some help please',
  'en',
  'normal',
  'open',
  '{"fixture": true, "stage": "6.9", "auto_cleanup": true}'::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

COMMIT;
