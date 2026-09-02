'use strict';

/**
 * Sunset Luna read-only bookings-by-phone.
 *
 * Tenant-forced to sunset. Never lists Wolfhouse rows. No WhatsApp send.
 * Includes unpaid/pending created bookings (Hernan Kyle/George case) and
 * excludes cancelled/hidden.
 */

const { SUNSET_CLIENT_SLUG, isSunsetLocationId, normalizeSunsetLocationId } = require('./sunset-school-locations');

const LIST_SQL = `
SELECT
  b.id::text AS booking_id,
  b.booking_code,
  b.guest_name,
  b.status::text AS status,
  b.payment_status::text AS payment_status,
  b.check_in::text AS service_date,
  b.check_out::text AS check_out,
  b.guest_count,
  COALESCE(b.metadata->>'location_id', $3) AS location_id
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND regexp_replace(COALESCE(b.phone, ''), '[^0-9]', '', 'g') LIKE '%' || $2
  AND b.status::text NOT IN ('cancelled', 'canceled')
  AND COALESCE(b.hidden, false) IS NOT TRUE
  AND ($3::text IS NULL OR COALESCE(b.metadata->>'location_id', $3) = $3)
ORDER BY b.created_at DESC NULLS LAST, b.booking_code ASC
LIMIT 20
`;

function digitsOnly(value) {
  return String(value == null ? '' : value).replace(/\D/g, '');
}

function phoneMatchSuffix(phone) {
  const digits = digitsOnly(phone);
  if (!digits) return '';
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function resolveSunsetListScope(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const clientSlug = String(o.clientSlug || o.client_slug || '').trim();
  if (clientSlug && clientSlug !== SUNSET_CLIENT_SLUG) {
    return { ok: false, error: 'unsupported_client', client_slug: clientSlug };
  }
  const rawLoc = o.locationId != null ? o.locationId : o.location_id;
  if (rawLoc != null && String(rawLoc).trim()) {
    if (!isSunsetLocationId(rawLoc)) {
      return { ok: false, error: 'unknown_location', location_id: String(rawLoc).trim() };
    }
    return {
      ok: true,
      clientSlug: SUNSET_CLIENT_SLUG,
      locationId: normalizeSunsetLocationId(rawLoc),
    };
  }
  return { ok: true, clientSlug: SUNSET_CLIENT_SLUG, locationId: null };
}

function projectSunsetBookingListRow(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    booking_id: r.booking_id || null,
    booking_code: r.booking_code || null,
    guest_name: r.guest_name || null,
    status: r.status || null,
    payment_status: r.payment_status || null,
    service_date: r.service_date || r.check_in || null,
    check_out: r.check_out || null,
    guest_count: r.guest_count != null ? r.guest_count : null,
    location_id: r.location_id || null,
  };
}

/**
 * @param {object} pg
 * @param {{ phone: string, locationId?: string|null }} opts
 */
async function loadSunsetBookingsByPhone(pg, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const scope = resolveSunsetListScope(o);
  if (!scope.ok) return { ok: false, ...scope, bookings: [] };
  const suffix = phoneMatchSuffix(o.phone);
  if (!suffix) {
    return { ok: false, error: 'phone_required', client_slug: SUNSET_CLIENT_SLUG, bookings: [] };
  }
  if (!pg || typeof pg.query !== 'function') {
    return { ok: false, error: 'database_required', client_slug: SUNSET_CLIENT_SLUG, bookings: [] };
  }
  const result = await pg.query(LIST_SQL, [SUNSET_CLIENT_SLUG, suffix, scope.locationId]);
  const bookings = (result.rows || []).map(projectSunsetBookingListRow);
  return {
    ok: true,
    client_slug: SUNSET_CLIENT_SLUG,
    location_id: scope.locationId,
    count: bookings.length,
    bookings,
    no_whatsapp: true,
    no_payment_write: true,
    no_n8n: true,
  };
}

module.exports = {
  SUNSET_CLIENT_SLUG,
  LIST_SQL,
  phoneMatchSuffix,
  resolveSunsetListScope,
  projectSunsetBookingListRow,
  loadSunsetBookingsByPhone,
};
