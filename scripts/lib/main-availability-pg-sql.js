/**
 * Phase 3c.b — Main booking flow availability (read-only).
 * Overlap semantics aligned with scripts/lib/assign-booking-beds-plan.js (3b.2a/3b.2b).
 */
const { toIsoDateString } = require('./bed-drift-keys');
const { roomCodeFromBedCode } = require('./assign-booking-beds-plan');

/** Same exclusion set as assign/reassign impact reports. */
const OVERLAP_BOOKING_STATUS_EXCLUDE = ['cancelled', 'expired'];

function normalizeSelect(value, fallback = 'unknown') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function parseSessionInput(raw = {}) {
  const checkIn = toIsoDateString(raw.check_in ?? raw.checkIn);
  const checkOut = toIsoDateString(raw.check_out ?? raw.checkOut);
  const guestCountRaw = raw.guest_count ?? raw.guestCount ?? raw.guests ?? 1;
  const guestCount = Math.max(1, Number(guestCountRaw) || 1);

  const roomType = normalizeSelect(raw.room_type ?? raw.roomType ?? 'shared', 'shared');
  const roomPreference = normalizeSelect(
    raw.room_preference ?? raw.roomPreference ?? roomType,
    roomType || 'shared'
  );
  const guestGenderGroup = normalizeSelect(
    raw.guest_gender_group_type ?? raw.guestGenderGroupType ?? 'unknown',
    'unknown'
  );
  const genderStrategy = raw.gender_strategy ?? raw.genderStrategy ?? null;

  return {
    client_slug: String(raw.client_slug ?? raw.clientSlug ?? 'wolfhouse-somo').trim(),
    check_in: checkIn,
    check_out: checkOut,
    guest_count: guestCount,
    room_type: roomType,
    room_preference: roomPreference,
    guest_gender_group_type: guestGenderGroup,
    gender_strategy: genderStrategy ? normalizeSelect(genderStrategy, '') : null,
    exclude_booking_id: raw.exclude_booking_id ?? raw.excludeBookingId ?? null,
  };
}

function roomMatchesType(room, requestedType) {
  const rt = normalizeSelect(requestedType, 'any');
  if (rt === 'any') return true;
  const roomTypeField = normalizeSelect(room.room_type, '');
  const cap = Number(room.capacity) || 0;
  if (rt === 'private') {
    return cap <= 1 || roomTypeField.includes('private') || room.private_priority >= 80;
  }
  if (rt === 'shared') {
    return cap > 1 || roomTypeField.includes('shared') || roomTypeField.includes('dorm');
  }
  return true;
}

function genderStrategyAllows(room, guestGenderGroup, explicitStrategy) {
  const strategy = normalizeSelect(explicitStrategy || room.gender_strategy, 'flexible');
  if (strategy === 'flexible' || strategy === 'unknown') return true;
  const group = normalizeSelect(guestGenderGroup, 'unknown');
  if (group === 'unknown') return true;
  if (strategy.includes('female') && group.includes('male') && !group.includes('female')) {
    return false;
  }
  if (strategy.includes('male') && group.includes('female') && !group.includes('male')) {
    return false;
  }
  return true;
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseSessionInput>} input
 */
async function runMainAvailabilityReport(client, input) {
  if (!input.check_in || !input.check_out) {
    return { error: 'missing_dates', parsed_input: input };
  }
  if (input.check_out <= input.check_in) {
    return { error: 'invalid_date_range', parsed_input: input, check_in: input.check_in, check_out: input.check_out };
  }

  const { rows: clientRows } = await client.query(`SELECT id, slug FROM clients WHERE slug = $1`, [
    input.client_slug,
  ]);
  if (!clientRows.length) {
    return { error: 'client_not_found', parsed_input: input, client_slug: input.client_slug };
  }
  const clientId = clientRows[0].id;

  const { rows: roomRows } = await client.query(
    `SELECT
       r.id AS room_id,
       r.room_code,
       r.name AS room_name,
       r.room_type,
       r.capacity,
       r.fill_priority,
       r.private_priority,
       r.gender_strategy,
       r.can_be_matrimonial,
       r.often_used_by_operator,
       r.active AS room_active
     FROM rooms r
     WHERE r.client_id = $1 AND r.active = true
     ORDER BY r.fill_priority ASC, r.room_code ASC`,
    [clientId]
  );

  const { rows: bedRows } = await client.query(
    `SELECT
       b.id AS bed_id,
       b.bed_code,
       b.bed_label,
       b.active AS bed_active,
       b.sellable,
       r.id AS room_id,
       r.room_code,
       r.name AS room_name,
       r.room_type,
       r.capacity,
       r.fill_priority,
       r.private_priority,
       r.gender_strategy,
       r.can_be_matrimonial,
       r.often_used_by_operator
     FROM beds b
     INNER JOIN rooms r ON r.id = b.room_id AND r.client_id = b.client_id
     WHERE b.client_id = $1
       AND b.active = true
       AND b.sellable = true
       AND r.active = true
     ORDER BY r.fill_priority ASC, b.bed_code ASC`,
    [clientId]
  );

  const overlapParams = [clientId, input.check_in, input.check_out];
  let overlapSql = `SELECT
       bb.id::text AS booking_bed_id,
       bb.bed_id,
       bd.bed_code,
       r.room_code,
       b.id AS booking_id,
       b.booking_code,
       b.status::text AS booking_status,
       bb.assignment_start_date::text AS assignment_start_date,
       bb.assignment_end_date::text AS assignment_end_date
     FROM booking_beds bb
     INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
     INNER JOIN beds bd ON bd.id = bb.bed_id AND bd.client_id = bb.client_id
     INNER JOIN rooms r ON r.id = bd.room_id AND r.client_id = bd.client_id
     WHERE bb.client_id = $1
       AND bb.assignment_start_date < $3::date
       AND bb.assignment_end_date > $2::date
       AND b.status NOT IN ('cancelled', 'expired')`;

  if (input.exclude_booking_id) {
    overlapParams.push(input.exclude_booking_id);
    overlapSql += ` AND bb.booking_id <> $${overlapParams.length}::uuid`;
  }

  overlapSql += ' ORDER BY bd.bed_code, b.booking_code';

  const { rows: overlapRows } = await client.query(overlapSql, overlapParams);

  const blockedByBedId = new Map();
  const overlapConflicts = [];

  for (const row of overlapRows) {
    const bedId = row.bed_id;
    if (!blockedByBedId.has(bedId)) {
      blockedByBedId.set(bedId, []);
    }
    const conflict = {
      bed_code: String(row.bed_code || '').toUpperCase(),
      room_code: row.room_code,
      conflicting_booking_code: row.booking_code,
      conflicting_booking_bed_id: row.booking_bed_id,
      conflicting_booking_status: row.booking_status,
      conflicting_dates: {
        start: toIsoDateString(row.assignment_start_date),
        end: toIsoDateString(row.assignment_end_date),
      },
      proposed_dates: { start: input.check_in, end: input.check_out },
    };
    blockedByBedId.get(bedId).push(conflict);
    overlapConflicts.push(conflict);
  }

  const availableBeds = [];
  const blockedBeds = [];

  for (const bed of bedRows) {
    const bedCode = String(bed.bed_code || '').trim().toUpperCase();
    const conflicts = blockedByBedId.get(bed.bed_id) || [];
    const entry = {
      bed_id: bed.bed_id,
      bed_code: bedCode,
      room_code: bed.room_code,
      room_name: bed.room_name,
      bed_label: bed.bed_label,
      fill_priority: bed.fill_priority,
      overlap_count: conflicts.length,
    };
    if (conflicts.length) {
      blockedBeds.push({ ...entry, conflicts });
    } else {
      availableBeds.push(entry);
    }
  }

  const bedsByRoom = new Map();
  for (const bed of bedRows) {
    if (!bedsByRoom.has(bed.room_code)) bedsByRoom.set(bed.room_code, []);
    bedsByRoom.get(bed.room_code).push(bed);
  }

  const candidateRooms = [];
  const roomCapacitySummary = [];
  const warnings = [];

  for (const room of roomRows) {
    const roomBeds = bedsByRoom.get(room.room_code) || [];
    const sellableCount = roomBeds.length;
    const freeBeds = availableBeds.filter((b) => b.room_code === room.room_code);
    const blockedInRoom = blockedBeds.filter((b) => b.room_code === room.room_code);
    const matchesType = roomMatchesType(room, input.room_preference);
    const matchesGender = genderStrategyAllows(
      room,
      input.guest_gender_group_type,
      input.gender_strategy
    );
    const fitsGuestCount = freeBeds.length >= input.guest_count;

    const summary = {
      room_code: room.room_code,
      room_name: room.room_name,
      capacity: room.capacity,
      sellable_beds: sellableCount,
      free_beds: freeBeds.length,
      blocked_beds: blockedInRoom.length,
      fill_priority: room.fill_priority,
      gender_strategy: room.gender_strategy,
      room_type: room.room_type,
      matches_room_preference: matchesType,
      matches_gender_strategy: matchesGender,
      fits_guest_count: fitsGuestCount,
    };
    roomCapacitySummary.push(summary);

    if (!matchesType) continue;
    if (!matchesGender) continue;
    if (!fitsGuestCount) continue;

    candidateRooms.push({
      ...summary,
      available_bed_codes: freeBeds.map((b) => b.bed_code),
      score: room.fill_priority,
    });
  }

  candidateRooms.sort((a, b) => a.score - b.score || a.room_code.localeCompare(b.room_code));

  const availabilityFound = candidateRooms.length > 0;

  let recommendedRoomOrBeds = null;
  if (candidateRooms.length) {
    const best = candidateRooms[0];
    recommendedRoomOrBeds = {
      room_code: best.room_code,
      room_name: best.room_name,
      bed_codes: best.available_bed_codes.slice(0, input.guest_count),
      guest_count: input.guest_count,
      note: 'PG heuristic: lowest fill_priority room with enough free beds; not full Main JS scoring',
    };
  }

  if (!bedRows.length) {
    warnings.push('no_active_sellable_beds_in_pg');
  }
  if (bedRows.length && !availabilityFound) {
    warnings.push('no_room_fits_guest_count_and_preferences');
  }
  if (overlapConflicts.length) {
    warnings.push(`overlap_conflicts_in_window: ${overlapConflicts.length}`);
  }

  const parityNotes = [
    'Overlap uses booking_beds date intersection with assignment_start_date < check_out AND assignment_end_date > check_in.',
    `Booking status filter: NOT IN (${OVERLAP_BOOKING_STATUS_EXCLUDE.map((s) => `'${s}'`).join(', ')}) — same as 3b assign-impact.`,
    'Main Airtable Search Existing Bed Assignments filters Hold/Confirmed/Checked_In/Blocked via linked booking status — PG may block on additional statuses (e.g. payment_pending) until aligned.',
    'Main Code - Check Bed Availability - WA applies fill_priority, gender, matrimonial, operator-room, and multi-room rules in JS — this report uses simplified room/bed filters only.',
    'Nearby date alternatives (Code - Check Nearby Availability) are not computed in 3c.b.',
  ];

  const actionable = [];
  if (!availabilityFound) actionable.push('no_availability');

  return {
    client_id: clientId,
    client_slug: input.client_slug,
    parsed_input: input,
    availability_found: availabilityFound,
    candidate_rooms: candidateRooms,
    available_beds: availableBeds,
    blocked_beds: blockedBeds,
    overlap_conflicts: overlapConflicts,
    room_capacity_summary: roomCapacitySummary,
    recommended_room_or_beds: recommendedRoomOrBeds,
    warnings,
    actionable,
    parity_notes_with_main_airtable_logic: parityNotes,
    overlap_semantics: {
      date_range: { check_in: input.check_in, check_out: input.check_out },
      booking_status_exclude: OVERLAP_BOOKING_STATUS_EXCLUDE,
      exclude_booking_id: input.exclude_booking_id,
    },
    inventory: {
      active_rooms: roomRows.length,
      active_sellable_beds: bedRows.length,
      overlap_rows: overlapRows.length,
    },
    read_only: true,
    no_mutations: true,
  };
}

const NULL_SENTINEL = '__NULL__';
const CLIENT_SLUG = 'wolfhouse-somo';

/**
 * SELECT-only gate query for n8n (3c.e.3). Overlap semantics match runMainAvailabilityReport.
 * Parameters: $1 check_in, $2 check_out, $3 guest_count, $4 room_preference, $5 guest_gender_group_type.
 * @returns {string}
 */
function buildMainAvailabilityGateN8nSql() {
  const statusExclude = OVERLAP_BOOKING_STATUS_EXCLUDE.map((s) => `'${s}'`).join(', ');
  return `WITH params AS (
  SELECT
    NULLIF($1, '${NULL_SENTINEL}')::date AS check_in,
    NULLIF($2, '${NULL_SENTINEL}')::date AS check_out,
    GREATEST(
      1,
      COALESCE(
        CASE
          WHEN NULLIF(trim(NULLIF($3, '${NULL_SENTINEL}')::text), '') IS NULL THEN 1
          ELSE NULLIF(trim(NULLIF($3, '${NULL_SENTINEL}')::text), '')::integer
        END,
        1
      )
    ) AS guest_count,
    lower(coalesce(NULLIF($4, '${NULL_SENTINEL}'), 'shared')) AS room_preference,
    lower(coalesce(NULLIF($5, '${NULL_SENTINEL}'), 'unknown')) AS guest_gender_group_type,
    (
      lower(coalesce(NULLIF($4, '${NULL_SENTINEL}'), '')) IN (
        'private', 'private_room', 'double', 'family_room', 'family', 'couple_private'
      )
      OR lower(coalesce(NULLIF($4, '${NULL_SENTINEL}'), '')) LIKE '%private%'
    ) AS private_requested,
    (
      lower(coalesce(NULLIF($4, '${NULL_SENTINEL}'), '')) = 'female_only'
      OR lower(coalesce(NULLIF($5, '${NULL_SENTINEL}'), '')) IN ('female_group', 'solo_female')
    ) AS female_requested,
    (
      lower(coalesce(NULLIF($4, '${NULL_SENTINEL}'), '')) = 'male_only'
      OR lower(coalesce(NULLIF($5, '${NULL_SENTINEL}'), '')) IN ('male_group', 'solo_male')
    ) AS male_requested
),
client AS (
  SELECT id FROM clients WHERE slug = '${CLIENT_SLUG}' LIMIT 1
),
invalid AS (
  SELECT 1
  FROM params p
  WHERE p.check_in IS NULL
    OR p.check_out IS NULL
    OR p.check_out <= p.check_in
),
overlap_assignments AS (
  SELECT bb.id AS booking_bed_id, bb.bed_id
  FROM booking_beds bb
  INNER JOIN bookings b ON b.id = bb.booking_id AND b.client_id = bb.client_id
  CROSS JOIN params p
  CROSS JOIN client c
  WHERE bb.client_id = c.id
    AND bb.assignment_start_date < p.check_out
    AND bb.assignment_end_date > p.check_in
    AND b.status NOT IN (${statusExclude})
),
overlap_beds AS (
  SELECT DISTINCT bed_id FROM overlap_assignments
),
sellable_beds AS (
  SELECT
    b.id AS bed_id,
    upper(trim(b.bed_code)) AS bed_code,
    r.room_code,
    r.name AS room_name,
    r.room_type,
    r.capacity,
    r.fill_priority,
    r.gender_strategy
  FROM beds b
  INNER JOIN rooms r ON r.id = b.room_id AND r.client_id = b.client_id
  CROSS JOIN client c
  WHERE b.client_id = c.id
    AND b.active = true
    AND b.sellable = true
    AND r.active = true
),
free_beds AS (
  SELECT sb.*
  FROM sellable_beds sb
  WHERE NOT EXISTS (SELECT 1 FROM overlap_beds ob WHERE ob.bed_id = sb.bed_id)
),
room_agg AS (
  SELECT
    fb.room_code,
    max(fb.room_name) AS room_name,
    max(fb.capacity) AS capacity,
    max(fb.room_type) AS room_type,
    max(fb.gender_strategy) AS gender_strategy,
    min(fb.fill_priority) AS fill_priority,
    count(*)::int AS free_bed_count
  FROM free_beds fb
  GROUP BY fb.room_code
),
candidate_rooms AS (
  SELECT ra.*
  FROM room_agg ra
  CROSS JOIN params p
  WHERE ra.free_bed_count >= p.guest_count
    AND (
      CASE
        WHEN p.private_requested THEN
          ra.capacity <= 1
          OR lower(coalesce(ra.room_type, '')) LIKE '%private%'
          OR lower(coalesce(ra.gender_strategy, '')) LIKE '%private%'
        WHEN p.female_requested THEN
          lower(coalesce(ra.gender_strategy, '')) LIKE '%female%'
          OR lower(coalesce(ra.gender_strategy, '')) LIKE '%women%'
          OR lower(coalesce(ra.gender_strategy, '')) LIKE '%woman%'
        WHEN p.male_requested THEN
          lower(coalesce(ra.gender_strategy, '')) LIKE '%male%'
          OR lower(coalesce(ra.gender_strategy, '')) LIKE '%men%'
          OR lower(coalesce(ra.gender_strategy, '')) LIKE '%man%'
        ELSE
          NOT (
            ra.capacity <= 1
            OR lower(coalesce(ra.room_type, '')) LIKE '%private%'
            OR lower(coalesce(ra.gender_strategy, '')) LIKE '%private%'
          )
      END
    )
),
best_room AS (
  SELECT room_code, room_name, free_bed_count, fill_priority
  FROM candidate_rooms
  ORDER BY fill_priority ASC NULLS LAST, room_code ASC
  LIMIT 1
),
counts AS (
  SELECT
    (SELECT count(*)::int FROM free_beds) AS available_bed_count,
    (SELECT count(*)::int FROM overlap_beds) AS blocked_bed_count,
    (SELECT count(*)::int FROM overlap_assignments) AS overlap_conflict_count
),
gate AS (
  SELECT
    EXISTS (SELECT 1 FROM invalid) AS invalid_params,
    EXISTS (SELECT 1 FROM best_room) AS single_room_found,
    (SELECT guest_count FROM params) AS guest_count,
    (SELECT private_requested FROM params) AS private_requested,
    (SELECT available_bed_count FROM counts) AS available_bed_count
)
SELECT
  true AS pg_query_ok,
  CASE
    WHEN g.invalid_params THEN false
    WHEN g.single_room_found THEN true
    WHEN NOT g.private_requested AND g.available_bed_count >= g.guest_count THEN true
    ELSE false
  END AS availability_found,
  br.room_code AS primary_room_code,
  br.room_name AS primary_room_name,
  c.available_bed_count,
  c.blocked_bed_count,
  c.overlap_conflict_count,
  CASE
    WHEN g.invalid_params THEN false
    WHEN g.single_room_found THEN false
    WHEN NOT g.private_requested AND g.available_bed_count >= g.guest_count THEN true
    ELSE false
  END AS multi_room_required,
  CASE
    WHEN EXISTS (SELECT 1 FROM invalid) THEN '["missing_or_invalid_dates"]'::jsonb
    WHEN EXISTS (SELECT 1 FROM best_room)
      OR (NOT (SELECT private_requested FROM params) AND c.available_bed_count >= (SELECT guest_count FROM params))
      THEN '[]'::jsonb
    ELSE '["no_availability"]'::jsonb
  END AS actionable
FROM gate g
CROSS JOIN counts c
LEFT JOIN best_room br ON true;`;
}

module.exports = {
  OVERLAP_BOOKING_STATUS_EXCLUDE,
  NULL_SENTINEL,
  CLIENT_SLUG,
  normalizeSelect,
  parseSessionInput,
  runMainAvailabilityReport,
  buildMainAvailabilityGateN8nSql,
  roomCodeFromBedCode,
};
