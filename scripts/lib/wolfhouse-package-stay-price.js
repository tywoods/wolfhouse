'use strict';

/** Default stay length when Staff has not set default_nights. Existing packages = 6. */
const DEFAULT_PACKAGE_NIGHTS = 6;

function defaultNightsForPackage(pkg) {
  const n = Number(pkg && pkg.default_nights);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_PACKAGE_NIGHTS;
}

/** Null/missing DB per-night must not become 0 via Number(null). */
function presentPerNightCents(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function perNightCentsFromSeason(seasonPrices, defaultNights) {
  const explicit = presentPerNightCents(seasonPrices && seasonPrices.per_night_cents);
  if (explicit != null) return explicit;
  const packageCents = Number(seasonPrices && seasonPrices.weekly_per_person_cents);
  const nights = Number(defaultNights);
  if (!Number.isSafeInteger(packageCents) || packageCents < 0 || !Number.isSafeInteger(nights) || nights < 1) {
    return null;
  }
  return Math.round(packageCents / nights);
}

/**
 * Per-person stay price in cents.
 * nights < default → per-night × nights
 * nights == default → package price
 * nights > default → package + per-night × extra nights
 */
function packageStayCentsPerPerson(seasonPrices, defaultNights, nights) {
  const packageCents = Number(seasonPrices && seasonPrices.weekly_per_person_cents);
  if (!Number.isSafeInteger(packageCents) || packageCents < 0) return null;
  const def = Number.isSafeInteger(Number(defaultNights)) && Number(defaultNights) > 0
    ? Number(defaultNights)
    : DEFAULT_PACKAGE_NIGHTS;
  const nightly = perNightCentsFromSeason(seasonPrices, def);
  if (!Number.isSafeInteger(nightly) || nightly < 0) return null;
  const stay = Number(nights);
  if (!Number.isSafeInteger(stay) || stay < 1) return null;
  if (stay < def) return nightly * stay;
  if (stay === def) return packageCents;
  return packageCents + nightly * (stay - def);
}

function normalizeIncludeLine(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const text = raw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { text, full_stay_only: false };
  }
  if (typeof raw === 'object') {
    const text = String(raw.text == null ? '' : raw.text).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { text, full_stay_only: raw.full_stay_only === true };
  }
  return null;
}

function packageIncludesForStay(pkg, nights) {
  const def = defaultNightsForPackage(pkg);
  const stay = Number(nights);
  const raw = Array.isArray(pkg && pkg.includes) ? pkg.includes : [];
  const out = [];
  for (const line of raw) {
    const row = normalizeIncludeLine(line);
    if (!row) continue;
    if (row.full_stay_only && !(Number.isSafeInteger(stay) && stay >= def)) continue;
    out.push(row);
  }
  return out;
}

module.exports = {
  DEFAULT_PACKAGE_NIGHTS,
  defaultNightsForPackage,
  presentPerNightCents,
  perNightCentsFromSeason,
  packageStayCentsPerPerson,
  normalizeIncludeLine,
  packageIncludesForStay,
};
