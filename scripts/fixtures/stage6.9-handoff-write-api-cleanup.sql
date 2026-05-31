-- Stage 6.9 fixture cleanup: remove all rows for the HTTP write API proof fixture.
-- Removes rows regardless of status (open or resolved after confirmed write).
-- Safe to run multiple times.

DELETE FROM staff_handoffs
WHERE phone = '+34600000191'
  AND (metadata->>'fixture')::boolean = true
  AND (metadata->>'stage') = '6.9';
