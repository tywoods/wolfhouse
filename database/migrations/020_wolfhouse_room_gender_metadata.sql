-- Wolfhouse R1–R10 room gender metadata (allocator source of truth).
-- Fixes R4 mis-tagged as "Mixed ok" and populates room_type for all guest rooms.

UPDATE rooms r
SET
  gender_strategy = v.gender_strategy,
  room_type = v.room_type,
  can_be_matrimonial = v.can_be_matrimonial,
  often_used_by_operator = v.often_used_by_operator
FROM clients c,
(VALUES
  ('R1',  'Flexible',         'mixed',                      FALSE, FALSE),
  ('R2',  'Male preferred',   'male_only',                  FALSE, FALSE),
  ('R3',  'Flexible',         'matrimonial_or_mixed',       TRUE,  FALSE),
  ('R4',  'Male preferred',   'male_only',                  FALSE, FALSE),
  ('R5',  'Female preferred', 'female_only',                FALSE, FALSE),
  ('R6',  'Private',          'matrimonial_private_couple', TRUE,  FALSE),
  ('R7',  'Flexible',         'operator_surfweek',          FALSE, TRUE),
  ('R8',  'Female preferred', 'female_only',                FALSE, FALSE),
  ('R9',  'Flexible',         'operator_surfweek',          FALSE, TRUE),
  ('R10', 'Flexible',         'operator_surfweek',          FALSE, TRUE)
) AS v(room_code, gender_strategy, room_type, can_be_matrimonial, often_used_by_operator)
WHERE r.client_id = c.id
  AND c.slug = 'wolfhouse-somo'
  AND r.room_code = v.room_code;
