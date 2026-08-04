-- 060_bookings_hidden.sql
-- ESSENTIAL cancel/hide model: real hidden flag on bookings.
-- Only cancelled bookings should be hidden (enforced in app layer).
-- Hidden = removed from schedule view; cancelled-but-visible stay greyed.

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bookings.hidden IS
  'Staff hide-from-schedule flag. Only cancelled bookings may be hidden. Default false.';

CREATE INDEX IF NOT EXISTS bookings_hidden_true_idx
  ON bookings (client_id, hidden)
  WHERE hidden = true;
