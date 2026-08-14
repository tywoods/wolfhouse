'use strict';

/**
 * EMAIL-MATCH-001 — Sunset inbound guest email match (offline helper).
 *
 * Exact email match against caller-supplied Sunset guest records.
 * Unknown email → unmatched. No fuzzy name match, no DB, no invented guests.
 *
 * @module email-inbound-guest-email-match
 */

const { normalizeInboundEmailAddress } = require('./email-inbound-conversation-identity');

/**
 * @param {string} fromAddress
 * @param {Array<{ guest_id?: string, id?: string, email?: string }>} guests
 * @returns {{ status: 'matched', guest_id: string } | { status: 'unmatched' }}
 */
function matchSunsetGuestByInboundEmail(fromAddress, guests) {
  const normalizedFrom = normalizeInboundEmailAddress(fromAddress);
  if (!normalizedFrom) {
    return Object.freeze({ status: 'unmatched' });
  }
  if (!Array.isArray(guests)) {
    return Object.freeze({ status: 'unmatched' });
  }

  for (const record of guests) {
    if (!record || typeof record !== 'object') continue;
    const recordEmail = normalizeInboundEmailAddress(record.email);
    if (!recordEmail || recordEmail !== normalizedFrom) continue;

    const guestId = typeof record.guest_id === 'string' && record.guest_id.trim()
      ? record.guest_id.trim()
      : (typeof record.id === 'string' && record.id.trim() ? record.id.trim() : null);
    if (!guestId) continue;

    return Object.freeze({ status: 'matched', guest_id: guestId });
  }

  return Object.freeze({ status: 'unmatched' });
}

module.exports = Object.freeze({
  matchSunsetGuestByInboundEmail,
});
