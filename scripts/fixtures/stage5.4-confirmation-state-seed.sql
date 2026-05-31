-- Stage 5.4 — Confirmation state fixture seed
-- Seeds two bookings to prove getConfirmationNeededQuery() semantics:
--
--   Fixture A (WH-54-NEEDS-001, +34600000158):
--     send_confirmation=TRUE, confirmation_sent_at=NULL
--     → expected: APPEARS in getConfirmationNeededQuery()
--
--   Fixture B (WH-54-CONFIRMED-001, +34600000159):
--     send_confirmation=TRUE, confirmation_sent_at IS NOT NULL
--     → expected: does NOT appear in getConfirmationNeededQuery()
--
-- Scoped to wolfhouse-somo + fixture phones 34600000158 / 34600000159 only.
-- Safe to re-run: DELETE-first idempotency.
-- No booking_beds. No payment_events.

BEGIN;

-- --- cleanup first (idempotency) ---

DELETE FROM payments
WHERE stripe_checkout_session_id IN (
  'cs_test_stage54_needs_001',
  'cs_test_stage54_confirmed_001'
);

DELETE FROM bookings
WHERE client_id = (SELECT id FROM clients WHERE slug = 'wolfhouse-somo')
  AND phone IN ('+34600000158', '34600000158', '+34600000159', '34600000159');

-- --- Fixture A: needs confirmation ---

INSERT INTO bookings (
  client_id, booking_code, phone, guest_name,
  status, payment_status,
  check_in, check_out, guest_count, package_code,
  requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, amount_paid_cents,
  send_confirmation, confirmation_sent_at,
  booking_source
)
SELECT
  c.id,
  'WH-54-NEEDS-001',
  '+34600000158',
  'Test Guest 54a',
  'payment_pending'::booking_status,
  'deposit_paid'::payment_status,
  '2026-07-15', '2026-07-22',
  2, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status,
  'available'::availability_check_status,
  69900, 20000, 20000,
  TRUE,
  NULL,
  'whatsapp'::booking_source
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

INSERT INTO payments (
  client_id, booking_id, status, payment_kind,
  currency, amount_due_cents, amount_paid_cents,
  stripe_checkout_session_id, checkout_url, paid_at
)
SELECT
  c.id, b.id,
  'paid'::payment_record_status,
  'deposit_only'::payment_kind,
  'EUR', 20000, 20000,
  'cs_test_stage54_needs_001',
  'https://checkout.stripe.test/stage54/cs_test_stage54_needs_001',
  NOW()
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo'
  AND b.booking_code = 'WH-54-NEEDS-001';

-- --- Fixture B: already confirmed (confirmation_sent_at IS NOT NULL) ---

INSERT INTO bookings (
  client_id, booking_code, phone, guest_name,
  status, payment_status,
  check_in, check_out, guest_count, package_code,
  requested_room_type, room_preference,
  hold_expires_at, assignment_status, availability_check_status,
  total_amount_cents, deposit_required_cents, amount_paid_cents,
  send_confirmation, confirmation_sent_at,
  booking_source
)
SELECT
  c.id,
  'WH-54-CONFIRMED-001',
  '+34600000159',
  'Test Guest 54b',
  'payment_pending'::booking_status,
  'deposit_paid'::payment_status,
  '2026-07-15', '2026-07-22',
  2, 'malibu', 'shared', 'shared',
  NOW() + INTERVAL '1 hour',
  'unassigned'::assignment_status,
  'available'::availability_check_status,
  69900, 20000, 20000,
  TRUE,
  '2026-06-01 10:00:00+00',
  'whatsapp'::booking_source
FROM clients c
WHERE c.slug = 'wolfhouse-somo';

INSERT INTO payments (
  client_id, booking_id, status, payment_kind,
  currency, amount_due_cents, amount_paid_cents,
  stripe_checkout_session_id, checkout_url, paid_at
)
SELECT
  c.id, b.id,
  'paid'::payment_record_status,
  'deposit_only'::payment_kind,
  'EUR', 20000, 20000,
  'cs_test_stage54_confirmed_001',
  'https://checkout.stripe.test/stage54/cs_test_stage54_confirmed_001',
  NOW()
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = 'wolfhouse-somo'
  AND b.booking_code = 'WH-54-CONFIRMED-001';

COMMIT;
