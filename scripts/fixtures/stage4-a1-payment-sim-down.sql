-- Stage 4 / A1 — payment confirmation dry-run fixture (DOWN)
-- Removes all rows seeded by stage4-a1-payment-sim-up.sql
-- plus any payment_events / workflow_events / automation_errors
-- written during the Gate 3 runtime.
-- Safe to run multiple times (idempotent).

BEGIN;

-- Remove payment_events written during Gate 3 (Stripe webhook handler)
DELETE FROM payment_events
WHERE stripe_event_id = 'evt_dry_run_a1_stage4_001'
   OR booking_id = 'b4000000-0000-4000-8000-a1000000001a';

-- Remove workflow_events written during Gate 3 (Send Confirmation)
DELETE FROM workflow_events
WHERE booking_id = 'b4000000-0000-4000-8000-a1000000001a'
   OR payload->>'booking_code' = 'DRY-STAGE4-FX-A1-001';

-- Remove automation_errors written during Gate 3 (Send Confirmation error path)
DELETE FROM automation_errors
WHERE booking_id = 'b4000000-0000-4000-8000-a1000000001a'
   OR payload->>'booking_code' = 'DRY-STAGE4-FX-A1-001';

-- Remove payment row (uses stable id from up.sql)
DELETE FROM payments
WHERE id = 'a4000000-0000-4000-8000-a1000000001a';

-- Remove booking row (uses stable id from up.sql)
DELETE FROM bookings
WHERE id = 'b4000000-0000-4000-8000-a1000000001a';

COMMIT;

-- Post-teardown verification (run manually to confirm counts are 0):
-- SELECT COUNT(*) FROM bookings  WHERE booking_code = 'DRY-STAGE4-FX-A1-001';        -- must be 0
-- SELECT COUNT(*) FROM payments  WHERE id = 'a4000000-0000-4000-8000-a1000000001a';  -- must be 0
-- SELECT COUNT(*) FROM payment_events  WHERE stripe_event_id = 'evt_dry_run_a1_stage4_001'; -- must be 0
-- SELECT COUNT(*) FROM workflow_events WHERE booking_id = 'b4000000-0000-4000-8000-a1000000001a'; -- must be 0
-- Broad safety net: ensure no other DRY-STAGE4-FX-% rows remain
-- SELECT COUNT(*) FROM bookings WHERE booking_code LIKE 'DRY-STAGE4-FX-%';            -- must be 0
