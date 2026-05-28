/**
 * Phase 3c.c.4 — Shared Ensure Booking promote/insert SQL (Main Stripe path).
 * Aligns with scripts/build-main-local-stripe.js ensureBookingSql parameter shape.
 */
const { NULL_SENTINEL } = require('./main-booking-hold-pg-sql');

const CLIENT_SLUG = 'wolfhouse-somo';

const BLOCKED_STATUSES = ['confirmed', 'checked_in', 'cancelled', 'expired'];

const PROMOTE_TARGET = {
  status: 'payment_pending',
  payment_status: 'waiting_payment',
};

function parseEnsureInput(raw = {}) {
  const { toIsoDateString } = require('./bed-drift-keys');
  const guestCountRaw = raw.guest_count ?? raw.guestCount ?? 1;

  return {
    client_slug: String(raw.client_slug ?? raw.clientSlug ?? CLIENT_SLUG).trim(),
    booking_code: String(raw.booking_code ?? raw.bookingCode ?? '').trim(),
    guest_name: String(raw.guest_name ?? raw.guestName ?? '').trim() || null,
    phone: String(raw.phone ?? '').trim() || null,
    email: String(raw.email ?? '').trim() || null,
    check_in: toIsoDateString(raw.check_in ?? raw.checkIn),
    check_out: toIsoDateString(raw.check_out ?? raw.checkOut),
    guest_count: Math.max(1, Number(guestCountRaw) || 1),
    package_code: String(raw.package_code ?? raw.packageCode ?? '').trim() || null,
    requested_room_type: String(raw.requested_room_type ?? raw.requestedRoomType ?? 'shared').trim(),
    room_preference: String(raw.room_preference ?? raw.roomPreference ?? 'shared').trim(),
    guest_gender_group_type: String(
      raw.guest_gender_group_type ?? raw.guestGenderGroupType ?? 'unknown'
    ).trim(),
    airtable_record_id: String(raw.airtable_record_id ?? raw.airtableRecordId ?? '').trim() || null,
  };
}

function ensureQueryParams(input) {
  const nullOr = (v) => (v != null && String(v).trim() !== '' ? String(v).trim() : NULL_SENTINEL);
  return [
    nullOr(input.booking_code),
    nullOr(input.guest_name),
    nullOr(input.phone),
    nullOr(input.email),
    nullOr(input.check_in),
    nullOr(input.check_out),
    String(input.guest_count),
    nullOr(input.package_code),
    nullOr(input.requested_room_type),
    nullOr(input.room_preference),
    nullOr(input.guest_gender_group_type),
    nullOr(input.airtable_record_id),
  ];
}

/**
 * Shared Ensure promote/insert SQL (CLI uses $13 for blocked statuses; n8n inlines array).
 * @param {{ forN8n?: boolean }} [opts]
 * @returns {string}
 */
function getEnsurePromoteSql(opts = {}) {
  const { forN8n = false } = opts;
  const blockedStatusesSql = forN8n
    ? `ARRAY[${BLOCKED_STATUSES.map((s) => `'${s}'`).join(', ')}]::text[]`
    : '$13::text[]';

  return `WITH existing AS (
  SELECT
    b.id,
    b.booking_code,
    b.status::text AS status,
    b.payment_status::text AS payment_status,
    b.airtable_record_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  WHERE c.slug = '${CLIENT_SLUG}'
    AND b.booking_code = NULLIF($1, '${NULL_SENTINEL}')
  LIMIT 1
),
blocked AS (
  SELECT e.*
  FROM existing e
  WHERE e.status = ANY(${blockedStatusesSql})
),
updated AS (
  UPDATE bookings b
  SET
    guest_name = COALESCE(NULLIF($2, '${NULL_SENTINEL}'), b.guest_name),
    phone = COALESCE(NULLIF($3, '${NULL_SENTINEL}'), b.phone),
    email = COALESCE(NULLIF($4, '${NULL_SENTINEL}'), b.email),
    check_in = COALESCE(NULLIF($5, '${NULL_SENTINEL}')::date, b.check_in),
    check_out = COALESCE(NULLIF($6, '${NULL_SENTINEL}')::date, b.check_out),
    guest_count = GREATEST(
      COALESCE(
        CASE
          WHEN NULLIF($7, '${NULL_SENTINEL}') IS NULL THEN 1
          ELSE NULLIF(trim(NULLIF($7, '${NULL_SENTINEL}')::text), '')::integer
        END,
        1
      ),
      1
    ),
    package_code = COALESCE(NULLIF($8, '${NULL_SENTINEL}'), b.package_code),
    requested_room_type = COALESCE(NULLIF($9, '${NULL_SENTINEL}'), b.requested_room_type),
    room_preference = COALESCE(NULLIF($10, '${NULL_SENTINEL}'), b.room_preference),
    guest_gender_group_type = COALESCE(NULLIF($11, '${NULL_SENTINEL}'), b.guest_gender_group_type),
    airtable_record_id = COALESCE(
      b.airtable_record_id,
      NULLIF($12, '${NULL_SENTINEL}')
    ),
    status = CASE
      WHEN b.status::text = 'hold' THEN 'payment_pending'::booking_status
      ELSE b.status
    END,
    payment_status = CASE
      WHEN b.payment_status::text IN ('deposit_paid', 'paid', 'refunded', 'failed')
        THEN b.payment_status
      ELSE 'waiting_payment'::payment_status
    END,
    updated_at = NOW()
  FROM existing e
  WHERE b.id = e.id
    AND NOT EXISTS (SELECT 1 FROM blocked)
    AND e.status IN ('hold', 'payment_pending')
  RETURNING
    b.id AS booking_id,
    b.booking_code,
    false AS created,
    (e.status = 'hold') AS promoted,
    CASE
      WHEN e.status = 'hold' THEN 'promoted'
      ELSE 'refreshed'
    END AS action,
    b.status::text AS status,
    b.payment_status::text AS payment_status
),
inserted AS (
  INSERT INTO bookings (
    client_id,
    booking_code,
    airtable_record_id,
    guest_name,
    phone,
    email,
    status,
    payment_status,
    check_in,
    check_out,
    guest_count,
    package_code,
    requested_room_type,
    room_preference,
    guest_gender_group_type,
    booking_source,
    deposit_required_cents,
    send_confirmation,
    metadata
  )
  SELECT
    c.id,
    NULLIF($1, '${NULL_SENTINEL}'),
    NULLIF($12, '${NULL_SENTINEL}'),
    NULLIF($2, '${NULL_SENTINEL}'),
    NULLIF($3, '${NULL_SENTINEL}'),
    NULLIF($4, '${NULL_SENTINEL}'),
    'payment_pending'::booking_status,
    'waiting_payment'::payment_status,
    NULLIF($5, '${NULL_SENTINEL}')::date,
    NULLIF($6, '${NULL_SENTINEL}')::date,
    GREATEST(
      COALESCE(
        CASE
          WHEN NULLIF($7, '${NULL_SENTINEL}') IS NULL THEN 1
          ELSE NULLIF(trim(NULLIF($7, '${NULL_SENTINEL}')::text), '')::integer
        END,
        1
      ),
      1
    ),
    NULLIF($8, '${NULL_SENTINEL}'),
    NULLIF($9, '${NULL_SENTINEL}'),
    NULLIF($10, '${NULL_SENTINEL}'),
    NULLIF($11, '${NULL_SENTINEL}'),
    'whatsapp'::booking_source,
    NULL,
    FALSE,
    '{"source":"phase3c_ensure_booking_cli"}'::jsonb
  FROM clients c
  WHERE c.slug = '${CLIENT_SLUG}'
    AND NULLIF($1, '${NULL_SENTINEL}') IS NOT NULL
    AND NULLIF($5, '${NULL_SENTINEL}') IS NOT NULL
    AND NULLIF($6, '${NULL_SENTINEL}') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM existing)
    AND NOT EXISTS (SELECT 1 FROM blocked)
  RETURNING
    id AS booking_id,
    booking_code,
    true AS created,
    false AS promoted,
    'inserted'::text AS action,
    status::text AS status,
    payment_status::text AS payment_status
)
SELECT
  booking_id::text,
  booking_code,
  created,
  promoted,
  false AS blocked,
  action,
  status,
  payment_status
FROM updated
UNION ALL
SELECT
  booking_id::text,
  booking_code,
  created,
  promoted,
  false,
  action,
  status,
  payment_status
FROM inserted
UNION ALL
SELECT
  NULL::text AS booking_id,
  e.booking_code,
  false AS created,
  false AS promoted,
  true AS blocked,
  'blocked'::text AS action,
  NULL::text AS status,
  NULL::text AS payment_status
FROM existing e
WHERE EXISTS (SELECT 1 FROM blocked)
  AND NOT EXISTS (SELECT 1 FROM updated)
  AND NOT EXISTS (SELECT 1 FROM inserted)
UNION ALL
SELECT
  NULL::text AS booking_id,
  e.booking_code,
  false AS created,
  false AS promoted,
  true AS blocked,
  'not_promotable'::text AS action,
  NULL::text AS status,
  NULL::text AS payment_status
FROM existing e
WHERE EXISTS (SELECT 1 FROM existing)
  AND NOT EXISTS (SELECT 1 FROM blocked)
  AND e.status NOT IN ('hold', 'payment_pending')
  AND NOT EXISTS (SELECT 1 FROM updated)
  AND NOT EXISTS (SELECT 1 FROM inserted)`;
}

/** Static SQL for n8n Postgres node ($1–$12 + inlined blocked statuses). */
function buildEnsurePromoteN8nSql() {
  return getEnsurePromoteSql({ forN8n: true });
}

/**
 * @param {import('pg').Client} client
 * @param {ReturnType<typeof parseEnsureInput>} input
 */
async function ensureBookingPromote(client, input) {
  if (!input.booking_code) {
    return { error: 'missing_booking_code', input };
  }
  if (!input.check_in || !input.check_out) {
    return { error: 'missing_dates', input };
  }
  if (input.check_out <= input.check_in) {
    return { error: 'invalid_date_range', input };
  }

  const params = ensureQueryParams(input);
  const sql = getEnsurePromoteSql({ forN8n: false });

  const { rows } = await client.query(sql, [...params, BLOCKED_STATUSES]);

  if (!rows.length) {
    return { error: 'no_result', input };
  }

  const row = rows[0];
  if (row.blocked && row.action === 'not_promotable') {
    const { rows: ex } = await client.query(
      `SELECT status::text AS status FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
       WHERE c.slug = $1 AND b.booking_code = $2`,
      [CLIENT_SLUG, input.booking_code]
    );
    return {
      blocked: true,
      not_promotable: true,
      booking_code: input.booking_code,
      existing_status: ex[0]?.status,
      note: 'Status not hold/payment_pending and not in blocked list',
    };
  }

  if (row.blocked) {
    const { rows: ex } = await client.query(
      `SELECT status::text AS status, payment_status::text AS payment_status
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
       WHERE c.slug = $1 AND b.booking_code = $2`,
      [CLIENT_SLUG, input.booking_code]
    );
    return {
      blocked: true,
      booking_code: input.booking_code,
      existing_status: ex[0]?.status,
      existing_payment_status: ex[0]?.payment_status,
      blocked_statuses: BLOCKED_STATUSES,
    };
  }

  const { rows: full } = await client.query(
    `SELECT
       b.id::text AS booking_id,
       b.booking_code,
       b.status::text AS status,
       b.payment_status::text AS payment_status,
       b.airtable_record_id,
       b.send_confirmation
     FROM bookings b
     INNER JOIN clients c ON c.id = b.client_id
     WHERE c.slug = $1 AND b.booking_code = $2`,
    [CLIENT_SLUG, input.booking_code]
  );

  return {
    blocked: false,
    booking_id: row.booking_id,
    booking_code: row.booking_code,
    created: row.created === true,
    promoted: row.promoted === true,
    action: row.action,
    booking: full[0] || null,
  };
}

module.exports = {
  CLIENT_SLUG,
  BLOCKED_STATUSES,
  PROMOTE_TARGET,
  NULL_SENTINEL,
  parseEnsureInput,
  ensureQueryParams,
  getEnsurePromoteSql,
  buildEnsurePromoteN8nSql,
  ensureBookingPromote,
};
