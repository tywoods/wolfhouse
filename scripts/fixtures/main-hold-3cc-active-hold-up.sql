-- Phase 3c.c.2 — Reversible active-hold guard fixture (bookings only).
-- Client: wolfhouse-somo | booking_code: WH-3C-ACTIVE-HOLD-GUARD-001
-- Idempotent: upserts only this booking_code. No booking_beds, payments, or payment_events.

BEGIN;

INSERT INTO bookings (
  client_id,
  booking_code,
  airtable_record_id,
  guest_name,
  phone,
  email,
  status,
  payment_status,
  assignment_status,
  availability_check_status,
  check_in,
  check_out,
  guest_count,
  primary_room_code,
  booking_source,
  hold_expires_at,
  send_confirmation,
  metadata
)
SELECT
  c.id,
  'WH-3C-ACTIVE-HOLD-GUARD-001',
  NULL,
  '3C Active Hold Guard Fixture',
  '+353300000001',
  NULL,
  'hold'::booking_status,
  'not_requested'::payment_status,
  'unassigned'::assignment_status,
  'available'::availability_check_status,
  '2026-08-07'::date,
  '2026-08-12'::date,
  2,
  'R3',
  'whatsapp'::booking_source,
  NOW() + INTERVAL '1 hour',
  FALSE,
  '{"fixture":"main-hold-3cc-active-hold","phase":"3c.c.2"}'::jsonb
FROM clients c
WHERE c.slug = 'wolfhouse-somo'
ON CONFLICT (client_id, booking_code) DO UPDATE SET
  guest_name = EXCLUDED.guest_name,
  phone = EXCLUDED.phone,
  status = EXCLUDED.status,
  payment_status = EXCLUDED.payment_status,
  assignment_status = EXCLUDED.assignment_status,
  availability_check_status = EXCLUDED.availability_check_status,
  check_in = EXCLUDED.check_in,
  check_out = EXCLUDED.check_out,
  guest_count = EXCLUDED.guest_count,
  primary_room_code = EXCLUDED.primary_room_code,
  booking_source = EXCLUDED.booking_source,
  hold_expires_at = EXCLUDED.hold_expires_at,
  send_confirmation = EXCLUDED.send_confirmation,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();

COMMIT;
