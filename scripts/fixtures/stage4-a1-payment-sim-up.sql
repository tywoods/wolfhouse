-- Stage 4 / A1 — payment confirmation dry-run fixture (UP)
-- Seeds one disposable booking + one disposable payment row for Gate 3 simulation.
-- Used with: Stripe Webhook Handler (STRIPE_WEBHOOK_SKIP_VERIFY=true) + Send Confirmation (local).
-- Simulated Stripe session: cs_test_dryrun_dry-ensure
-- Simulated event id:       evt_dry_run_a1_stage4_001
-- PROTECTED TABLE: inserts into bookings + payments — requires explicit approval before execution.
-- Do NOT insert payment_events or booking_beds.
-- Reversible: see stage4-a1-payment-sim-down.sql

BEGIN;

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
  package_code,
  send_confirmation,
  confirmation_sent_at,
  booking_source,
  total_amount_cents,
  deposit_required_cents
) VALUES (
  'b4000000-0000-4000-8000-a1000000001a',
  (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1),
  'DRY-STAGE4-FX-A1-001',
  'Stage4 DryRun FX Guest A1',
  '+34600099999',
  'stage4-fx-a1@example.invalid',
  'payment_pending'::booking_status,
  'unpaid'::payment_status,
  CURRENT_DATE + INTERVAL '30 days',
  CURRENT_DATE + INTERVAL '37 days',
  2,
  'uluwatu',
  FALSE,
  NULL,
  'whatsapp'::booking_source,
  69800,
  20000
);

-- PROTECTED TABLE INSERT — requires explicit approval
INSERT INTO payments (
  id,
  client_id,
  booking_id,
  status,
  payment_kind,
  amount_due_cents,
  amount_paid_cents,
  stripe_checkout_session_id,
  currency
) VALUES (
  'a4000000-0000-4000-8000-a1000000001a',
  (SELECT id FROM clients WHERE slug = 'wolfhouse-somo' LIMIT 1),
  'b4000000-0000-4000-8000-a1000000001a',
  'checkout_created',
  'deposit_only',
  20000,
  0,
  'cs_test_dryrun_dry-ensure',
  'EUR'
);

COMMIT;

-- Post-seed verification (run manually to confirm):
-- SELECT id, booking_code, status, payment_status, send_confirmation FROM bookings
--   WHERE booking_code = 'DRY-STAGE4-FX-A1-001';
-- SELECT id, status, payment_kind, amount_due_cents, stripe_checkout_session_id FROM payments
--   WHERE stripe_checkout_session_id = 'cs_test_dryrun_dry-ensure';
