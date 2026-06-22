'use strict';

/**
 * Sunset Admin staging QA helpers — save/restore lesson capacity so probes
 * do not leave dirty values in sunset_staging.
 */

const DEFAULT_BASE = process.env.SUNSET_STAGING_BASE_URL || 'https://sunset-staging.lunafrontdesk.com';

function tempAlternateCapacity(originalCap) {
  const n = Number(originalCap);
  if (!Number.isFinite(n)) return 24;
  if (n === 24) return 25;
  if (n === 25) return 24;
  return n >= 999 ? n - 1 : n + 1;
}

async function fetchAdminConfig(page, locationId, baseUrl = DEFAULT_BASE) {
  return page.evaluate(async ({ location, base }) => {
    const r = await fetch(`${base}/staff/admin/config?client=sunset&location=${encodeURIComponent(location)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { location: locationId, base: baseUrl });
}

async function putLessonCapacity(page, locationId, defaultDailyCap, baseUrl = DEFAULT_BASE) {
  return page.evaluate(async ({ location, cap, base }) => {
    const r = await fetch(`${base}/staff/admin/config/lesson-capacity?client=sunset&location=${encodeURIComponent(location)}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ default_daily_cap: cap }),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  }, { location: locationId, cap: defaultDailyCap, base: baseUrl });
}

async function readLessonCapacityDefaults(page, locationIds, baseUrl = DEFAULT_BASE) {
  const originals = {};
  for (const locationId of locationIds) {
    const res = await fetchAdminConfig(page, locationId, baseUrl);
    const cap = res.data && res.data.lesson_capacity
      ? res.data.lesson_capacity.default_daily_cap
      : null;
    originals[locationId] = cap;
  }
  return originals;
}

async function restoreLessonCapacityDefaults(page, originals, baseUrl = DEFAULT_BASE) {
  const restored = {};
  for (const [locationId, cap] of Object.entries(originals || {})) {
    if (cap == null) continue;
    restored[locationId] = await putLessonCapacity(page, locationId, cap, baseUrl);
  }
  return restored;
}

/**
 * Run fn while guaranteeing lesson capacity values are restored afterward.
 */
async function withLessonCapacityRestore(page, locationIds, fn, options) {
  const baseUrl = (options && options.baseUrl) || DEFAULT_BASE;
  const originals = await readLessonCapacityDefaults(page, locationIds, baseUrl);
  try {
    return await fn({
      originals,
      fetchAdminConfig: (loc) => fetchAdminConfig(page, loc, baseUrl),
      putLessonCapacity: (loc, cap) => putLessonCapacity(page, loc, cap, baseUrl),
      tempAlternateCapacity,
    });
  } finally {
    await restoreLessonCapacityDefaults(page, originals, baseUrl);
  }
}

module.exports = {
  DEFAULT_BASE,
  tempAlternateCapacity,
  fetchAdminConfig,
  putLessonCapacity,
  readLessonCapacityDefaults,
  restoreLessonCapacityDefaults,
  withLessonCapacityRestore,
};
