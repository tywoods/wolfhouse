BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_client_id_id_uq') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_client_id_id_uq UNIQUE (client_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS booking_conversation_links (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, conversation_id, booking_id),
  UNIQUE (client_id, booking_id),
  FOREIGN KEY (client_id, conversation_id) REFERENCES conversations(client_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY (client_id, booking_id) REFERENCES bookings(client_id, id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

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