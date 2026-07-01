-- 031_customers.sql
-- Canonical, durable customer identity per (client, phone). Decoupled from
-- conversations/bookings so clearing chats/bookings never deletes the customer
-- base. Maintained automatically by a trigger on conversations + bookings, so no
-- per-tenant insert-site wiring is needed. Anchor for the upcoming waiver feature.
--
-- Idempotent + transactional (matches repo convention). Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS customers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id   TEXT,
  full_name     TEXT,
  phone         TEXT NOT NULL,
  email         TEXT,
  notes         TEXT,
  language      TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_customers_client_phone ON customers (client_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_client_location ON customers (client_id, location_id);

-- Link columns (nullable; SET NULL so wiping chats/bookings never deletes customers).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
ALTER TABLE bookings      ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;

-- Trigger: upsert the customer by (client_id, phone) and link the touched row.
CREATE OR REPLACE FUNCTION sync_customer_from_touch() RETURNS trigger AS $$
DECLARE
  v_phone text;
  v_name  text;
  v_email text;
  v_loc   text;
  v_cid   uuid;
BEGIN
  v_phone := NULLIF(TRIM(COALESCE(NEW.phone, '')), '');
  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'conversations' THEN
    v_name  := NULLIF(TRIM(COALESCE(NEW.display_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULL;
  ELSE -- bookings
    v_name  := NULLIF(TRIM(COALESCE(NEW.guest_name, '')), '');
    v_email := NULLIF(TRIM(COALESCE(NEW.email, '')), '');
    v_loc   := NULLIF(TRIM(COALESCE(NEW.metadata->>'location_id', '')), '');
  END IF;

  INSERT INTO customers (client_id, phone, full_name, email, location_id, first_seen, last_seen)
  VALUES (NEW.client_id, v_phone, v_name, v_email, v_loc, NOW(), NOW())
  ON CONFLICT (client_id, phone) DO UPDATE SET
    full_name   = COALESCE(EXCLUDED.full_name, customers.full_name),
    email       = COALESCE(EXCLUDED.email, customers.email),
    location_id = COALESCE(EXCLUDED.location_id, customers.location_id),
    last_seen   = NOW(),
    updated_at  = NOW()
  RETURNING id INTO v_cid;

  NEW.customer_id := v_cid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_customer_conversations ON conversations;
CREATE TRIGGER trg_sync_customer_conversations
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION sync_customer_from_touch();

DROP TRIGGER IF EXISTS trg_sync_customer_bookings ON bookings;
CREATE TRIGGER trg_sync_customer_bookings
  BEFORE INSERT OR UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION sync_customer_from_touch();

-- One-time backfill of existing data (no-op on an empty DB like Sunset staging).
-- Bookings first (they carry name/email/location), then conversations fill gaps.
INSERT INTO customers (client_id, phone, full_name, email, location_id, first_seen, last_seen)
SELECT b.client_id,
       TRIM(b.phone) AS phone,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(b.guest_name, '')), '') ORDER BY b.created_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(b.guest_name, '')), '') IS NOT NULL))[1] AS full_name,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(b.email, '')), '') ORDER BY b.created_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(b.email, '')), '') IS NOT NULL))[1] AS email,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(b.metadata->>'location_id', '')), '') ORDER BY b.created_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(b.metadata->>'location_id', '')), '') IS NOT NULL))[1] AS location_id,
       MIN(b.created_at), MAX(b.created_at)
FROM bookings b
WHERE NULLIF(TRIM(COALESCE(b.phone, '')), '') IS NOT NULL
GROUP BY b.client_id, TRIM(b.phone)
ON CONFLICT (client_id, phone) DO NOTHING;

INSERT INTO customers (client_id, phone, full_name, email, language, first_seen, last_seen)
SELECT conv.client_id,
       TRIM(conv.phone) AS phone,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(conv.display_name, '')), '') ORDER BY conv.updated_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(conv.display_name, '')), '') IS NOT NULL))[1] AS full_name,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(conv.email, '')), '') ORDER BY conv.updated_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(conv.email, '')), '') IS NOT NULL))[1] AS email,
       (ARRAY_AGG(NULLIF(TRIM(COALESCE(conv.language, '')), '') ORDER BY conv.updated_at DESC)
          FILTER (WHERE NULLIF(TRIM(COALESCE(conv.language, '')), '') IS NOT NULL))[1] AS language,
       MIN(conv.created_at), MAX(conv.updated_at)
FROM conversations conv
WHERE NULLIF(TRIM(COALESCE(conv.phone, '')), '') IS NOT NULL
GROUP BY conv.client_id, TRIM(conv.phone)
ON CONFLICT (client_id, phone) DO UPDATE SET
  full_name = COALESCE(customers.full_name, EXCLUDED.full_name),
  email     = COALESCE(customers.email, EXCLUDED.email),
  language  = COALESCE(customers.language, EXCLUDED.language);

-- Backfill staff notes from conversations (internal_staff_notes) into customers.notes.
UPDATE customers cu
SET notes = sub.notes
FROM (
  SELECT DISTINCT ON (conv.client_id, TRIM(conv.phone))
    conv.client_id, TRIM(conv.phone) AS phone, conv.internal_staff_notes AS notes
  FROM conversations conv
  WHERE NULLIF(TRIM(COALESCE(conv.internal_staff_notes, '')), '') IS NOT NULL
  ORDER BY conv.client_id, TRIM(conv.phone), conv.updated_at DESC
) sub
WHERE cu.client_id = sub.client_id AND cu.phone = sub.phone AND cu.notes IS NULL;

-- Link existing rows to their customer.
UPDATE conversations conv
SET customer_id = cu.id
FROM customers cu
WHERE cu.client_id = conv.client_id
  AND cu.phone = TRIM(conv.phone)
  AND conv.customer_id IS NULL
  AND NULLIF(TRIM(COALESCE(conv.phone, '')), '') IS NOT NULL;

UPDATE bookings b
SET customer_id = cu.id
FROM customers cu
WHERE cu.client_id = b.client_id
  AND cu.phone = TRIM(b.phone)
  AND b.customer_id IS NULL
  AND NULLIF(TRIM(COALESCE(b.phone, '')), '') IS NOT NULL;

COMMIT;
