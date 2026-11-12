-- Remove room-level operator designation, not date-specific Tour Operator blocks.
-- Luna is the application; persisted tenant slugs here are wolfhouse-somo/sunset.
-- Source 020 + Rooms/Beds CSV inventory: R7 (4 beds), R9/R10 (6 beds)
-- are Flexible, non-matrimonial ordinary mixed rooms, NOT private couples.
-- Room type describes gender/matrimonial eligibility; selling_mode independently
-- controls shared/private/private_optional sales. Preserve it and every bed row.
BEGIN;

-- Fail closed on unrecognized eligibility metadata; capacity is not evidence of
-- private/couple use. Prevent a concurrent room edit between validation/update.
LOCK TABLE rooms IN SHARE ROW EXCLUSIVE MODE;
DO $designation_preflight$
DECLARE ambiguous_rooms text;
BEGIN
  SELECT string_agg(c.slug || '/' || r.room_code, ', ' ORDER BY c.slug, r.room_code)
    INTO ambiguous_rooms
  FROM rooms r JOIN clients c ON c.id = r.client_id
  WHERE c.slug IN ('wolfhouse-somo', 'sunset')
    AND lower(btrim(r.room_type)) IN ('operator_surfweek', 'flexible')
    AND NOT (r.can_be_matrimonial OR lower(btrim(r.gender_strategy)) IN (
      'private', 'flexible', 'anyone', 'mixed', 'mixed ok',
      'female preferred', 'female only', 'female_only',
      'male preferred', 'male only', 'male_only'));
  IF ambiguous_rooms IS NOT NULL THEN
    RAISE EXCEPTION '135 ambiguous room eligibility: %', ambiguous_rooms;
  END IF;
END $designation_preflight$;

UPDATE rooms r
SET room_type = CASE
      WHEN lower(btrim(r.room_type)) IN ('operator_surfweek', 'flexible') THEN
        CASE
          WHEN lower(btrim(r.gender_strategy)) = 'private' THEN 'matrimonial_private_couple'
          WHEN r.can_be_matrimonial THEN 'matrimonial_or_mixed'
          WHEN lower(btrim(r.gender_strategy)) IN ('female preferred', 'female only', 'female_only') THEN 'female_only'
          WHEN lower(btrim(r.gender_strategy)) IN ('male preferred', 'male only', 'male_only') THEN 'male_only'
          ELSE 'mixed'
        END
      ELSE r.room_type
    END,
    often_used_by_operator = FALSE
FROM clients c
WHERE r.client_id = c.id
  AND c.slug IN ('wolfhouse-somo', 'sunset')
  AND (lower(btrim(r.room_type)) IN ('operator_surfweek', 'flexible')
       OR r.often_used_by_operator IS TRUE);

COMMIT;
