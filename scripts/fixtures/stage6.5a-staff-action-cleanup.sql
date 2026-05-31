-- Stage 6.5a fixture cleanup: remove the proposal proof handoff row.
-- Safe to run multiple times (no-op if row already gone).

BEGIN;

DELETE FROM staff_handoffs
WHERE phone = '+34600000190'
  AND (metadata->>'fixture')::boolean = true
  AND (metadata->>'stage') = '6.5a'
  AND status = 'open';

COMMIT;
