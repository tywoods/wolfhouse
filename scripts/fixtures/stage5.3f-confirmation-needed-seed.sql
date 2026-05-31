-- Stage 5.3f — Fixture confirmation-needed seed
-- Pre-seeds one booking eligible for getConfirmationNeededQuery():
--   send_confirmation=TRUE, confirmation_sent_at IS NULL,
--   payment_status=deposit_paid, status=payment_pending,
--   payments.status=paid, amount_paid_cents > 0
--
-- Scoped to: wolfhouse-somo + fixture phone 34600000156 only.
-- Safe to re-run: DELETE-first idempotency.
-- No booking_beds. No payment_events.

BEGIN;

DELETE FROM payments
WHERE stripe_checkout_session_id = 'cs_test_stage53f_confirm_001'
   OR booking_id IN (
     SELECT b.id FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND b.phone IN ('34600000156', '+34600000156')
   );

DELETE FROM bookings
WHERE phone IN ('34600000156', '+34600000156')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

INSERT INTO bookings (
  client_id,
  booking_code,
  phone,
  guest_name,
  status,
  payment_status,
  check_in,
  check_out,
  guest_count,
  package_code,
  requested_room_type,
  room_preference,
  hold_expires_at,
  assignment_status,
  availability_check_status,
  total_amount_cents,
  deposit_required_cents,
  amount_paid_cents,
  send_confirmation,
  confirmation_sent_at,
  booking_source
)
SELECT
  c.id,
  'WH-53-CONFIRM-001',
  '+34600000156',
  'Test Guest 53f',
  'payment_pending'::booking_status,
  'deposit_paid'::payment_status,
  '2026-07-01',
  '2026-07-08',
  2,
  'malibu',
  'shared',
  'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status,
  'available'::availability_check_status,
  69900,
  20000,
  20000,
  TRUE,
  NULL,
  'whatsapp'::booking_source
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

INSERT INTO payments (
  client_id,
  booking_id,
  status,
  payment_kind,
  currency,
  amount_due_cents,
  amount_paid_cents,
  stripe_checkout_session_id,
  checkout_url,
  paid_at
)
SELECT
  c.id,
  b.id,
  'paid'::payment_record_status,
  'deposit_only'::payment_kind,
  'EUR',
  20000,
  20000,
  'cs_test_stage53f_confirm_001',
  'https://checkout.stripe.test/stage53f/cs_test_stage53f_confirm_001',
  NOW()
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo'
  AND b.phone = '+34600000156'
  AND b.booking_code = 'WH-53-CONFIRM-001';

COMMIT;

-- Post-seed verification (run after COMMIT, expect 1 each)
-- SELECT COUNT(*) FROM bookings WHERE phone = '+34600000156' AND booking_code = 'WH-53-CONFIRM-001';
-- SELECT COUNT(*) FROM payments WHERE stripe_checkout_session_id = 'cs_test_stage53f_confirm_001';
