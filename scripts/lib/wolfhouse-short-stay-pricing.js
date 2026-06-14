'use strict';

/**
 * Stage 28j.4 — Shared short-stay accommodation pricing (Luna + Staff Portal).
 *
 * Delegates to calculateWolfhouseQuote with package_none — same Malibu weekly
 * reference, ÷7, ceil to nearest €5 per night, × nights × guests.
 */

const { calculateWolfhouseQuote, ceil5, loadConfig } = require('./wolfhouse-quote-calculator');
const { computeStayNights } = require('./wolfhouse-package-night-rules');

/**
 * Quote an under-7-night accommodation-only stay (package_none).
 * @param {object} input  { client_slug, check_in, check_out, guest_count, room_type?, payment_choice? }
 * @param {object} [config]
 */
function quoteShortStayAccommodation(input, config) {
  const inp = input || {};
  return calculateWolfhouseQuote({
    client_slug: inp.client_slug || 'wolfhouse-somo',
    check_in: inp.check_in,
    check_out: inp.check_out,
    guest_count: inp.guest_count,
    package_code: 'package_none',
    room_type: inp.room_type || 'shared',
    payment_choice: inp.payment_choice || 'deposit',
    add_ons: inp.add_ons || [],
  }, config);
}

function isShortStayAccommodationQuote(quote) {
  if (!quote || !quote.success) return false;
  const nights = quote.nights;
  const pkg = String(quote.package_code || '').toLowerCase();
  return nights != null && nights < 7 && (pkg === 'package_none' || pkg === 'no_package');
}

module.exports = {
  quoteShortStayAccommodation,
  isShortStayAccommodationQuote,
  computeStayNights,
  ceil5,
  loadConfig,
};
