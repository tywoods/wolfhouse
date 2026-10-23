'use strict';

// Deposit tier follows the guest's package, never the length of the stay.
// Staff Pricing owns standard_package / custom_or_short_stay amounts (defaults
// €200 / €100 per person). Keep the legacy long_stay/short_stay rate keys for
// existing Pricing readers; they now denote package / accommodation tiers.
// Per-guest date edits KEEP the historical stored booking deposit: their dates
// are only an envelope, not a new deposit pricing basis.
const { isWeeklySurfPackage } = require('./wolfhouse-package-night-rules');
// Deprecated compatibility export only; no deposit decision uses this threshold.
const LONG_STAY_NIGHTS = 6;
const LONG_STAY_RATE_CENTS = 20000;
const SHORT_STAY_RATE_CENTS = 10000;
const LONG_STAY_TIER = 'standard_package';
const SHORT_STAY_TIER = 'custom_or_short_stay';

function finiteRateCents(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

function wolfhouseDepositRatesFromConfig(config) {
  const tiers = (config && config.deposits && config.deposits.tiers) || {};
  const longTier = tiers[LONG_STAY_TIER] || {};
  const shortTier = tiers[SHORT_STAY_TIER] || {};
  return {
    long_stay_cents: finiteRateCents(longTier.amount_cents, LONG_STAY_RATE_CENTS),
    short_stay_cents: finiteRateCents(shortTier.amount_cents, SHORT_STAY_RATE_CENTS),
    source: 'admin_pricing',
  };
}

function normalizeStayDepositRates(rates) {
  if (!rates || typeof rates !== 'object') return null;
  return {
    long_stay_cents: finiteRateCents(rates.long_stay_cents, LONG_STAY_RATE_CENTS),
    short_stay_cents: finiteRateCents(rates.short_stay_cents, SHORT_STAY_RATE_CENTS),
    source: rates.source || 'admin_pricing',
  };
}

async function loadWolfhouseDepositRates(pg) {
  const { loadPricingConfig, applyOverlayPricesToConfig, WH_PRICING_CLIENT_SLUG } = require('./wolfhouse-pricing-resolve');
  let config = loadPricingConfig();
  if (pg) {
    try {
      const store = require('./wolfhouse-pricing-store');
      // Pricing reads must work in read-only transactions. Schema initialization
      // belongs to migrations/Admin writes; failed DDL here used to skip the
      // SELECT and silently replace readable saved rates with seed amounts.
      const rules = await store.loadRules(pg, WH_PRICING_CLIENT_SLUG);
      config = applyOverlayPricesToConfig(config, rules);
    } catch (_) {
      // JSON seed amounts are the Ty defaults when Admin Pricing is unreadable.
    }
  }
  return wolfhouseDepositRatesFromConfig(config);
}

function wolfhouseStayNights(checkIn, checkOut) {
  const start = String(checkIn || '').slice(0, 10);
  const end = String(checkOut || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const nights = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
  return Number.isInteger(nights) && nights > 0 ? nights : null;
}

function wolfhouseStayDepositRateCents(nights, rates, packageCode) {
  const n = Number(nights);
  if (!Number.isInteger(n) || n < 1) return null;
  const resolved = normalizeStayDepositRates(rates);
  const longRate = resolved ? resolved.long_stay_cents : LONG_STAY_RATE_CENTS;
  const shortRate = resolved ? resolved.short_stay_cents : SHORT_STAY_RATE_CENTS;
  return isWeeklySurfPackage(packageCode) ? longRate : shortRate;
}

function wolfhouseStayDepositCents(nights, guestCount, rates, packageCode) {
  const rate = wolfhouseStayDepositRateCents(nights, rates, packageCode);
  const guests = Number(guestCount);
  if (rate == null || !Number.isInteger(guests) || guests < 1) return null;
  const total = rate * guests;
  return Number.isSafeInteger(total) ? total : null;
}

function wolfhouseBookingDepositCents(booking, rates) {
  booking = booking || {};
  const snapshot = booking.metadata && booking.metadata.quote_snapshot;
  if (snapshot && snapshot.per_guest_dates === true) {
    const value = booking.deposit_required_cents;
    // Explicit zero is valid; absent/invalid history fails closed, never reprices.
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const stored = Number(value);
    return Number.isSafeInteger(stored) && stored >= 0 ? stored : null;
  }
  const useRates = normalizeStayDepositRates(rates) || normalizeStayDepositRates(booking.stay_deposit_rates);
  const nights = wolfhouseStayNights(booking.check_in, booking.check_out);
  const metadata = booking.metadata || {};
  const guestPackages = [booking.guest_packages, metadata.guest_packages, snapshot && snapshot.guest_packages]
    .find(rows => Array.isArray(rows) && rows.length > 0);
  const packageCode = booking.package_code || metadata.package_code || (snapshot && snapshot.package_code);
  const shares = snapshot && snapshot.per_person;
  let ruled;
  if (guestPackages || shares != null) {
    // Current Pricing supplies tiers; the persisted quote supplies each person's
    // commercial ceiling. A whole-invoice cap cannot preserve a cheap guest's cap.
    if (shares != null && (!Array.isArray(shares) || shares.length !== Number(booking.guest_count))) return null;
    const rows = guestPackages || shares.map(person => ({ guest_number: person && person.guest_number, package_code: packageCode }));
    if (rows.length !== Number(booking.guest_count)) return null;
    const seen = new Set();
    const amounts = rows.map(row => {
      if (!row || typeof row.package_code !== 'string' || !row.package_code.trim()) return null;
      const rate = wolfhouseStayDepositRateCents(nights, useRates, row.package_code);
      if (rate == null || shares == null) return rate;
      const number = row.guest_number;
      if (!Number.isInteger(number) || number < 1 || number > rows.length || seen.has(number)) return null;
      seen.add(number);
      const matches = shares.filter(person => person && person.guest_number === number);
      if (matches.length !== 1) return null;
      const person = matches[0];
      const identity = code => isWeeklySurfPackage(code) ? String(code).trim().toLowerCase() : 'package_none';
      if (identity(person.package_code) !== identity(row.package_code)
        || !Number.isSafeInteger(person.subtotal_cents) || person.subtotal_cents < 0) return null;
      return Math.min(rate, person.subtotal_cents);
    });
    if (amounts.some(amount => amount == null)) return null;
    ruled = amounts.reduce((sum, amount) => sum + amount, 0);
    if (!Number.isSafeInteger(ruled)) return null;
  } else {
    ruled = wolfhouseStayDepositCents(nights, booking.guest_count, useRates, packageCode);
  }
  if (ruled != null) return ruled;
  if (booking.deposit_required_cents == null || booking.deposit_required_cents === '') return null;
  const stored = Number(booking.deposit_required_cents);
  return Number.isSafeInteger(stored) && stored >= 0 ? stored : null;
}

module.exports = {
  LONG_STAY_NIGHTS,
  LONG_STAY_RATE_CENTS,
  SHORT_STAY_RATE_CENTS,
  LONG_STAY_TIER,
  SHORT_STAY_TIER,
  wolfhouseDepositRatesFromConfig,
  normalizeStayDepositRates,
  loadWolfhouseDepositRates,
  wolfhouseStayNights,
  wolfhouseStayDepositRateCents,
  wolfhouseStayDepositCents,
  wolfhouseBookingDepositCents,
};
