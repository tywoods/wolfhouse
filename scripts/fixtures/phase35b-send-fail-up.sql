-- Stage 3.5b runtime gate (Gap 2 — WhatsApp send failure) fixture
-- One disposable booking eligible for Send Confirmation. No payment writes.
-- Reversible: see phase35b-send-fail-down.sql
BEGIN;

INSERT INTO bookings (
  id, client_id, booking_code, guest_name, phone, email,
  status, payment_status, check_in, check_out, guest_count,
  package_code, send_confirmation, confirmation_sent_at, booking_source
) VALUES (
  'b35b0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35B-TEST-1',
  'Stage 35B Test Guest',
  '+10000000035',
  'stage35b-test@example.invalid',
  'payment_pending'::booking_status,
  'deposit_paid'::payment_status,
  CURRENT_DATE + INTERVAL '30 days',
  CURRENT_DATE + INTERVAL '33 days',
  1,
  'TEST-PKG',
  TRUE,
  NULL,
  'whatsapp'::booking_source
);

COMMIT;
