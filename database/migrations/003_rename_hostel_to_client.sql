-- Phase 2a: Rename hostels → clients and hostel_id → client_id (preserves all data)
-- Safe to re-run: uses IF EXISTS / guards where possible.

BEGIN;

-- ---------------------------------------------------------------------------
-- Table rename
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS hostels RENAME TO clients;

-- Trigger on clients table
DROP TRIGGER IF EXISTS hostels_updated_at ON clients;
DROP TRIGGER IF EXISTS hostels_updated_at ON hostels;
DROP TRIGGER IF EXISTS clients_updated_at ON clients;
CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Column renames (every operational table)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'packages', 'package_price_rules', 'rooms', 'beds', 'guests', 'bookings', 'booking_beds',
    'conversations', 'messages', 'payments', 'payment_events',
    'manual_entries', 'operator_room_release_requests',
    'automation_errors', 'workflow_events'
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'hostel_id'
    ) THEN
      EXECUTE format('ALTER TABLE %I RENAME COLUMN hostel_id TO client_id', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Index renames (optional clarity; not required for function)
-- ---------------------------------------------------------------------------

ALTER INDEX IF EXISTS idx_packages_hostel RENAME TO idx_packages_client;
ALTER INDEX IF EXISTS idx_rooms_hostel RENAME TO idx_rooms_client;
ALTER INDEX IF EXISTS idx_beds_hostel_room RENAME TO idx_beds_client_room;
ALTER INDEX IF EXISTS idx_guests_hostel_phone RENAME TO idx_guests_client_phone;
ALTER INDEX IF EXISTS idx_guests_hostel_email RENAME TO idx_guests_client_email;
ALTER INDEX IF EXISTS idx_bookings_hostel_dates RENAME TO idx_bookings_client_dates;
ALTER INDEX IF EXISTS idx_bookings_hostel_status RENAME TO idx_bookings_client_status;
ALTER INDEX IF EXISTS idx_bookings_phone RENAME TO idx_bookings_client_phone;
ALTER INDEX IF EXISTS idx_bookings_hold_expires RENAME TO idx_bookings_client_hold_expires;
ALTER INDEX IF EXISTS idx_booking_beds_availability RENAME TO idx_booking_beds_availability_client;
ALTER INDEX IF EXISTS idx_conversations_hostel_status RENAME TO idx_conversations_client_status;
ALTER INDEX IF EXISTS idx_messages_whatsapp_id RENAME TO idx_messages_whatsapp_client;
ALTER INDEX IF EXISTS idx_payments_hostel_status RENAME TO idx_payments_client_status;
ALTER INDEX IF EXISTS idx_manual_entries_sync RENAME TO idx_manual_entries_client_sync;
ALTER INDEX IF EXISTS idx_operator_release_hostel_status RENAME TO idx_operator_release_client_status;
ALTER INDEX IF EXISTS idx_package_price_rules_lookup RENAME TO idx_package_price_rules_client_lookup;

-- Unique constraints / indexes on (hostel_id, ...) are updated automatically with column rename.

COMMENT ON TABLE clients IS 'Tenant / operator (surf camp, hostel, hotel, etc.) — formerly hostels';

COMMIT;
