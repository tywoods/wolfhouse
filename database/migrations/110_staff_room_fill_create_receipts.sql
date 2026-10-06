-- Wolfhouse Staff room-placement create receipt.
-- Binds one operation id to the room and bed ids it created.
-- Not a booking, payment, or email table.
BEGIN;

CREATE TABLE IF NOT EXISTS staff_room_fill_create_receipts (
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  payload_fingerprint TEXT NOT NULL,
  room_id UUID NOT NULL,
  bed_ids JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (client_id, operation_id)
);

COMMIT;
