'use strict';

/** Read-only stable beach identity projection. Registry rows are the sole authority. */
function projectStableBeachIdentity({ clientSlug, locationId, beachKey, registry } = {}) {
  if (String(clientSlug || '').trim() !== 'sunset') return { ok: false, reason: 'invalid_tenant' };
  const key = String(beachKey || '').trim();
  if (!key) return { ok: false, reason: 'beach_required' };
  const rows = Array.isArray(registry) ? registry : [];
  const tenantRows = rows.filter((row) => String(row.client_slug || 'sunset') === 'sunset' && String(row.beach_key) === key);
  const scoped = tenantRows.find((row) => String(row.location_id) === String(locationId));
  if (!scoped) return { ok: false, reason: tenantRows.length ? 'foreign_property_beach' : 'unknown_beach' };
  if (scoped.active !== true) return { ok: false, reason: 'inactive_beach' };
  return {
    ok: true,
    beach: Object.freeze({ beach_key: key, display_name: String(scoped.display_name || key) }),
  };
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

module.exports = { projectStableBeachIdentity, selectCourseForBeach };
