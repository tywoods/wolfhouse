'use strict';

/**
 * Stage 56c — multi-booking disambiguation for post-booking service requests.
 *
 * When a guest with multiple active bookings asks to add a service (meals/yoga),
 * we must ask which booking they mean before attaching.
 */

const RELEVANT_STATUSES_SQL = `'confirmed','hold'`;
const RELEVANT_PAYMENT_SQL = `'deposit_paid','paid','full_paid','balance_due'`;

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

/**
 * Load bookings that are active/payable for a given phone number.
 * Returns at most 5, ordered by check_in ASC.
 */
async function loadActiveGuestBookings(pg, opts) {
  const o = opts || {};
  if (!pg || typeof pg.query !== 'function') return [];
  const phone = trimStr(o.phone).replace(/\D/g, ''); // digits only for LIKE
  if (!phone) return [];
  const suffix = phone.slice(-9); // last 9 digits for flexible international matching

  const rows = (await pg.query(
    `SELECT id::text AS booking_id,
            booking_code,
            check_in::date  AS check_in,
            check_out::date AS check_out,
            status::text         AS status,
            payment_status::text AS payment_status,
            guest_count,
            guest_name
       FROM bookings
      WHERE phone LIKE $1
        AND status::text       IN (${RELEVANT_STATUSES_SQL})
        AND payment_status::text IN (${RELEVANT_PAYMENT_SQL})
      ORDER BY check_in ASC
      LIMIT 5`,
    [`%${suffix}%`],
  )).rows;

  return rows;
}

/**
 * Returns true when there are multiple active bookings and no booking_id is
 * already anchored in the guest's context for this turn.
 */
function needsBookingDisambiguation(activeBookings, contextBookingId) {
  if (!Array.isArray(activeBookings) || activeBookings.length <= 1) return false;
  return !trimStr(contextBookingId);
}

/** Format a date string (ISO or Date) as "Aug 10" */
function fmtDate(dateVal) {
  if (!dateVal) return '';
  const d = new Date(dateVal);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Build the disambiguation reply listing numbered bookings.
 * @param {string} lang - detected language
 * @param {Array} bookings - active booking rows from DB
 * @param {string} serviceType - 'meals' | 'yoga'
 */
function buildBookingChoiceReply(lang, bookings, serviceType) {
  const L = trimStr(lang).slice(0, 2) || 'en';
  const svcLabel = serviceType === 'yoga' ? 'yoga' : 'meals';

  const lines = bookings.map((b, i) => {
    const ci = fmtDate(b.check_in);
    const co = fmtDate(b.check_out);
    const code = trimStr(b.booking_code);
    const nights = b.check_in && b.check_out
      ? Math.round((new Date(b.check_out) - new Date(b.check_in)) / 86400000)
      : null;
    const nightStr = nights ? ` (${nights} nights)` : '';
    return `${i + 1}. ${ci}–${co}${nightStr} — ${code}`;
  });

  if (L === 'de') {
    return `Du hast ${bookings.length} aktive Buchungen:\n${lines.join('\n')}\n\nFür welche möchtest du ${svcLabel === 'yoga' ? 'Yoga' : 'Mahlzeiten'} buchen?`;
  }
  if (L === 'es') {
    return `Tienes ${bookings.length} reservas activas:\n${lines.join('\n')}\n\n¿Para cuál deseas añadir ${svcLabel}?`;
  }
  return `You have ${bookings.length} active bookings:\n${lines.join('\n')}\n\nWhich one would you like to add ${svcLabel} to?`;
}

/**
 * Try to parse which booking the guest chose from their reply message.
 * Handles: "1", "first", "the august one", booking code fragment, date mention.
 *
 * @param {string} messageText
 * @param {Array} bookings - same ordered list that was shown
 * @returns {object|null} matched booking row or null
 */
function parseBookingSelectionFromMessage(messageText, bookings) {
  if (!Array.isArray(bookings) || !bookings.length) return null;
  const t = trimStr(messageText).toLowerCase();

  // Ordinal numbers: "1", "first", "one", "2", "second", etc.
  const ORDINALS = {
    1: ['1', 'first', 'one', '1st'],
    2: ['2', 'second', 'two', '2nd'],
    3: ['3', 'third', 'three', '3rd'],
    4: ['4', 'fourth', 'four', '4th'],
    5: ['5', 'fifth', 'five', '5th'],
  };
  for (const [idxStr, words] of Object.entries(ORDINALS)) {
    const idx = Number(idxStr) - 1;
    if (idx >= bookings.length) continue;
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) return bookings[idx];
  }

  // Booking code substring match (bidirectional: message ⊇ part OR part ⊇ message-token)
  for (const bk of bookings) {
    const code = trimStr(bk.booking_code).toLowerCase();
    if (t.includes(code)) return bk;
    const codeNoHyphens = code.replace(/-/g, '');
    // Extract alphanumeric tokens from the message and check if the booking code contains them
    const tokens = (t.match(/[a-z0-9]{4,}/g) || []);
    for (const tok of tokens) {
      if (codeNoHyphens.includes(tok)) return bk;
    }
  }

  // Month name match against check_in
  const MONTH_MAP = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
    aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
    nov: 10, november: 10, dec: 11, december: 11,
  };
  for (const [word, monthIdx] of Object.entries(MONTH_MAP)) {
    if (new RegExp(`\\b${word}\\b`).test(t)) {
      const match = bookings.find((bk) => {
        if (!bk.check_in) return false;
        return new Date(bk.check_in).getUTCMonth() === monthIdx;
      });
      if (match) return match;
    }
  }

  // Last resort: if there's only one remaining candidate after filtering, pick it
  return null;
}

/**
 * Detect service type from message text alone (for disambiguation context building).
 * Returns 'meals', 'yoga', or null.
 */
function detectServiceTypeFromText(text) {
  const t = trimStr(text).toLowerCase();
  if (/\b(?:yoga)\b/.test(t)) return 'yoga';
  if (/\b(?:meal|meals|dinner|breakfast|lunch|food)\b/.test(t)) return 'meals';
  return null;
}

module.exports = {
  loadActiveGuestBookings,
  needsBookingDisambiguation,
  buildBookingChoiceReply,
  parseBookingSelectionFromMessage,
  detectServiceTypeFromText,
  fmtDate,
};
