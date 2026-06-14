'use strict';

/**
 * Stage 56j — Schedule unscheduled guest meal/yoga rows onto the Services calendar.
 */

const { isServiceDateInStay } = require('./staff-booking-services-schedule');
const { normalizeBookingDateOnly } = require('./booking-transfers');
const {
  extractRequestedDays,
  isReactiveServiceFollowUpMessage,
  detectReactiveServiceIntent,
} = require('./luna-booking-reactive-services-policy');
const { getClientTransferConfig } = require('./client-transfer-config');

const SCHEDULABLE_TYPES = new Set(['meal', 'meals', 'yoga']);

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

/** Strip ordinal suffixes so "September 2nd" parses like "September 2". */
function stripOrdinalDaySuffix(text) {
  return String(text || '').replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, '$1');
}

function todayDateInTimezone(timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function weekdayToDateInStay(weekdayName, checkIn, checkOut, timezone) {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const target = trimStr(weekdayName).toLowerCase();
  const idx = names.indexOf(target);
  if (idx < 0) return null;
  const cin = normalizeBookingDateOnly(checkIn, { timezone });
  const cout = normalizeBookingDateOnly(checkOut, { timezone });
  if (!cin || !cout) return null;
  const start = new Date(`${cin}T12:00:00Z`);
  const end = new Date(`${cout}T12:00:00Z`);
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === idx) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * @param {string} messageText
 * @param {object} fields
 * @param {object} booking
 * @returns {{ service_type: string, service_date: string }|null}
 */
function resolveGuestServiceScheduleIntent(messageText, fields, booking) {
  const text = trimStr(messageText);
  const f = fields || {};
  const bk = booking || {};
  const tz = 'Europe/Madrid';
  if (!text && !f.meals_request && !f.yoga_request) return null;

  const intent = detectReactiveServiceIntent(text);
  const dayInfo = extractRequestedDays(
    stripOrdinalDaySuffix(text),
    f.check_in || bk.check_in,
    f.check_out || bk.check_out,
  );
  const hasToday = /\b(?:today|tonight|this evening)\b/i.test(text);
  const hasScheduleSignal = /\b(?:schedule|scheduled|book it for|put it on|for)\b/i.test(text)
    || hasToday
    || (dayInfo && (dayInfo.dates?.length || dayInfo.days?.length))
    || isReactiveServiceFollowUpMessage(text, f);

  let serviceType = null;
  if (intent === 'meals' || f.meals_request || /\b(?:meal|meals|dinner|breakfast|lunch)\b/i.test(text)) {
    serviceType = 'meal';
  } else if (intent === 'yoga' || f.yoga_request || /\b(?:yoga)\b/i.test(text)) {
    serviceType = 'yoga';
  }
  if (!serviceType) return null;

  const reqDates = serviceType === 'meal'
    ? (f.meals_request && f.meals_request.requested_dates)
    : (f.yoga_request && f.yoga_request.requested_dates);

  if (!hasScheduleSignal && !(Array.isArray(reqDates) && reqDates.length)) return null;

  let serviceDate = null;
  if (hasToday) {
    serviceDate = todayDateInTimezone(tz);
  } else if (dayInfo && dayInfo.dates && dayInfo.dates.length) {
    serviceDate = dayInfo.dates[0];
  } else if (dayInfo && dayInfo.days && dayInfo.days.length) {
    serviceDate = weekdayToDateInStay(
      dayInfo.days[0],
      f.check_in || bk.check_in,
      f.check_out || bk.check_out,
      tz,
    );
  } else if (Array.isArray(reqDates) && reqDates.length) {
    serviceDate = reqDates[0];
  }

  if (!serviceDate) return { service_type: serviceType, service_date: null, needs_date: true };
  return { service_type: serviceType, service_date: serviceDate, needs_date: false };
}

/**
 * @param {import('pg').Client} pg
 * @param {object} opts
 */
async function runGuestServiceScheduleWrite(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const bookingId = trimStr(opts.booking_id);
  const fields = opts.extracted_fields || opts.fields || {};
  const messageText = trimStr(opts.message_text);
  const tz = getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';

  if (!pg || !bookingId) {
    return { attempted: false, skipped: 'missing_pg_or_booking_id' };
  }

  const bkRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.check_in::text AS check_in,
            b.check_out::text AS check_out
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid
      LIMIT 1`,
    [clientSlug, bookingId],
  );
  const booking = bkRes.rows[0];
  if (!booking) return { attempted: true, success: false, error: 'booking_not_found' };

  const intent = resolveGuestServiceScheduleIntent(messageText, fields, booking);
  if (!intent) return { attempted: false, skipped: 'no_schedule_intent' };
  if (intent.needs_date || !intent.service_date) {
    return { attempted: true, success: false, needs_date: true, service_type: intent.service_type };
  }
  if (!isServiceDateInStay(intent.service_date, booking.check_in, booking.check_out, tz)) {
    return {
      attempted: true,
      success: false,
      error: 'service_date_outside_stay',
      service_date: intent.service_date,
    };
  }

  const typeFilter = intent.service_type === 'meal'
    ? `('meal', 'meals')`
    : `('yoga')`;

  const pending = await pg.query(
    `SELECT id::text AS service_record_id, service_type, service_date::text AS service_date
       FROM booking_service_records
      WHERE client_slug = $1
        AND booking_id = $2::uuid
        AND service_type IN ${typeFilter}
        AND service_date IS NULL
        AND status IN ('requested', 'needs_staff_confirmation', 'interested')
      ORDER BY created_at ASC`,
    [clientSlug, bookingId],
  );
  if (!pending.rows.length) {
    return {
      attempted: true,
      success: false,
      error: 'no_unscheduled_service_row',
      service_type: intent.service_type,
    };
  }

  const scheduledIds = [];
  for (const row of pending.rows) {
    const upd = await pg.query(
      `UPDATE booking_service_records
          SET service_date = $1::date,
              status = CASE WHEN status = 'interested' THEN 'requested' ELSE status END,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND client_slug = $3
          AND booking_id = $4::uuid
        RETURNING id::text AS service_record_id, service_type, service_date::text AS service_date`,
      [intent.service_date, row.service_record_id, clientSlug, bookingId],
    );
    if (upd.rows[0]) scheduledIds.push(upd.rows[0].service_record_id);
  }

  return {
    attempted: true,
    success: scheduledIds.length > 0,
    scheduled_count: scheduledIds.length,
    service_record_ids: scheduledIds,
    service_record_id: scheduledIds[0] || null,
    service_type: intent.service_type,
    service_date: intent.service_date,
  };
}

module.exports = {
  SCHEDULABLE_TYPES,
  resolveGuestServiceScheduleIntent,
  runGuestServiceScheduleWrite,
};
