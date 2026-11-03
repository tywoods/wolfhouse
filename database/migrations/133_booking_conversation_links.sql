BEGIN;

CREATE TABLE IF NOT EXISTS booking_conversation_links (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, conversation_id, booking_id),
  UNIQUE (client_id, booking_id),
  FOREIGN KEY (client_id, conversation_id) REFERENCES conversations(client_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- bookings.id is already globally unique.  Enforce its tenant pairing without
-- adding another unique index to the live bookings table (which would block
-- booking writes while PostgreSQL builds it).
CREATE OR REPLACE FUNCTION enforce_booking_conversation_link_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
    FROM bookings b
   WHERE b.id = NEW.booking_id
     AND b.client_id = NEW.client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'booking conversation link tenant mismatch'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_conversation_links_tenant_guard
  ON booking_conversation_links;
CREATE TRIGGER booking_conversation_links_tenant_guard
BEFORE INSERT OR UPDATE OF client_id, booking_id
ON booking_conversation_links
FOR EACH ROW EXECUTE FUNCTION enforce_booking_conversation_link_tenant();

-- Safe legacy bridge: only the explicit FK pointer is authoritative.  Metadata
-- and phone values are intentionally not used for migration ownership.
INSERT INTO booking_conversation_links (client_id, conversation_id, booking_id)
SELECT c.client_id, c.id, c.current_hold_booking_id
  FROM conversations c
  JOIN bookings b
    ON b.id = c.current_hold_booking_id
   AND b.client_id = c.client_id
 WHERE c.current_hold_booking_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE INDEX IF NOT EXISTS booking_conversation_links_conversation_idx
  ON booking_conversation_links (client_id, conversation_id, created_at, booking_id);

COMMIT;