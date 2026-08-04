-- 060_bookings_hidden_down.sql
DROP INDEX IF EXISTS bookings_hidden_true_idx;
ALTER TABLE bookings DROP COLUMN IF EXISTS hidden;
