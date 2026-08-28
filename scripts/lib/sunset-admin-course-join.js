'use strict';

/**
 * Sunset admin-course discovery + assignment gates.
 *
 * Joinable courses come from tenant_surf_pack_rules. Capacity =
 * configured group_size − confirmed booking_service_records for that course on
 * the date. Standalone group-lesson slots are NOT offered to Luna. Sunset-only;
 * never invents courses.
 */

const {
  loadSurfPacksFromDb,
  packPriceItemCode,
} = require('./sunset-admin-pack-rules');
const {
  normalizeSunsetLocationId,
  isSunsetLocationId,
  sqlLocationMatch,
} = require('./sunset-school-locations');
const {
  weekdaysFromWeekly: weekdaysFromPackWeekly,
  weekdayOfIsoDate,
  datesBelongToPackSchedule,
  evaluateSunsetOfferingDates,
} = require('./sunset-offering-schedule');

const SUNSET_CLIENT_SLUG = 'sunset';

function parsePackScheduleKey(value) {
  const m = /^([01]\d|2[0-3])([0-5]\d)_([01]\d|2[0-3])([0-5]\d)$/.exec(String(value || '').trim());
  if (!m) return null;
  return {
    key: String(value).trim(),
    start_time: `${m[1]}:${m[2]}`,
    end_time: `${m[3]}:${m[4]}`,
  };
}

/**
 * Count confirmed course seats for course_id on a date at a location.
 * Mirrors get_sunset_lesson_availability counting style, filtered by course_id.
 */
async function countConfirmedCourseSeatsOnDate(pg, {
  clientSlug, locationId, courseId, serviceDate, excludeBookingId,
}) {
  const loc = normalizeSunsetLocationId(locationId);
  const excludeId = excludeBookingId ? String(excludeBookingId).trim() : null;
  const sql = `
SELECT COALESCE(SUM(CASE
         WHEN sr.quantity IS NOT NULL AND sr.quantity > 0 THEN sr.quantity
         ELSE 1
       END), 0)::int AS seats
  FROM booking_service_records sr
  INNER JOIN bookings b ON b.id = sr.booking_id
  INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND sr.client_slug = $1
   AND sr.service_date = $2::date
   AND sr.service_type = 'surf_lesson'
   AND sr.booking_id IS NOT NULL
   AND sr.status <> 'cancelled'
   AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired')
   AND COALESCE(sr.metadata->>'course_id', '') = $3
   AND ${sqlLocationMatch('sr', 'b', 4)}
   AND ($5::uuid IS NULL OR sr.booking_id <> $5::uuid)
`;
  const res = await pg.query(sql, [
    clientSlug,
    serviceDate,
    String(courseId),
    loc,
    excludeId || null,
  ]);
  return Number(res.rows[0] && res.rows[0].seats) || 0;
}

async function countConfirmedLessonSlotSeatsOnDate(pg, {
  clientSlug, locationId, slotTime, serviceDate,
}) {
  const loc = normalizeSunsetLocationId(locationId);
  const sql = `
SELECT COALESCE(SUM(CASE
         WHEN sr.quantity IS NOT NULL AND sr.quantity > 0 THEN sr.quantity
         ELSE 1
       END), 0)::int AS seats
  FROM booking_service_records sr
  INNER JOIN bookings b ON b.id = sr.booking_id
  INNER JOIN clients c ON c.id = b.client_id
 WHERE c.slug = $1
   AND sr.client_slug = $1
   AND sr.service_date = $2::date
   AND sr.service_type = 'surf_lesson'
   AND sr.booking_id IS NOT NULL
   AND sr.status <> 'cancelled'
   AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired')
   AND COALESCE(sr.metadata->>'component', sr.metadata->>'staff_ui_service_type', '') IN ('lesson', 'group_lesson')
   AND COALESCE(sr.metadata->>'slot_time', sr.service_time_local::text, '') LIKE $3
   AND ${sqlLocationMatch('sr', 'b', 4)}
`;
  const slotPrefix = `${String(slotTime || '').trim()}%`;
  const res = await pg.query(sql, [clientSlug, serviceDate, slotPrefix, loc]);
  return Number(res.rows[0] && res.rows[0].seats) || 0;
}

/**
 * Load one active admin course (surf pack) by pack_id for the location.
 */
async function loadAdminCourseById(pg, { clientSlug, locationId, courseId }) {
  if (String(clientSlug || '').trim() !== SUNSET_CLIENT_SLUG) {
    return { ok: false, error: 'tenant_mismatch' };
  }
  if (!isSunsetLocationId(locationId)) {
    return { ok: false, error: 'unknown_location' };
  }
  const packs = await loadSurfPacksFromDb(pg, clientSlug, locationId);
  const pack = (packs || []).find((p) => String(p.pack_id) === String(courseId).trim());
  if (!pack) return { ok: false, error: 'unknown_course_id' };
  return { ok: true, pack };
}

/**
 * Validate a course component against admin config before any insert.
 * Fail closed on unknown course, bad dates, or no remaining capacity.
 */
async function assertCourseAssignable(pg, {
  clientSlug, locationId, courseId, serviceDates, quantity, excludeBookingId,
}) {
  const loaded = await loadAdminCourseById(pg, { clientSlug, locationId, courseId });
  if (!loaded.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: loaded.error,
        course_id: courseId || null,
      },
    };
  }
  const pack = loaded.pack;
  const schedule = datesBelongToPackSchedule(pack, serviceDates);
  if (!schedule.ok) {
    const staffMsg = schedule.staff_error
      || require('./sunset-offering-schedule').staffFacingOfferingScheduleError(
        schedule.error,
        schedule.detail,
      );
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: (staffMsg && staffMsg.error) || schedule.error,
        reason_code: (staffMsg && staffMsg.reason_code) || schedule.error,
        course_id: pack.pack_id,
        detail: schedule.detail || null,
      },
    };
  }
  const capacity = Number(pack.group_size);
  if (!Number.isFinite(capacity) || capacity <= 0) {
    return {
      ok: false,
      status: 409,
      body: {
        success: false,
        error: 'course_capacity_not_configured',
        course_id: pack.pack_id,
      },
    };
  }
  const qty = Math.max(1, Number(quantity) || 1);
  const perDate = [];
  for (const iso of schedule.dates) {
    const booked = await countConfirmedCourseSeatsOnDate(pg, {
      clientSlug,
      locationId,
      courseId: pack.pack_id,
      serviceDate: iso,
      excludeBookingId,
    });
    const remaining = capacity - booked;
    perDate.push({
      date: iso,
      capacity,
      seats_booked: booked,
      seats_remaining: Math.max(0, remaining),
    });
    if (remaining < qty) {
      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          error: 'course_full',
          course_id: pack.pack_id,
          date: iso,
          capacity,
          seats_booked: booked,
          seats_remaining: Math.max(0, remaining),
          requested_quantity: qty,
        },
      };
    }
  }
  return {
    ok: true,
    pack,
    course_id: pack.pack_id,
    course_label: pack.label,
    capacity,
    dates: schedule.dates,
    capacity_by_date: perDate,
  };
}

/**
 * READ-ONLY discovery: joinable admin courses (+ optional group lesson slots)
 * with DB-computed remaining capacity for a date/location.
 */
async function listJoinableSunsetOfferings(pg, opts) {
  const {
    buildSunsetCatalogCommand,
    executeSunsetCatalog,
    CATALOG_CHANNELS,
  } = require('./luna-front-desk-catalog-service');

  const clientSlug = String((opts && opts.clientSlug) || SUNSET_CLIENT_SLUG).trim();
  if (clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, reason: 'tenant_mismatch', courses: [], group_lessons: [] };
  }
  const locationId = normalizeSunsetLocationId(opts && opts.locationId);
  if (!isSunsetLocationId(locationId)) {
    return { ok: false, reason: 'unknown_location', courses: [], group_lessons: [] };
  }
  const asOfDate = opts && opts.date ? String(opts.date).slice(0, 10) : null;

  const built = buildSunsetCatalogCommand({
    channel: CATALOG_CHANNELS.LUNA_WHATSAPP,
    trustedLocationId: locationId,
    transportBody: {
      date: asOfDate,
      service_dates: asOfDate ? [asOfDate] : undefined,
      include_capacity: true,
      joinable: true,
      courses_only: true,
      include_full: opts.includeFull === true,
      require_db: true,
    },
  });
  if (!built.ok) {
    return { ok: false, reason: built.body.reason_code || 'catalog_unavailable', courses: [], group_lessons: [] };
  }

  let adminCfg = opts.adminCfg;
  if (!adminCfg) {
    const packs = await loadSurfPacksFromDb(pg, clientSlug, locationId);
    adminCfg = {
      ok: true,
      source: 'db',
      currency: 'EUR',
      surf_packs: packs,
      prices: [],
    };
  }
  const result = await executeSunsetCatalog(pg, built.command, { adminCfg });
  if (!result.ok) {
    return {
      ok: false,
      reason: result.body.reason || result.body.reason_code || 'catalog_unavailable',
      courses: [],
      group_lessons: [],
    };
  }

  return {
    ok: true,
    client_slug: clientSlug,
    location_id: locationId,
    date: asOfDate,
    courses: result.body.courses || [],
    group_lessons: result.body.group_lessons || [],
    source_tables: [
      'tenant_surf_pack_rules',
      'tenant_price_rules',
      'booking_service_records',
    ],
  };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  weekdaysFromPackWeekly,
  weekdayOfIsoDate,
  datesBelongToPackSchedule,
  evaluateSunsetOfferingDates,
  countConfirmedCourseSeatsOnDate,
  countConfirmedLessonSlotSeatsOnDate,
  loadAdminCourseById,
  assertCourseAssignable,
  listJoinableSunsetOfferings,
};
