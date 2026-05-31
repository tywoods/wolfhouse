-- Stage 7.7b — Conversation API read endpoints: fixture cleanup
--
-- Removes the test conversation (+34600000191) and its messages seeded by
-- stage7.7b-conversation-api-seed.sql.
--
-- Does NOT touch bookings, payments, booking_beds, or staff_handoffs.
-- The auth fixture (stage7.2c-auth-seed.sql) is NOT cleaned here; run
-- stage7.2c-auth-cleanup.sql separately if desired.
--
-- Client: wolfhouse-somo (resolved via subquery — no hardcoded UUIDs).
-- Local/dev only.

BEGIN;

-- Remove messages first (FK to conversations)
DELETE FROM messages
WHERE conversation_id IN (
  SELECT conv.id
  FROM conversations conv
  JOIN clients c ON c.id = conv.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND conv.phone = '+34600000191'
);

-- Remove conversation
DELETE FROM conversations
WHERE phone = '+34600000191'
  AND client_id = (
    SELECT id FROM clients WHERE slug = 'wolfhouse-somo'
  );

COMMIT;
