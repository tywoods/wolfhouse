-- Stage 3.5e runtime gate (success-path logging) fixture
-- One disposable booking eligible for Send Confirmation. No payment writes.
-- Dry-run confirmation will mark it confirmed and emit a workflow_events row.
-- Reversible: see phase35e-confirm-success-down.sql
BEGIN;

INSERT INTO bookings (
  id, client_id, booking_code, guest_name, phone, email,
  status, payment_status, check_in, check_out, guest_count,
  package_code, send_confirmation, confirmation_sent_at, booking_source
) VALUES (
  'b35e0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35E-TEST-1',
  'Stage 35E Test Guest',
  '+10000000035',
  'stage35e-test@example.invalid',
  'payment_pending'::booking_status,
  'deposit_paid'::payment_status,
  CURRENT_DATE + INTERVAL '40 days',
  CURRENT_DATE + INTERVAL '43 days',
  1,
  'TEST-PKG',
  TRUE,
  NULL,
  'whatsapp'::booking_source
);

COMMIT;
