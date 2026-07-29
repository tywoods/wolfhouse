'use strict';

/**
 * Server-side re-export of the canonical standalone rental projection.
 * Browser + Node share scripts/browser/sunset-schedule-rental-availability.js.
 */

const rental = require('../browser/sunset-schedule-rental-availability');

function projectStandaloneRentalCatalog(opts) {
  return rental.scheduleProjectStandaloneRentals(opts || {});
}

/**
 * Shape-level duration/dayCount compatibility (no catalog).
 * Multi-day: exact N_days or 1_day shapes only — never hours.
 * Commercial exclusivity (exact active N_days blocks 1_day) is enforced by
 * scheduleCompatibleRentalDurationKeys + server prepareGenericRentalsForCreate.
 */
function isDurationCompatibleWithDayCount(durationKey, dayCount) {
  const k = String(durationKey || '').trim();
  const n = Number(dayCount);
  const days = Number.isInteger(n) && n > 0 ? n : 1;
  if (days <= 1) {
    return rental.scheduleIsHourRentalDurationKey(k) || k === '1_day' || k === 'full_day';
  }
  if (k === `${days}_days`) return true;
  if (k === '1_day' || k === 'full_day') return true;
  return false;
}

function isHourPackageDurationKey(durationKey) {
  return rental.scheduleIsHourRentalDurationKey(durationKey);
}

module.exports = {
  projectStandaloneRentalCatalog,
  isDurationCompatibleWithDayCount,
  isHourPackageDurationKey,
  scheduleProjectStandaloneRentals: rental.scheduleProjectStandaloneRentals,
  scheduleCompatibleRentalDurationKeys: rental.scheduleCompatibleRentalDurationKeys,
  scheduleRentalOfferingDisplayLabel: rental.scheduleRentalOfferingDisplayLabel,
};
