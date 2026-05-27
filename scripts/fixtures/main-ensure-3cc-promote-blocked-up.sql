-- Phase 3c.c.4 — confirmed booking for blocked promote test only.

BEGIN;

INSERT INTO bookings (
  client_id, booking_code, guest_name, phone, status, payment_status,
  assignment_status, availability_check_status, check_in, check_out, guest_count,
  booking_source, send_confirmation
)
SELECT
  c.id, 'WH-3C-PROMOTE-CONFIRMED', 'Blocked Fixture', '+353399990099',
  'confirmed'::booking_status, 'deposit_paid'::payment_status,
  'assigned'::assignment_status, 'available'::availability_check_status,
  '2026-09-01'::date, '2026-09-05'::date, 1, 'whatsapp'::booking_source, FALSE
FROM clients c WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, booking_code) DO UPDATE SET
  status = EXCLUDED.status,
  payment_status = EXCLUDED.payment_status,
  updated_at = NOW();

COMMIT;
