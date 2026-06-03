-- Stage 8.8.8 — Demo seed for booking_service_records (NOT applied automatically)
--
-- Purpose: Known structured rows for Ask Luna service-query proofs (Stage 8.8.9+).
-- Structured Postgres data only — never chat-log answers.
-- Safe to delete/reseed: all rows use source='demo_fixture_stage888'.
--
-- Prerequisites (manual, when approved):
--   1. Apply database/migrations/010_booking_service_records.sql
--   2. Extend source CHECK to include 'demo_fixture_stage888' if not yet in 010
--   3. Run this file explicitly: node scripts/run-sql.js scripts/fixtures/booking-service-records-demo-up.sql
--
-- Does NOT run migration 010. Does NOT run automatically on deploy.

BEGIN;

INSERT INTO booking_service_records (
  client_slug, booking_code, guest_name, service_type, service_date, quantity,
  status, amount_due_cents, amount_paid_cents, payment_status, source, notes, metadata
) VALUES
  -- today — yoga paid (who paid for yoga tonight/today)
  ('wolfhouse-somo', 'DEMO-SVC-888-YOGA-TODAY', 'Demo Yoga Guest 888',
   'yoga', CURRENT_DATE, 1,
   'paid', 1500, 1500, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — yoga paid today',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- today — surf lesson paid
  ('wolfhouse-somo', 'DEMO-SVC-888-LESSON-TODAY', 'Demo Lesson Guest 888',
   'surf_lesson', CURRENT_DATE, 1,
   'paid', 4500, 4500, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — lesson paid today',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- today — wetsuits (count: 2 + 1 = 3 on today)
  ('wolfhouse-somo', 'DEMO-SVC-888-WET-A', 'Demo Wetsuit Guest A 888',
   'wetsuit', CURRENT_DATE, 2,
   'confirmed', 3000, 0, 'pending', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — wetsuit pending today qty 2',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),
  ('wolfhouse-somo', 'DEMO-SVC-888-WET-B', 'Demo Wetsuit Guest B 888',
   'wetsuit', CURRENT_DATE, 1,
   'confirmed', 1500, 0, 'not_requested', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — wetsuit confirmed today qty 1',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- today — surfboards (count: 2 + 2 = 4 on today)
  ('wolfhouse-somo', 'DEMO-SVC-888-BOARD-A', 'Demo Board Guest A 888',
   'surfboard', CURRENT_DATE, 2,
   'confirmed', 4000, 0, 'not_requested', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — surfboard today qty 2',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),
  ('wolfhouse-somo', 'DEMO-SVC-888-BOARD-B', 'Demo Board Guest B 888',
   'surfboard', CURRENT_DATE, 2,
   'confirmed', 4000, 0, 'pending', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — surfboard pending today qty 2',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- tomorrow — meal paid
  ('wolfhouse-somo', 'DEMO-SVC-888-MEAL-TOM', 'Demo Meal Guest 888',
   'meal', CURRENT_DATE + INTERVAL '1 day', 1,
   'paid', 2500, 2500, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — meal paid tomorrow',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- tomorrow — yoga paid
  ('wolfhouse-somo', 'DEMO-SVC-888-YOGA-TOM', 'Demo Yoga Tomorrow 888',
   'yoga', CURRENT_DATE + INTERVAL '1 day', 1,
   'paid', 1500, 1500, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — yoga paid tomorrow',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),

  -- fixed date 2026-06-15 — meal + yoga + lesson paid
  ('wolfhouse-somo', 'DEMO-SVC-888-MEAL-JUN15', 'Demo Meal Jun15 888',
   'meal', '2026-06-15'::date, 2,
   'paid', 5000, 5000, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — meal paid June 15',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),
  ('wolfhouse-somo', 'DEMO-SVC-888-YOGA-JUN15', 'Demo Yoga Jun15 888',
   'yoga', '2026-06-15'::date, 1,
   'paid', 1500, 1500, 'paid', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — yoga paid June 15',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb),
  ('wolfhouse-somo', 'DEMO-SVC-888-LESSON-JUN15', 'Demo Lesson Jun15 888',
   'surf_lesson', '2026-06-15'::date, 1,
   'confirmed', 4500, 0, 'pending', 'demo_fixture_stage888',
   'Stage 8.8.8 demo — lesson pending June 15',
   '{"fixture":"booking-service-records-demo","stage":"8.8.8"}'::jsonb);

COMMIT;
