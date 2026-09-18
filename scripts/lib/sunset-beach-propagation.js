'use strict';

function requestedBeachKey(body) {
  const raw = body && (body.beach_key != null ? body.beach_key : body.beach);
  const value = raw && typeof raw === 'object' ? raw.beach_key : raw;
  return String(value == null ? '' : value).trim() || null;
}

/** Resolve one requested identity from the canonical registry in one scoped read. */
async function resolveRequestedBeach(client, { clientSlug, locationId, beachKey } = {}) {
  if (String(clientSlug || '').trim() !== 'sunset') return { ok: false, reason: 'invalid_tenant' };
  const key = String(beachKey || '').trim();
  if (!key) return { ok: false, reason: 'beach_required' };
  if (!client || typeof client.query !== 'function') return { ok: false, reason: 'beach_registry_unavailable' };
  let result;
  try {
    result = await client.query(
      `SELECT location_id, beach_key, display_name, active
         FROM tenant_surf_beaches
        WHERE client_slug = $1 AND location_id = $2 AND beach_key = $3`,
      [clientSlug, locationId, key],
    );
  } catch (_) {
    return { ok: false, reason: 'beach_registry_unavailable' };
  }
  const rows = Array.isArray(result && result.rows) ? result.rows : [];
  if (!rows.length) return { ok: false, reason: 'unknown_beach' };
  const scoped = rows.find((row) => row.active === true);
  if (!scoped) return { ok: false, reason: 'inactive_beach' };
  return { ok: true, beach: Object.freeze({ beach_key: key, display_name: String(scoped.display_name || key) }) };
}

function selectCourseForBeach(courses, beach) {
  const key = beach && String(beach.beach_key || '').trim();
  if (!key) return { ok: false, reason: 'beach_required' };
  const matches = (Array.isArray(courses) ? courses : []).filter((course) => (
    Array.isArray(course.beaches) && course.beaches.map(String).includes(key)
  ));
  if (!matches.length) return { ok: false, reason: 'beach_not_offered' };
  if (matches.length > 1) return { ok: false, reason: 'ambiguous_beach_course' };
  return { ok: true, course: { ...matches[0], beach: { ...beach } } };
}

function applyBeachToCatalogProjection(projection, beach) {
  const key = beach.beach_key;
  const beachCourses = (projection.courses || []).filter((c) => (
    c && Array.isArray(c.beaches) && c.beaches.map(String).includes(key)
  ));
  if (!beachCourses.length) return { ok: false, reason: 'beach_course_unavailable' };
  const beachIds = new Set(beachCourses.map((c) => String(c.course_id || c.pack_id || '')));
  const offerings = (projection.offerings || []).filter((o) => (
    o && o.offering_type === 'course' && beachIds.has(String(o.course_id || ''))
    && o.active !== false && o.bookable === true
    && o.price_identity && String(o.price_identity.item_code || '').trim()
    && String(o.offering_id || '').trim() === String(o.price_identity.item_code || '').trim()
    && Number.isInteger(o.unit_amount_cents) && o.unit_amount_cents > 0
  ));
  const bookableIds = new Set(offerings.map((o) => String(o.course_id || '')));

  const courses = beachCourses.filter((c) => bookableIds.has(String(c.course_id || c.pack_id || '')));
  if (!courses.length) return { ok: false, reason: 'beach_course_unpriced' };
  if (courses.length > 1) return { ok: false, reason: 'ambiguous_beach_course' };
  return {
    ...projection,
    courses: courses.map((c) => ({ ...c, beach: { ...beach } })),
    offerings: offerings.map((o) => o.offering_type === 'course' ? { ...o, beach: { ...beach } } : o),
  };
}

module.exports = { requestedBeachKey, resolveRequestedBeach, selectCourseForBeach, applyBeachToCatalogProjection };
