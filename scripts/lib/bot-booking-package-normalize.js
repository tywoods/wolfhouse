'use strict';

const { computeStayNights } = require('./wolfhouse-package-night-rules');

const NO_PACKAGE_CODES = new Set([
  'package_none',
  'no_package',
  'accommodation_only',
  'accommodation-only',
]);

function isNoPackageBookingCode(code) {
  const c = String(code || '').trim().toLowerCase();
  return !c || NO_PACKAGE_CODES.has(c);
}

function normalizePackageCodeAlias(code) {
  const c = String(code || '').trim().toLowerCase();
  if (!c || NO_PACKAGE_CODES.has(c)) return 'package_none';
  return c;
}

/**
 * Resolve package context for bot booking preview/create.
 */
function resolveBotBookingPackageContext({
  packageCode,
  guestPackages,
  checkIn,
  checkOut,
  guestCount,
}) {
  const nights = computeStayNights(checkIn, checkOut);
  let quotePackageCode = normalizePackageCodeAlias(packageCode);
  const gp = Array.isArray(guestPackages) ? guestPackages : [];

  if (gp.length) {
    const majority = gp.reduce((acc, item) => {
      const code = normalizePackageCodeAlias(item && item.package_code);
      acc[code] = (acc[code] || 0) + 1;
      return acc;
    }, {});
    const sorted = Object.entries(majority).sort((a, b) => b[1] - a[1]);
    if (sorted.length) quotePackageCode = sorted[0][0];
  }

  const isShortStay = nights != null && nights < 7;

  if (isShortStay) {
    quotePackageCode = 'package_none';
  } else if (isNoPackageBookingCode(quotePackageCode)) {
    quotePackageCode = null;
  }

  let guestPackagesForQuote = gp;
  if (isShortStay && guestCount > 0 && !gp.length) {
    guestPackagesForQuote = [];
    for (let i = 0; i < guestCount; i++) {
      guestPackagesForQuote.push({ guest_number: i + 1, package_code: 'package_none' });
    }
  }

  const storagePackageCode = quotePackageCode === 'package_none' ? null : quotePackageCode;

  return {
    nights,
    isShortStay,
    isNoPackage: quotePackageCode === 'package_none',
    quotePackageCode,
    storagePackageCode,
    guestPackagesForQuote,
  };
}

module.exports = {
  NO_PACKAGE_CODES,
  isNoPackageBookingCode,
  normalizePackageCodeAlias,
  resolveBotBookingPackageContext,
};
