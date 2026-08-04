'use strict';

const { sqlLocationMatch } = require('./sunset-school-locations');

function getSunsetScheduleLessonsOnDateQuery() {
  return `
SELECT
  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                     AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                             AS service_status,
  sr.payment_status::text                     AS payment_status,
  COALESCE(b.payment_status::text, '')        AS booking_payment_status,
  COALESCE(b.amount_paid_cents, 0)::int       AS booking_amount_paid_cents,
  b.balance_due_cents                         AS booking_balance_due_cents,
  EXISTS (
    SELECT 1 FROM waiver_form_requests wr
    WHERE wr.booking_id = b.id AND wr.status = 'completed'
  )                                           AS waiver_signed,
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
  sr.metadata->>'component'                   AS metadata_component,
  sr.service_time_local,
  sr.service_time_local_end,
  sr.source                                   AS record_source,
  sr.metadata,
  b.metadata                                  AS booking_metadata,
  COALESCE(sr.metadata->>'location_id', b.metadata->>'location_id') AS location_id
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.client_slug = $1
  AND sr.service_date = $2::date
  AND sr.service_type = 'surf_lesson'
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND ${sqlLocationMatch('sr', 'b', 3)}
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

function getSunsetScheduleGearOnDateQuery() {
  return `
SELECT
  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                     AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                             AS service_status,
  sr.payment_status::text                     AS payment_status,
  COALESCE(b.payment_status::text, '')        AS booking_payment_status,
  COALESCE(b.amount_paid_cents, 0)::int       AS booking_amount_paid_cents,
  b.balance_due_cents                         AS booking_balance_due_cents,
  EXISTS (
    SELECT 1 FROM waiver_form_requests wr
    WHERE wr.booking_id = b.id AND wr.status = 'completed'
  )                                           AS waiver_signed,
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
  sr.metadata->>'component'                   AS metadata_component,
  sr.service_time_local,
  sr.service_time_local_end,
  sr.source                                   AS record_source,
  sr.metadata,
  b.metadata                                  AS booking_metadata,
  COALESCE(sr.metadata->>'location_id', b.metadata->>'location_id') AS location_id
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.client_slug = $1
  AND sr.service_date = $2::date
  AND (
    -- Canonical component-lane gear (legacy board/wetsuit service types).
    sr.service_type IN ('wetsuit', 'surfboard')
    OR (
      -- Historical/service_type rental rows with an offering identity.
      sr.service_type = 'rental'
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
      AND COALESCE(sr.metadata->>'course_equipment', '') <> 'true'
    )
    OR (
      -- Standalone rental offerings: require explicit rental marker so meals
      -- and unrelated addon_service rows never enter the gear/pickups feed.
      sr.service_type = 'addon_service'
      AND (
        sr.metadata->>'rental_offering' = 'true'
        OR sr.metadata->>'generic_rental' = 'true'
      )
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
      AND COALESCE(sr.metadata->>'course_equipment', '') <> 'true'
    )
    OR (
      -- Course-owned equipment (During Course / All Day). Separate admission;
      -- never treated as standalone rental pickups by the frontend.
      sr.service_type = 'addon_service'
      AND sr.metadata->>'course_equipment' = 'true'
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
    )
  )
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND ${sqlLocationMatch('sr', 'b', 3)}
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

function getSunsetScheduleCancelledLessonsOnDateQuery() {
  return `
SELECT
  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                     AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                             AS service_status,
  sr.payment_status::text                     AS payment_status,
  COALESCE(b.payment_status::text, '')        AS booking_payment_status,
  COALESCE(b.amount_paid_cents, 0)::int       AS booking_amount_paid_cents,
  b.balance_due_cents                         AS booking_balance_due_cents,
  EXISTS (
    SELECT 1 FROM waiver_form_requests wr
    WHERE wr.booking_id = b.id AND wr.status = 'completed'
  )                                           AS waiver_signed,
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
  sr.metadata->>'component'                   AS metadata_component,
  sr.service_time_local,
  sr.service_time_local_end,
  sr.source                                   AS record_source,
  sr.metadata,
  b.metadata                                  AS booking_metadata,
  COALESCE(sr.metadata->>'location_id', b.metadata->>'location_id') AS location_id,
  b.status::text AS booking_status,
  TRUE AS schedule_ghost
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.client_slug = $1
  AND sr.service_date = $2::date
  AND sr.service_type = 'surf_lesson'
  AND sr.booking_id IS NOT NULL
  AND (
    sr.status = 'cancelled'
    OR LOWER(b.status::text) IN ('cancelled', 'canceled')
  )
  AND COALESCE(b.hidden, false) = false
  AND COALESCE(b.metadata->>'schedule_archived', '') <> 'true'
  AND COALESCE(sr.metadata->>'schedule_archived', '') <> 'true'
  AND ${sqlLocationMatch('sr', 'b', 3)}
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

function getSunsetScheduleCancelledGearOnDateQuery() {
  return `
SELECT
  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                     AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                             AS service_status,
  sr.payment_status::text                     AS payment_status,
  COALESCE(b.payment_status::text, '')        AS booking_payment_status,
  COALESCE(b.amount_paid_cents, 0)::int       AS booking_amount_paid_cents,
  b.balance_due_cents                         AS booking_balance_due_cents,
  EXISTS (
    SELECT 1 FROM waiver_form_requests wr
    WHERE wr.booking_id = b.id AND wr.status = 'completed'
  )                                           AS waiver_signed,
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
  sr.metadata->>'component'                   AS metadata_component,
  sr.service_time_local,
  sr.service_time_local_end,
  sr.source                                   AS record_source,
  sr.metadata,
  b.metadata                                  AS booking_metadata,
  COALESCE(sr.metadata->>'location_id', b.metadata->>'location_id') AS location_id,
  b.status::text AS booking_status,
  TRUE AS schedule_ghost
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.client_slug = $1
  AND sr.service_date = $2::date
  AND (
    sr.service_type IN ('wetsuit', 'surfboard')
    OR (
      sr.service_type = 'rental'
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
      AND COALESCE(sr.metadata->>'course_equipment', '') <> 'true'
    )
    OR (
      sr.service_type = 'addon_service'
      AND (
        sr.metadata->>'rental_offering' = 'true'
        OR sr.metadata->>'generic_rental' = 'true'
      )
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
      AND COALESCE(sr.metadata->>'course_equipment', '') <> 'true'
    )
    OR (
      sr.service_type = 'addon_service'
      AND sr.metadata->>'course_equipment' = 'true'
      AND NULLIF(BTRIM(sr.metadata->>'offering_key'), '') IS NOT NULL
    )
  )
  AND sr.booking_id IS NOT NULL
  AND (
    sr.status = 'cancelled'
    OR LOWER(b.status::text) IN ('cancelled', 'canceled')
  )
  AND COALESCE(b.hidden, false) = false
  AND COALESCE(b.metadata->>'schedule_archived', '') <> 'true'
  AND COALESCE(sr.metadata->>'schedule_archived', '') <> 'true'
  AND ${sqlLocationMatch('sr', 'b', 3)}
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

module.exports = {
  getSunsetScheduleLessonsOnDateQuery,
  getSunsetScheduleGearOnDateQuery,
  getSunsetScheduleCancelledLessonsOnDateQuery,
  getSunsetScheduleCancelledGearOnDateQuery,
};
