-- Phase 3c.d.4 — Remove test conversation for active-hold fixture phone (no payments).

BEGIN;

DELETE FROM messages m
USING conversations c, clients cl
WHERE m.conversation_id = c.id
  AND c.client_id = cl.id
  AND cl.slug = 'wolfhouse-somo'
  AND c.phone = '+353300000001';

DELETE FROM conversations c
USING clients cl
WHERE c.client_id = cl.id
  AND cl.slug = 'wolfhouse-somo'
  AND c.phone = '+353300000001';

COMMIT;
