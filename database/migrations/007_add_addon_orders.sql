-- Stage 5.6 / 5.6b — Add-on orders schema
-- Creates tables for structured add-on service records:
--   add_on_orders    — one record per guest add-on checkout/request
--   add_on_items     — line items per order (service type × quantity)
--   lesson_requests  — typed surfing lesson detail (requires staff scheduling)
--   yoga_requests    — typed yoga class request (on-site redemption)
--   rental_requests  — typed gear rental request (wetsuit, surfboard, etc.)
--   meal_requests    — typed dinner/meal request (5.6b)
--   transfer_requests — typed airport pickup/dropoff request (5.6b)
--
-- Design principles:
--   * Config (wolfhouse-somo.baseline.json → service_addons.service_catalog) owns prices/rules.
--   * Postgres records own who requested what, when, and whether paid/fulfilled.
--   * item_type is TEXT (config-driven, not an enum — avoids ALTER TYPE for new services).
--   * All status columns use CHECK constraints instead of ENUMs for the same reason.
--   * Migration is IDEMPOTENT via CREATE TABLE IF NOT EXISTS.
--   * No changes to existing tables.
--
-- NOT YET APPLIED — stub for Stage 5.6 / 5.6b. Apply only when approved for pilot.

BEGIN;

-- ---------------------------------------------------------------------------
-- add_on_orders
-- ---------------------------------------------------------------------------
-- One record per guest add-on checkout/request. May cover multiple line items.
-- Created by bot (whatsapp) or staff (manual). Payment truth via Stripe webhook
-- (same proven spine as main bookings). Fulfillment is staff-managed on-site.

CREATE TABLE IF NOT EXISTS add_on_orders (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id               UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  conversation_id         UUID REFERENCES conversations(id) ON DELETE SET NULL,
  payment_id              UUID REFERENCES payments(id) ON DELETE SET NULL,
  order_code              TEXT NOT NULL,
  phone                   TEXT,
  source_channel          TEXT NOT NULL DEFAULT 'whatsapp'
                          CHECK (source_channel IN ('whatsapp', 'staff', 'other')),
  language                TEXT DEFAULT 'en',
  status                  TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'pending_staff', 'payment_pending',
                                            'paid', 'cancelled', 'fulfilled')),
  payment_status          TEXT NOT NULL DEFAULT 'not_requested'
                          CHECK (payment_status IN ('not_requested', 'pending', 'paid',
                                                     'refunded', 'waived')),
  total_amount_cents      INTEGER NOT NULL DEFAULT 0 CHECK (total_amount_cents >= 0),
  currency                CHAR(3) NOT NULL DEFAULT 'EUR',
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  staff_notes             TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, order_code)
);

CREATE INDEX IF NOT EXISTS idx_addon_orders_client
  ON add_on_orders (client_id);
CREATE INDEX IF NOT EXISTS idx_addon_orders_booking
  ON add_on_orders (booking_id);
CREATE INDEX IF NOT EXISTS idx_addon_orders_status
  ON add_on_orders (client_id, status);
CREATE INDEX IF NOT EXISTS idx_addon_orders_payment_status
  ON add_on_orders (client_id, payment_status);
CREATE INDEX IF NOT EXISTS idx_addon_orders_requested_at
  ON add_on_orders (client_id, requested_at DESC);

CREATE TRIGGER addon_orders_updated_at
  BEFORE UPDATE ON add_on_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- add_on_items
-- ---------------------------------------------------------------------------
-- One row per service line item within an order.
-- item_type is a free-text service code (matches service_catalog key in config).
-- Examples: surf_lesson, yoga_class, wetsuit_rental, softtop_surfboard_rental,
--           hardboard_surfboard_rental, dinner_meal, bundle.

CREATE TABLE IF NOT EXISTS add_on_items (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                UUID NOT NULL REFERENCES add_on_orders(id) ON DELETE CASCADE,
  item_type               TEXT NOT NULL,
  item_name               TEXT,
  quantity                INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents        INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
  total_price_cents       INTEGER NOT NULL DEFAULT 0 CHECK (total_price_cents >= 0),
  service_date            DATE,
  start_date              DATE,
  end_date                DATE,
  fulfillment_status      TEXT NOT NULL DEFAULT 'requested'
                          CHECK (fulfillment_status IN ('requested', 'scheduled',
                                                         'fulfilled', 'cancelled')),
  notes                   TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_addon_items_order
  ON add_on_items (order_id);
CREATE INDEX IF NOT EXISTS idx_addon_items_type
  ON add_on_items (item_type);
CREATE INDEX IF NOT EXISTS idx_addon_items_service_date
  ON add_on_items (service_date)
  WHERE service_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_addon_items_start_date
  ON add_on_items (start_date)
  WHERE start_date IS NOT NULL;

CREATE TRIGGER addon_items_updated_at
  BEFORE UPDATE ON add_on_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- lesson_requests
-- ---------------------------------------------------------------------------
-- Typed record for surf lesson requests. Staff assigns the slot/instructor.
-- Linked to the add_on_item row and optionally to a booking.

CREATE TABLE IF NOT EXISTS lesson_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_item_id          UUID NOT NULL REFERENCES add_on_items(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  guest_count             INTEGER NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  lesson_date             DATE,
  preferred_time          TEXT,
  assigned_slot           TEXT,
  instructor              TEXT,
  scheduling_status       TEXT NOT NULL DEFAULT 'staff_required'
                          CHECK (scheduling_status IN ('staff_required', 'scheduled',
                                                        'cancelled', 'completed')),
  weather_notes           TEXT,
  staff_notes             TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lesson_requests_item
  ON lesson_requests (add_on_item_id);
CREATE INDEX IF NOT EXISTS idx_lesson_requests_booking
  ON lesson_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_lesson_requests_date
  ON lesson_requests (lesson_date)
  WHERE lesson_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lesson_requests_scheduling_status
  ON lesson_requests (scheduling_status);

CREATE TRIGGER lesson_requests_updated_at
  BEFORE UPDATE ON lesson_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- yoga_requests
-- ---------------------------------------------------------------------------
-- Typed record for yoga class requests. On-site redemption only (bot never
-- marks redeemed — staff action). Per config: yoga is booked on-site / during stay.

CREATE TABLE IF NOT EXISTS yoga_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_item_id          UUID NOT NULL REFERENCES add_on_items(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  class_date              DATE,
  quantity                INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  payment_status          TEXT NOT NULL DEFAULT 'not_requested'
                          CHECK (payment_status IN ('not_requested', 'pending', 'paid',
                                                     'refunded', 'waived')),
  fulfillment_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (fulfillment_status IN ('pending', 'redeemed', 'cancelled')),
  redeemed                BOOLEAN NOT NULL DEFAULT FALSE,
  booked_onsite           BOOLEAN NOT NULL DEFAULT TRUE,
  notes                   TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_yoga_requests_item
  ON yoga_requests (add_on_item_id);
CREATE INDEX IF NOT EXISTS idx_yoga_requests_booking
  ON yoga_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_yoga_requests_class_date
  ON yoga_requests (class_date)
  WHERE class_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_yoga_requests_fulfillment
  ON yoga_requests (fulfillment_status);

CREATE TRIGGER yoga_requests_updated_at
  BEFORE UPDATE ON yoga_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- rental_requests
-- ---------------------------------------------------------------------------
-- Typed record for gear rentals (wetsuit, softtop/hard surfboard, etc.).
-- start_date/end_date define the rental window. Pickup/return tracked by staff.

CREATE TABLE IF NOT EXISTS rental_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_item_id          UUID NOT NULL REFERENCES add_on_items(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  rental_type             TEXT NOT NULL,
  start_date              DATE,
  end_date                DATE,
  quantity                INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  pickup_status           TEXT NOT NULL DEFAULT 'requested'
                          CHECK (pickup_status IN ('requested', 'active', 'returned', 'cancelled')),
  deposit_required        BOOLEAN NOT NULL DEFAULT FALSE,
  notes                   TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS idx_rental_requests_item
  ON rental_requests (add_on_item_id);
CREATE INDEX IF NOT EXISTS idx_rental_requests_booking
  ON rental_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_rental_requests_type
  ON rental_requests (rental_type);
CREATE INDEX IF NOT EXISTS idx_rental_requests_dates
  ON rental_requests (start_date, end_date)
  WHERE start_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rental_requests_pickup_status
  ON rental_requests (pickup_status);

CREATE TRIGGER rental_requests_updated_at
  BEFORE UPDATE ON rental_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- meal_requests (5.6b)
-- ---------------------------------------------------------------------------
-- Typed record for dinner/meal add-on requests. Staff confirms and serves.
-- meal_type is TEXT (config-driven: dinner, breakfast, lunch, other).

CREATE TABLE IF NOT EXISTS meal_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_item_id          UUID NOT NULL REFERENCES add_on_items(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  meal_type               TEXT NOT NULL DEFAULT 'dinner'
                          CHECK (meal_type IN ('dinner', 'breakfast', 'lunch', 'other')),
  meal_date               DATE,
  guest_count             INTEGER NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  dietary_notes           TEXT,
  service_status          TEXT NOT NULL DEFAULT 'requested'
                          CHECK (service_status IN ('requested', 'confirmed', 'served', 'cancelled')),
  notes                   TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meal_requests_item
  ON meal_requests (add_on_item_id);
CREATE INDEX IF NOT EXISTS idx_meal_requests_booking
  ON meal_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_meal_requests_date
  ON meal_requests (meal_date)
  WHERE meal_date IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meal_requests_service_status
  ON meal_requests (service_status);

CREATE TRIGGER meal_requests_updated_at
  BEFORE UPDATE ON meal_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- transfer_requests (5.6b)
-- ---------------------------------------------------------------------------
-- Typed record for airport pickup/dropoff requests. Staff assigns driver/vehicle.
-- transfer_type: airport_pickup (arrival) or airport_dropoff (departure) or other.

CREATE TABLE IF NOT EXISTS transfer_requests (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  add_on_item_id          UUID NOT NULL REFERENCES add_on_items(id) ON DELETE CASCADE,
  booking_id              UUID REFERENCES bookings(id) ON DELETE SET NULL,
  transfer_type           TEXT NOT NULL DEFAULT 'airport_pickup'
                          CHECK (transfer_type IN ('airport_pickup', 'airport_dropoff', 'other')),
  airport                 TEXT,
  flight_number           TEXT,
  arrival_datetime        TIMESTAMPTZ,
  departure_datetime      TIMESTAMPTZ,
  pickup_location         TEXT,
  dropoff_location        TEXT,
  guest_count             INTEGER NOT NULL DEFAULT 1 CHECK (guest_count > 0),
  driver_status           TEXT NOT NULL DEFAULT 'requested'
                          CHECK (driver_status IN ('requested', 'assigned', 'confirmed',
                                                    'completed', 'cancelled')),
  notes                   TEXT,
  metadata                JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transfer_requests_item
  ON transfer_requests (add_on_item_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_booking
  ON transfer_requests (booking_id);
CREATE INDEX IF NOT EXISTS idx_transfer_requests_arrival
  ON transfer_requests (arrival_datetime)
  WHERE arrival_datetime IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_requests_departure
  ON transfer_requests (departure_datetime)
  WHERE departure_datetime IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transfer_requests_driver_status
  ON transfer_requests (driver_status);

CREATE TRIGGER transfer_requests_updated_at
  BEFORE UPDATE ON transfer_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
