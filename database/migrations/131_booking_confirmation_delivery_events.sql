-- DH-STAFF-1644: store WhatsApp delivered callbacks even if they arrive
-- before provider accept, so confirmation owed can reconcile in either order.
BEGIN;

CREATE TABLE IF NOT EXISTS booking_confirmation_delivery_events (
  provider_message_id TEXT PRIMARY KEY,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
