/**
 * Sunset rental duration model — the templatable (unit, count) ⇄ duration_key
 * bridge for the generic Equipment Pricing tab (Slice 1).
 *
 * The admin UI expresses a rental period as two inputs: a unit (Hours | Days)
 * and a count (how many). This module converts that to/from the stored
 * `tenant_price_rules` duration_key (the tail of item_code `offering__duration`),
 * keeping DAY-based keys byte-compatible with the existing booking path so live
 * bookings never break, and folding the legacy window keys into the same model:
 *
 *   half_day  ⇄ (hours, 12)     ← "half day is 12 hours" (owner)
 *   full_day  →  (days, 1)      ← a full day = 1 day (24h); serializes to 1_day
 *   1_hour    ⇄ (hours, 1)
 *   2_hours   ⇄ (hours, 2)
 *   N_hours   ⇄ (hours, N)      ← generic
 *   1_day     ⇄ (days, 1)
 *   N_days    ⇄ (days, N)       ← generic
 *
 * Serialization is canonical: (hours,12)→half_day, (days,1)→1_day, else
 * `<count>_<unit>`. Pure; browser global + node-require compatible.
 */
'use strict';

var RENTAL_DURATION_UNITS = ['hours', 'days'];

/** duration_key → { unit:'hours'|'days', count:int } | null (unparseable). */
function parseRentalDurationKey(durationKey) {
  var key = String(durationKey == null ? '' : durationKey).trim().toLowerCase();
  if (!key) return null;
  if (key === 'half_day') return { unit: 'hours', count: 12 };
  if (key === 'full_day') return { unit: 'days', count: 1 };
  var m = key.match(/^(\d+)_(hour|hours|day|days)$/);
  if (!m) return null;
  var count = parseInt(m[1], 10);
  if (!Number.isInteger(count) || count < 1) return null;
  var unit = (m[2] === 'hour' || m[2] === 'hours') ? 'hours' : 'days';
  return { unit: unit, count: count };
}

/** { unit, count } → canonical duration_key (booking-compatible), or '' if invalid. */
function rentalDurationKeyFromUnitCount(unit, count) {
  var u = String(unit || '').trim().toLowerCase();
  var n = parseInt(count, 10);
  if (RENTAL_DURATION_UNITS.indexOf(u) < 0) return '';
  if (!Number.isInteger(n) || n < 1) return '';
  if (u === 'days') return n === 1 ? '1_day' : (n + '_days');
  // hours
  if (n === 12) return 'half_day';       // stay in line with the existing window
  if (n === 1) return '1_hour';
  if (n === 2) return '2_hours';
  return n + '_hours';
}

/** Human label for a period, e.g. "12 hours", "1 day", "3 days". */
function formatRentalDuration(unit, count) {
  var u = String(unit || '').trim().toLowerCase();
  var n = parseInt(count, 10);
  if (RENTAL_DURATION_UNITS.indexOf(u) < 0 || !Number.isInteger(n) || n < 1) return '';
  var noun = u === 'days' ? (n === 1 ? 'day' : 'days') : (n === 1 ? 'hour' : 'hours');
  return n + ' ' + noun;
}

/** Convenience: duration_key → label, or '' when unparseable. */
function formatRentalDurationKey(durationKey) {
  var uc = parseRentalDurationKey(durationKey);
  return uc ? formatRentalDuration(uc.unit, uc.count) : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RENTAL_DURATION_UNITS: RENTAL_DURATION_UNITS,
    parseRentalDurationKey: parseRentalDurationKey,
    rentalDurationKeyFromUnitCount: rentalDurationKeyFromUnitCount,
    formatRentalDuration: formatRentalDuration,
    formatRentalDurationKey: formatRentalDurationKey,
  };
}
