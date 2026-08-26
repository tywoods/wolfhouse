'use strict';

const { computeStayNights } = require('./wolfhouse-package-night-rules');
const { KNOWN_PACKAGES } = require('./booking-guests');

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

/**
 * Whether quote reply copy should skip the package shuttle question.
 */
function shouldSkipShuttleInQuoteReply({ isShortStay, isNoPackage, packageCode, quotePackageCode }) {
  if (isShortStay || isNoPackage) return true;
  if (isNoPackageBookingCode(packageCode)) return true;
  if (isNoPackageBookingCode(quotePackageCode)) return true;
  return false;
}

/** Maps guest package selector values to DB storage (null = no package). */
function guestPackageStorageCode(raw) {
  const c = String(raw || '').trim().toLowerCase();
  if (!c || c === 'no_package' || c === 'package_none') return null;
  return c;
}

const PACKAGE_CODE_RE = /^[a-z][a-z0-9_-]{0,62}$/;

function isValidGuestPackageCode(code, fallbackPackageCode) {
  const c = String(code || '').trim().toLowerCase();
  if (!c) return false;
  if (NO_PACKAGE_CODES.has(c)) return true;
  if (KNOWN_PACKAGES.includes(c)) return true;
  if (fallbackPackageCode && c === String(fallbackPackageCode).trim().toLowerCase()) return true;
  /* Admin Pricing can add packages (e.g. Rincon) that are not in the legacy three. */
  if (c !== 'manual_override' && PACKAGE_CODE_RE.test(c)) return true;
  return false;
}

function guestPackagesMajorityStorageCode(guestPackages) {
  const counts = new Map();
  for (const gp of guestPackages) {
    const stored = guestPackageStorageCode(gp.package_code);
    const key = stored || '__no_package__';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let bestKey = null;
  let bestCount = 0;
  for (const [key, count] of counts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  if (bestKey === '__no_package__') return null;
  return bestKey;
}

function normalizeGuestPackagesInput(raw, guestCount, fallbackPackageCode) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'guest_packages array is required' };
  }
  if (raw.length !== guestCount) {
    return {
      error: `guest_packages length (${raw.length}) must match guest_count (${guestCount})`,
    };
  }
  const normalized = [];
  for (let i = 0; i < guestCount; i++) {
    const item = raw[i];
    const guestNumber = Number(item && item.guest_number) || (i + 1);
    const packageCodeRaw = String(
      (item && item.package_code) || fallbackPackageCode || '',
    ).trim().toLowerCase();
    if (!packageCodeRaw) {
      return { error: `package_code is required for guest ${guestNumber}` };
    }
    if (!isValidGuestPackageCode(packageCodeRaw, fallbackPackageCode)) {
      return { error: `Invalid package_code for guest ${guestNumber}` };
    }
    normalized.push({ guest_number: i + 1, package_code: packageCodeRaw });
  }
  return { guest_packages: normalized };
}

/**
 * Standard bot quote reply_draft after a successful calculateWolfhouseQuote.
 */
function buildBotQuoteReplyDraft(quote, pkgCtx, packageCode) {
  const totalEur = (quote.total_cents / 100).toFixed(2);
  const depositEur = (quote.deposit_required_cents / 100).toFixed(2);
  if (shouldSkipShuttleInQuoteReply({
    isShortStay: pkgCtx.isShortStay,
    isNoPackage: pkgCtx.isNoPackage,
    packageCode,
    quotePackageCode: pkgCtx.quotePackageCode,
  })) {
    return `For those dates, the estimated total is €${totalEur}. The deposit is €${depositEur}. Does that look good? 😊`;
  }
  return `For those dates, the estimated total is €${totalEur}. The deposit is €${depositEur}. Do you need the free Santander airport shuttle for your arrival?`;
}

module.exports = {
  NO_PACKAGE_CODES,
  isNoPackageBookingCode,
  normalizePackageCodeAlias,
  guestPackagesMajorityStorageCode,
  normalizeGuestPackagesInput,
  resolveBotBookingPackageContext,
  shouldSkipShuttleInQuoteReply,
  buildBotQuoteReplyDraft,
};
