/**
 * Phase 3b.4c — n8n Postgres node SQL for Manual Entries local fork.
 * Keep in sync with scripts/lib/manual-entry-pg-sql.js
 * (deleteBedsAndCancelBooking, updateBookingFields / buildBookingFieldDiff).
 */
const CLIENT_SLUG = 'wolfhouse-somo';

/** Mirrors manual-entry-pg-sql.js deleteBedsAndCancelBooking + impact-plan booking lookup. */
const PG_MANUAL_ENTRY_DELETE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    NULLIF(trim($3), '__NULL__') AS manual_entry_id
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.status::text AS status,
    b.payment_status::text AS payment_status,
    c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
      OR (p.manual_entry_id IS NOT NULL AND b.metadata->>'manual_entry_id' = p.manual_entry_id)
    )
  LIMIT 2
),
resolved_count AS (
  SELECT COUNT(*)::int AS c FROM resolved
),
guard AS (
  SELECT r.*
  FROM resolved r
  WHERE (SELECT c FROM resolved_count) = 1
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments p
  INNER JOIN guard g ON p.booking_id = g.id AND p.client_id = g.client_id
),
beds_before AS (
  SELECT COUNT(*)::int AS c
  FROM booking_beds bb
  INNER JOIN guard g ON bb.booking_id = g.id AND bb.client_id = g.client_id
),
deleted AS (
  DELETE FROM booking_beds bb
  USING guard g
  WHERE bb.booking_id = g.id AND bb.client_id = g.client_id
  RETURNING bb.id
),
updated AS (
  UPDATE bookings b
  SET
    status = 'cancelled'::booking_status,
    assignment_status = 'needs_review'::assignment_status,
    availability_check_status = 'needs_review'::availability_check_status
  FROM guard g
  WHERE b.id = g.id AND b.client_id = g.client_id
  RETURNING b.id, b.status::text AS status_after
)
SELECT
  rc.c AS booking_rows_resolved,
  g.booking_code,
  g.id::text AS booking_id,
  g.status AS status_before,
  COALESCE((SELECT status_after FROM updated LIMIT 1), g.status) AS status_after,
  g.payment_status AS payment_status_before,
  (SELECT payment_status::text FROM bookings WHERE id = g.id) AS payment_status_after,
  (SELECT c FROM beds_before) AS beds_before_count,
  (SELECT COUNT(*)::int FROM deleted) AS pg_deleted_count,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  (SELECT c FROM payments_before) AS payments_count
FROM resolved_count rc
LEFT JOIN guard g ON true`;

/**
 * Mirrors manual-entry-pg-sql.js updateBookingFields + impact-plan buildBookingFieldDiff.
 * Booking fields only; no booking_beds. Params $1–$3 resolve; $4–$13 are proposed values (__NULL__ = skip).
 */
const PG_MANUAL_ENTRY_UPDATE_SQL = `WITH params AS (
  SELECT
    NULLIF(trim($1), '__NULL__') AS airtable_record_id,
    NULLIF(trim($2), '__NULL__') AS booking_code,
    NULLIF(trim($3), '__NULL__') AS manual_entry_id,
    NULLIF(trim($4), '__NULL__') AS guest_name,
    NULLIF(trim($5), '__NULL__')::date AS check_in,
    NULLIF(trim($6), '__NULL__')::date AS check_out,
    NULLIF(NULLIF(trim($7), '__NULL__'), '')::int AS guest_count,
    NULLIF(trim($8), '__NULL__') AS status,
    NULLIF(trim($9), '__NULL__') AS payment_status,
    NULLIF(trim($10), '__NULL__') AS package_code,
    NULLIF(trim($11), '__NULL__') AS phone,
    NULLIF(trim($12), '__NULL__') AS email,
    NULLIF(trim($13), '__NULL__') AS notes
),
resolved AS (
  SELECT
    b.id,
    b.booking_code,
    b.guest_name,
    b.check_in,
    b.check_out,
    b.guest_count,
    b.status::text AS status,
    b.payment_status::text AS payment_status,
    b.package_code,
    b.phone,
    b.email,
    b.staff_notes,
    c.id AS client_id
  FROM bookings b
  INNER JOIN clients c ON c.id = b.client_id
  CROSS JOIN params p
  WHERE c.slug = '${CLIENT_SLUG}'
    AND (
      (p.airtable_record_id IS NOT NULL AND b.airtable_record_id = p.airtable_record_id)
      OR (p.booking_code IS NOT NULL AND b.booking_code = p.booking_code)
      OR (p.manual_entry_id IS NOT NULL AND b.metadata->>'manual_entry_id' = p.manual_entry_id)
    )
  LIMIT 2
),
resolved_count AS (
  SELECT COUNT(*)::int AS c FROM resolved
),
guard AS (
  SELECT r.*, p.manual_entry_id AS p_manual_entry_id
  FROM resolved r
  CROSS JOIN params p
  WHERE (SELECT c FROM resolved_count) = 1
),
payments_before AS (
  SELECT COUNT(*)::int AS c
  FROM payments pay
  INNER JOIN guard g ON pay.booking_id = g.id AND pay.client_id = g.client_id
),
diff AS (
  SELECT
    g.id AS booking_id,
    g.client_id,
    g.booking_code,
    g.p_manual_entry_id,
    g.payment_status AS payment_status_before,
    (p.guest_name IS NOT NULL AND p.guest_name IS DISTINCT FROM g.guest_name) AS ch_guest_name,
    (p.check_in IS NOT NULL AND p.check_in IS DISTINCT FROM g.check_in) AS ch_check_in,
    (p.check_out IS NOT NULL AND p.check_out IS DISTINCT FROM g.check_out) AS ch_check_out,
    (p.guest_count IS NOT NULL AND p.guest_count IS DISTINCT FROM g.guest_count) AS ch_guest_count,
    (p.status IS NOT NULL AND p.status IS DISTINCT FROM g.status) AS ch_status,
    (p.payment_status IS NOT NULL AND p.payment_status IS DISTINCT FROM g.payment_status) AS ch_payment_status,
    (p.package_code IS NOT NULL AND p.package_code IS DISTINCT FROM g.package_code) AS ch_package_code,
    (p.phone IS NOT NULL AND p.phone IS DISTINCT FROM COALESCE(g.phone, '')) AS ch_phone,
    (p.email IS NOT NULL AND p.email IS DISTINCT FROM COALESCE(g.email, '')) AS ch_email,
    (p.notes IS NOT NULL AND trim(p.notes) <> '') AS ch_notes
  FROM guard g
  CROSS JOIN params p
),
has_change AS (
  SELECT
    d.*,
    (
      d.ch_guest_name OR d.ch_check_in OR d.ch_check_out OR d.ch_guest_count
      OR d.ch_status OR d.ch_payment_status OR d.ch_package_code
      OR d.ch_phone OR d.ch_email OR d.ch_notes
    ) AS any_change
  FROM diff d
),
updated AS (
  UPDATE bookings b
  SET
    guest_name = CASE WHEN h.ch_guest_name THEN p.guest_name ELSE b.guest_name END,
    check_in = CASE WHEN h.ch_check_in THEN p.check_in ELSE b.check_in END,
    check_out = CASE WHEN h.ch_check_out THEN p.check_out ELSE b.check_out END,
    guest_count = CASE WHEN h.ch_guest_count THEN p.guest_count ELSE b.guest_count END,
    status = CASE WHEN h.ch_status THEN p.status::booking_status ELSE b.status END,
    payment_status = CASE WHEN h.ch_payment_status THEN p.payment_status::payment_status ELSE b.payment_status END,
    package_code = CASE WHEN h.ch_package_code THEN p.package_code ELSE b.package_code END,
    phone = CASE WHEN h.ch_phone THEN p.phone ELSE b.phone END,
    email = CASE WHEN h.ch_email THEN p.email ELSE b.email END,
    staff_notes = CASE
      WHEN h.ch_notes THEN
        trim(
          both E'\\n' from (
            COALESCE(b.staff_notes, '')
            || CASE
              WHEN COALESCE(b.staff_notes, '') LIKE '%' || COALESCE(h.p_manual_entry_id, '') || '%' THEN ''
              ELSE E'\\nManual Entry ID: ' || COALESCE(h.p_manual_entry_id, '')
            END
            || E'\\n'
            || p.notes
          )
        )
      ELSE b.staff_notes
    END
  FROM has_change h
  CROSS JOIN params p
  WHERE b.id = h.booking_id AND b.client_id = h.client_id AND h.any_change
  RETURNING b.id, b.booking_code, b.payment_status::text AS payment_status_after
)
SELECT
  rc.c AS booking_rows_resolved,
  h.booking_code,
  h.booking_id::text AS booking_id,
  h.payment_status_before,
  COALESCE((SELECT payment_status_after FROM updated LIMIT 1), h.payment_status_before) AS payment_status_after,
  (SELECT COUNT(*)::int FROM updated) AS pg_booking_updated_count,
  CASE
    WHEN h.booking_id IS NOT NULL AND NOT COALESCE(h.any_change, false) THEN true
    ELSE false
  END AS idempotent,
  (SELECT c FROM payments_before) AS payments_count,
  (SELECT COUNT(*)::int FROM payments pay INNER JOIN guard g ON pay.booking_id = g.id) AS payments_count_after
FROM resolved_count rc
LEFT JOIN has_change h ON true`;

module.exports = {
  CLIENT_SLUG,
  PG_MANUAL_ENTRY_DELETE_SQL,
  PG_MANUAL_ENTRY_UPDATE_SQL,
};
