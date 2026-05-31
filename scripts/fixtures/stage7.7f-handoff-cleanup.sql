-- Stage 7.7f — Handoff queue: fixture cleanup
--
-- Removes the test staff_handoff row inserted by stage7.7f-handoff-seed.sql.
-- Does NOT remove the conversation or messages; run
-- stage7.7b-conversation-api-cleanup.sql for that.
-- Does NOT touch bookings, payments, payment_events, or booking_beds.
--
-- Client: wolfhouse-somo (resolved via subquery — no hardcoded UUIDs).
-- Local/dev only.

BEGIN;

DELETE FROM staff_handoffs
WHERE conversation_id IN (
  SELECT conv.id
  FROM conversations conv
  JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND conv.phone = '+34600000191'
)
  AND reason_code = 'payment_inquiry'
  AND status = 'open';

COMMIT;
