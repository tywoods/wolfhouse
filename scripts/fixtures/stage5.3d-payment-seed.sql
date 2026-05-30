-- Stage 5.3d — Fixture payment seed
-- Pre-seeds one fixture booking (payment_pending) and one payments row (checkout_created)
-- for the Stage 5.3d runtime gate.
--
-- Design choice (safety): The CPS workflow still uses its inline WHATSAPP_DRY_RUN check
-- and will NOT create a real payments row or call Stripe. We pre-seed the payments row
-- here so the Stripe webhook fixture replay (5.3e) has a matching stripe_checkout_session_id
-- to UPDATE. This avoids any risk of a live Stripe API call.
--
-- Scoped to: wolfhouse-somo + fixture phone 34600000153 only.
-- Safe to re-run: DELETE-first idempotency.

BEGIN;

-- 0. Clean up any prior fixture rows (idempotent)
DELETE FROM payments
WHERE stripe_checkout_session_id = 'cs_test_stage53_fixture_001'
   OR booking_id IN (
     SELECT b.id FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = 'wolfhouse-somo'
       AND b.phone IN ('34600000153', '+34600000153')
   );

DELETE FROM bookings
WHERE phone IN ('34600000153', '+34600000153')
  AND client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo');

-- 1. Insert fixture booking (payment_pending — simulates a promote having run)
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
  send_confirmation,
  booking_source
)
SELECT
  c.id,
  'WH-53-FIXTURE-001',
  '+34600000153',
  'Test Guest 53d',
  'payment_pending'::booking_status,
  'waiting_payment'::payment_status,
  '2026-07-01',
  '2026-07-08',
  1,
  'malibu',
  'shared',
  'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status,
  'available'::availability_check_status,
  69900,   -- €699 total (malibu 1 person 7 nights)
  20000,   -- €200 deposit
  FALSE,
  'whatsapp'::booking_source
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

-- 2. Insert fixture payments row (checkout_created — simulates CPS having run)
INSERT INTO payments (
  client_id,
  booking_id,
  status,
  payment_kind,
  currency,
  amount_due_cents,
  amount_paid_cents,
  stripe_checkout_session_id,
  checkout_url
)
SELECT
  c.id,
  b.id,
  'checkout_created'::payment_record_status,
  'deposit_only'::payment_kind,
  'EUR',
  20000,
  0,
  'cs_test_stage53_fixture_001',
  'https://checkout.stripe.test/stage53/cs_test_stage53_fixture_001'
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo'
  AND b.phone = '+34600000153'
  AND b.booking_code = 'WH-53-FIXTURE-001';

COMMIT;

-- Post-seed verification (run after COMMIT, expect 1 each)
-- SELECT COUNT(*) AS fixture_bookings FROM bookings WHERE phone = '+34600000153';
-- SELECT COUNT(*) AS fixture_payments FROM payments WHERE stripe_checkout_session_id = 'cs_test_stage53_fixture_001';
