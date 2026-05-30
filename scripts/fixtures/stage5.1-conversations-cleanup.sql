-- Stage 5.1 — conversation cleanup for dry-run gate phones
-- Run after A3/A4 (and eventually A2) Stage 5.1 runtime gate.
-- Scoped to wolfhouse-somo client; only removes fake dry-run test phones.
-- Safe to re-run (idempotent — DELETE WHERE has no effect if rows are already gone).
--
-- NOTE: n8n normalises phones with a leading '+' before writing to conversations.
-- Use both bare and prefixed variants to ensure cleanup is complete.

DELETE FROM conversations
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1)
  AND phone IN (
    '34600000102',  '+34600000102',
    '34600000103',  '+34600000103',
    '34600000104',  '+34600000104'
  );

-- Verify: expect 0 rows remaining
SELECT COUNT(*) AS remaining
FROM conversations
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1)
  AND phone IN (
    '34600000102',  '+34600000102',
    '34600000103',  '+34600000103',
    '34600000104',  '+34600000104'
  );
