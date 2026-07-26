'use strict';

/**
 * Canonical Sunset Admin "Price for" duration keys: exactly 1–7 days.
 *
 * Sellable Create/Edit date spans resolve by duration_days only. Legacy keys
 * are mapped explicitly (never guessed) so configured amounts keep their
 * original item_code identity until an Admin re-save rewrites them.
 */

const CANONICAL_DAY_DURATION_KEYS = Object.freeze([
  '1_day',
  '2_days',
  '3_days',
  '4_days',
  '5_days',
  '6_days',
  '7_days',
]);

const CANONICAL_DAY_DURATION_SET = new Set(CANONICAL_DAY_DURATION_KEYS);

/** Explicit legacy → canonical. Amounts stay on the stored tier key / item_code. */
const LEGACY_TIER_KEY_TO_CANONICAL = Object.freeze({
  single_class: '1_day',
  '1_week': '7_days',
});

/** Legacy keys still readable from storage; not offered in Admin Price-for UI. */
const LEGACY_HIDDEN_DURATION_KEYS = Object.freeze([
  'single_class',
  '1_week',
  '2_weeks',
  '3_weeks',
  '4_weeks',
  '1_hour',
  '2_hours',
  'half_day',
]);

/** Multi-week legacy spans (not sellable via 1–7 day Create date match). */
const LEGACY_WEEK_DURATION_DAYS = Object.freeze({
  '2_weeks': 14,
  '3_weeks': 21,
  '4_weeks': 28,
});

function isCanonicalDayDurationKey(key) {
  return CANONICAL_DAY_DURATION_SET.has(String(key || '').trim());
}

function canonicalTierKey(tierKey) {
  const key = String(tierKey || '').trim();
  if (!key) return null;
  if (LEGACY_TIER_KEY_TO_CANONICAL[key]) return LEGACY_TIER_KEY_TO_CANONICAL[key];
  if (isCanonicalDayDurationKey(key)) return key;
  return null;
}

function durationDaysFromCanonicalKey(key) {
  const k = String(key || '').trim();
  if (k === '1_day') return 1;
  const m = /^(\d+)_days$/.exec(k);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 7 ? n : null;
}

/**
 * Inclusive-day span for a stored tier key. Explicit maps only — no nearest-tier.
 * @returns {number|null}
 */
function durationDaysFromTierKey(tierKey) {
  const key = String(tierKey || '').trim();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(LEGACY_TIER_KEY_TO_CANONICAL, key)) {
    return durationDaysFromCanonicalKey(LEGACY_TIER_KEY_TO_CANONICAL[key]);
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_WEEK_DURATION_DAYS, key)) {
    return LEGACY_WEEK_DURATION_DAYS[key];
  }
  return durationDaysFromCanonicalKey(key);
}

function hoursForDayDurationKey(key) {
  const days = durationDaysFromCanonicalKey(key) || durationDaysFromTierKey(key);
  if (days == null || days < 1) return 0;
  // Historical pack metadata: 2 lesson hours per day.
  return days * 2;
}

function rentalDurationKeyFromInclusiveDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 7) return null;
  return n === 1 ? '1_day' : `${n}_days`;
}

function isSellableAdminPriceForKey(key) {
  return isCanonicalDayDurationKey(key);
}

module.exports = {
  CANONICAL_DAY_DURATION_KEYS,
  CANONICAL_DAY_DURATION_SET,
  LEGACY_TIER_KEY_TO_CANONICAL,
  LEGACY_HIDDEN_DURATION_KEYS,
  LEGACY_WEEK_DURATION_DAYS,
  isCanonicalDayDurationKey,
  isSellableAdminPriceForKey,
  canonicalTierKey,
  durationDaysFromCanonicalKey,
  durationDaysFromTierKey,
  hoursForDayDurationKey,
  rentalDurationKeyFromInclusiveDays,
};
