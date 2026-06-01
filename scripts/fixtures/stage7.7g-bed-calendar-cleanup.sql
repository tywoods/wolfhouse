-- Stage 7.7g — Bed calendar API: fixture cleanup
--
-- Removes the booking_beds row(s) and booking seeded by
-- stage7.7g-bed-calendar-seed.sql.
--
-- Does NOT touch rooms, beds, payments, payment_events, staff_handoffs,
-- or any other protected table.
--
-- Client: wolfhouse-somo (resolved via subquery — no hardcoded UUIDs).
-- Local/dev only.

BEGIN;

-- Remove booking_beds first (FK to bookings)
DELETE FROM booking_beds
WHERE booking_id IN (
  SELECT b.id
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
  WHERE c.slug = 'wolfhouse-somo'
    AND b.booking_code = 'WH-77G-CAL-001'
);

-- Remove booking
DELETE FROM bookings
WHERE booking_code = 'WH-77G-CAL-001'
  AND client_id = (
    SELECT id FROM clients WHERE slug = 'wolfhouse-somo'
  );

COMMIT;
