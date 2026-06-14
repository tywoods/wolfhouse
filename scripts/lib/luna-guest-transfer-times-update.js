'use strict';

/**
 * Stage 56j — Update booking transfer scheduled_at from guest-provided times.
 */

const {
  upsertBookingTransfer,
  defaultTransferScheduledAtLocal,
  normalizeBookingDateOnly,
} = require('./booking-transfers');
const { extractTransferInfo, mergeTransferInfo } = require('./luna-booking-intake-policy');
const { parseDatetimeLocalInTimezone } = require('./staff-booking-transfers-routes');
const { getClientTransferConfig } = require('./client-transfer-config');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * @param {string|null|undefined} timeStr
 * @returns {string|null} HH:mm 24h
 */
function parseGuestTimeTo24h(timeStr) {
  const raw = trimStr(timeStr).toLowerCase();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] != null ? Number(m[2]) : 0;
  const mer = m[3] ? m[3].toLowerCase() : null;
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  if (!mer && hh <= 12 && /\bpm\b/i.test(raw) && hh < 12) hh += 12;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * @param {{ direction: string, booking: object, timeStr?: string|null, client_slug?: string }} opts
 * @returns {string|null} YYYY-MM-DDTHH:mm local
 */
function buildGuestTransferScheduledAtLocal(opts = {}) {
  const direction = trimStr(opts.direction).toLowerCase();
  const booking = opts.booking || {};
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const tz = getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';
  const timeStr = trimStr(opts.timeStr);
  const hhmm = timeStr ? parseGuestTimeTo24h(timeStr) : null;
  if (!hhmm) {
    return defaultTransferScheduledAtLocal({
      direction,
      booking,
      client_slug: clientSlug,
      timezone: tz,
    });
  }
  const dateOnly = direction === 'departure'
    ? normalizeBookingDateOnly(booking.check_out, { timezone: tz })
    : normalizeBookingDateOnly(booking.check_in, { timezone: tz });
  if (!dateOnly) return null;
  return `${dateOnly}T${hhmm}`;
}

function guestProvidedTransferTimes(fields, messageText) {
  const ti = (fields && (fields.transfer_info || fields.transfer_interest)) || {};
  const fromFields = !!(ti.arrival_time || ti.departure_time);
  if (fromFields) return true;
  const extracted = extractTransferInfo(messageText);
  if (extracted && (extracted.arrival_time || extracted.departure_time)) return true;
  if (ti.interested === true && ti.airport_code) {
    const t = String(messageText || '');
    return /\b(?:arriv\w*|land\w*|get\s+in|leave|leaving|depart\w*)\b/i.test(t)
      && /\b(?:noon|midday|morning|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.test(t);
  }
  return false;
}

function shouldAskGuestTransferTimes(fields) {
  const ti = (fields && (fields.transfer_info || fields.transfer_interest)) || {};
  if (!ti || ti.interested !== true || !ti.airport_code) return false;
  if (ti.deferred === true || ti.times_default_ok === true) return false;
  if (ti.arrival_time || ti.departure_time) return false;
  return true;
}

/**
 * @param {import('pg').Client} pg
 * @param {object} opts
 */
async function runGuestBookingTransferTimesUpdate(pg, opts = {}) {
  const clientSlug = trimStr(opts.client_slug) || 'wolfhouse-somo';
  const bookingId = trimStr(opts.booking_id);
  const messageText = trimStr(opts.message_text);
  const fields = opts.extracted_fields || opts.fields || {};
  const tz = getClientTransferConfig(clientSlug).timezone || 'Europe/Madrid';

  if (!pg || !bookingId) {
    return { attempted: false, skipped: 'missing_pg_or_booking_id' };
  }

  const priorTi = (fields.transfer_info || fields.transfer_interest) || {};
  const extracted = extractTransferInfo(messageText);
  const merged = mergeTransferInfo(priorTi, extracted);
  if (!merged || merged.interested !== true) {
    return { attempted: false, skipped: 'no_transfer_interest' };
  }
  if (!merged.arrival_time && !merged.departure_time) {
    return { attempted: false, skipped: 'no_times_in_message' };
  }

  const bkRes = await pg.query(
    `SELECT b.id::text AS booking_id, b.booking_code, b.check_in::text AS check_in,
            b.check_out::text AS check_out, b.guest_count, b.package_code
       FROM bookings b
       INNER JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND b.id = $2::uuid
      LIMIT 1`,
    [clientSlug, bookingId],
  );
  const booking = bkRes.rows[0];
  if (!booking) return { attempted: true, success: false, error: 'booking_not_found' };

  const updated = [];
  for (const direction of ['arrival', 'departure']) {
    const timeStr = direction === 'arrival'
      ? (merged.arrival_time || null)
      : (merged.departure_time || null);
    if (!timeStr) continue;
    const localAt = buildGuestTransferScheduledAtLocal({
      direction,
      booking,
      timeStr,
      client_slug: clientSlug,
    });
    const scheduledAt = localAt && localAt.includes('T')
      ? parseDatetimeLocalInTimezone(localAt, tz)
      : localAt;
    const row = await upsertBookingTransfer(pg, {
      client_slug: clientSlug,
      booking_id: bookingId,
      direction,
      booking,
      source: 'luna',
      transfer: {
        airport_code: merged.airport_code || priorTi.airport_code || 'SDR',
        flight_number: merged.flight_number || priorTi.flight_number || null,
        scheduled_at: scheduledAt,
        status: 'requested',
        notes: 'Updated via Luna from guest arrival/departure times',
      },
    });
    updated.push({
      direction,
      transfer_id: row && (row.id || row.transfer_id),
      scheduled_at_local: localAt,
    });
  }

  return {
    attempted: true,
    success: updated.length > 0,
    updated_transfers: updated,
    arrival_time: merged.arrival_time || null,
    departure_time: merged.departure_time || null,
  };
}

module.exports = {
  parseGuestTimeTo24h,
  buildGuestTransferScheduledAtLocal,
  guestProvidedTransferTimes,
  shouldAskGuestTransferTimes,
  runGuestBookingTransferTimesUpdate,
};
