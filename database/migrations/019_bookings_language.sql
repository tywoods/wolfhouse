-- Persist guest language on bookings (confirmation copy + staff drawer).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en';

UPDATE bookings
   SET language = COALESCE(
     NULLIF(TRIM(metadata->>'language'), ''),
     NULLIF(TRIM(metadata->>'guest_language'), ''),
     'en'
   )
 WHERE language IS NULL
    OR language = 'en';
