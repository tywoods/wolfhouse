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
 * Staff-set per-night is used exactly as entered.
 * Auto-fill (no per-night): round once at the end —
 *   under default → round(package / default × nights)
 *   at default → package
 *   over default → package + round(package / default × extra)
 */
function packageStayCentsPerPerson(seasonPrices, defaultNights, nights) {
  const packageCents = Number(seasonPrices && seasonPrices.weekly_per_person_cents);
  if (!Number.isSafeInteger(packageCents) || packageCents < 0) return null;
  const def = Number.isSafeInteger(Number(defaultNights)) && Number(defaultNights) > 0
    ? Number(defaultNights)
    : DEFAULT_PACKAGE_NIGHTS;
  const stay = Number(nights);
  if (!Number.isSafeInteger(stay) || stay < 1) return null;
  const staffNightly = presentPerNightCents(seasonPrices && seasonPrices.per_night_cents);
  if (staffNightly != null) {
    if (stay < def) return staffNightly * stay;
    if (stay === def) return packageCents;
    return packageCents + staffNightly * (stay - def);
  }
  if (stay < def) return Math.round(packageCents * stay / def);
  if (stay === def) return packageCents;
  return packageCents + Math.round(packageCents * (stay - def) / def);
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
