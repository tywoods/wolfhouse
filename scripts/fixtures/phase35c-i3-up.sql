-- Phase 3.5c / I3 — Stripe duplicate-event idempotency fixture (UP)
-- Seeds one disposable booking and one disposable payments row.
-- Used with: Stripe Webhook Handler (KZUQvwR6SPWpvaZ5), STRIPE_WEBHOOK_SKIP_VERIFY=true.
-- Crafted event id: evt_test_idemp_i3_001
-- Crafted session id: cs_test_i3_idemp_001
-- PROTECTED TABLE: inserts into payments — requires explicit approval before execution.
-- Do NOT insert payment_events or booking_beds.

INSERT INTO bookings (
  id,
  client_id,
  booking_code,
  guest_name,
  phone,
  email,
  status,
  payment_status,
  check_in,
  check_out,
  guest_count,
  send_confirmation,
  booking_source,
  total_amount_cents,
  deposit_required_cents
) VALUES (
  'b35c0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'WH-35C-I3-TEST-1',
  'I3 Idemp Test Guest',
  '+10000000035',
  'i3test@example.invalid',
  'payment_pending',
  'not_requested',
  CURRENT_DATE + INTERVAL '60 days',
  CURRENT_DATE + INTERVAL '63 days',
  1,
  FALSE,
  'whatsapp',
  20000,
  10000
);

-- PROTECTED TABLE INSERT — requires explicit approval
INSERT INTO payments (
  id,
  client_id,
  booking_id,
  status,
  payment_kind,
  amount_due_cents,
  stripe_checkout_session_id,
  currency
) VALUES (
  'a35c0000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  'b35c0000-0000-4000-8000-000000000001',
  'checkout_created',
  'deposit_only',
  10000,
  'cs_test_i3_idemp_001',
  'EUR'
);
