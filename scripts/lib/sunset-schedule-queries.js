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
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
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
  sr.id::text                                 AS service_record_id,
  sr.metadata->>'slot_time'                   AS slot_time,
  sr.metadata->>'notes'                       AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'       AS staff_ui_service_type,
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
  AND sr.service_type IN ('wetsuit', 'surfboard')
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND ${sqlLocationMatch('sr', 'b', 3)}
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

module.exports = {
  getSunsetScheduleLessonsOnDateQuery,
  getSunsetScheduleGearOnDateQuery,
};
