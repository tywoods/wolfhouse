-- Stage 7.7g — Bed calendar API: fixture seed
--
-- Seeds one fake booking (WH-77G-CAL-001) and one booking_beds row
-- overlapping the proof range 2026-07-16 to 2026-07-23.
--
-- The booking_beds row uses the first active bed found for wolfhouse-somo.
-- If no beds exist, only the booking is inserted and the bed row is skipped.
--
-- Cleanup: run stage7.7g-bed-calendar-cleanup.sql after the proof.
-- NOT for production. NOT for staging. Local/dev only.
-- Protected tables: bookings and booking_beds are touched for proof only.

BEGIN;

-- ── Booking row ───────────────────────────────────────────────────────────────
INSERT INTO bookings (
  client_id,
  booking_code,
  guest_name,
  phone,
  check_in,
  check_out,
  status,
  payment_status,
  assignment_status,
  guest_count
)
SELECT
  c.id,
  'WH-77G-CAL-001',
  'Test Guest 7.7g',
  '+34600000192',
  '2026-07-16'::date,
  '2026-07-23'::date,
  'confirmed',
  'paid',
  'assigned',
  1
FROM clients c
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT DO NOTHING;

-- ── Booking beds row (uses first active bed for this client) ──────────────────
INSERT INTO booking_beds (
  client_id,
  booking_id,
  bed_id,
  room_code,
  bed_code,
  assignment_start_date,
  assignment_end_date,
  planning_row_label,
  guest_name
)
SELECT
  b.client_id,
  b.id                   AS booking_id,
  bd.id                  AS bed_id,
  r.room_code,
  bd.bed_code,
  '2026-07-16'::date,
  '2026-07-23'::date,
  '[Fixture 7.7g] Test block ' || bd.bed_code,
  'Test Guest 7.7g'
FROM bookings b
JOIN clients c  ON c.id = b.client_id AND c.slug = 'wolfhouse-somo'
JOIN beds bd    ON bd.client_id = b.client_id AND bd.active = TRUE
JOIN rooms r    ON r.id = bd.room_id  AND r.active = TRUE
WHERE b.booking_code = 'WH-77G-CAL-001'
ORDER BY r.room_code ASC, bd.bed_code ASC
LIMIT 1
ON CONFLICT DO NOTHING;

COMMIT;
