/**
 * Phase 11g — Staff Ask Luna booking / guest lookup (read-only).
 *
 * Structured sources: bookings, booking_beds, clients, booking_service_records.
 *
 * @module staff-ask-luna-booking-lookup
 */

'use strict';

const LOOKUP_KEY = 'bookings.lookup';

const BOOKING_CODE_RE = /\b(WH-[A-Z0-9][A-Z0-9-]*)\b/i;
const ROOM_BED_CODE_RE = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)$/;

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function normalizeLookupQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function cleanGuestSearchName(name) {
  let n = String(name || '').trim();
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/\b(booking|bookings|the|a|an|my|his|her|their)\b/gi, '').trim();
  if (n.length < 2) return null;
  return n;
}

function extractBookingCode(raw, q) {
  const m = String(raw || q || '').match(BOOKING_CODE_RE);
  return m ? m[1].toUpperCase() : null;
}

function extractGuestName(raw, q) {
  const rawStr = String(raw || '');
  let m = rawStr.match(/\b(?:show|find|lookup|look\s+up)\s+(.+?)'s\s+booking\b/i);
  if (m) return cleanGuestSearchName(m[1]);

  m = q.match(/\b(?:show|find|lookup|look\s+up)\s+(?:booking\s+)?(.+?)(?:\s+s)?\s+booking\b/);
  if (m) return cleanGuestSearchName(m[1]);

  m = q.match(/\bwhat\s+(?:room|bed)\s+is\s+(.+?)\s+in\b/);
  if (m) return cleanGuestSearchName(m[1]);

  m = q.match(/\bwhen\s+does\s+(.+?)\s+(?:check\s+out|leave|depart)\b/);
  if (m) return cleanGuestSearchName(m[1]);

  m = q.match(/\bwhen\s+does\s+(.+?)\s+(?:arrive|check\s+in)\b/);
  if (m) return cleanGuestSearchName(m[1]);

  return null;
}

function extractRoomOrBed(raw, q) {
  let m = String(raw || q || '').match(
    /\bwho\s+is\s+in\s+(?:the\s+)?(?:bed\s+)?([A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)\b/i,
  );
  if (!m) {
    m = q.match(/\bwho\s+is\s+in\s+(?:the\s+)?(?:bed\s+)?([a-z0-9]+(?:-[a-z0-9]+)?)\b/);
  }
  if (!m) return null;

  const token = m[1].toUpperCase();
  const bedMatch = token.match(ROOM_BED_CODE_RE);
  if (bedMatch) {
    return { lookupMode: 'bed', roomCode: bedMatch[1], bedCode: bedMatch[2], searchValue: token };
  }
  return { lookupMode: 'room', searchValue: token };
}

function detectLookupFocus(q) {
  if (/\bwhat\s+room\b/.test(q)) return 'room';
  if (/\bwhat\s+bed\b/.test(q)) return 'bed';
  if (/\b(?:check\s+out|leave|depart)\b/.test(q)) return 'checkout';
  if (/\b(?:arrive|check\s+in)\b/.test(q)) return 'arrival';
  return 'general';
}

/**
 * @returns {{ intentKey: string, extraParams: object } | { intentKey: 'unsupported_intent', intentHint: string } | null}
 */
function resolveAskLunaBookingLookupIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim();
  const rawLower = raw.toLowerCase();
  const q = normalizeLookupQuestionText(question);

  if (registryByKey && registryByKey.has(rawLower) && rawLower === LOOKUP_KEY) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Booking lookup needs a guest name, booking code (WH-…), or room/bed (e.g. R1 or R2-B1).',
    };
  }

  const code = extractBookingCode(raw, q);
  if (code) {
    return {
      intentKey: LOOKUP_KEY,
      extraParams: {
        lookupMode: 'booking_code',
        searchValue: code,
        lookupFocus: 'general',
        refDate: askLunaIsoDateUTC(refDate),
      },
    };
  }

  const occupancy = extractRoomOrBed(raw, q);
  if (occupancy) {
    return {
      intentKey: LOOKUP_KEY,
      extraParams: {
        ...occupancy,
        lookupFocus: 'general',
        refDate: askLunaIsoDateUTC(refDate),
      },
    };
  }

  const guest = extractGuestName(raw, q);
  if (guest) {
    return {
      intentKey: LOOKUP_KEY,
      extraParams: {
        lookupMode: 'guest_name',
        searchValue: guest,
        lookupFocus: detectLookupFocus(q),
        refDate: askLunaIsoDateUTC(refDate),
      },
    };
  }

  if (/\b(?:show|find|lookup|look\s+up)\b/.test(q) && /\bbooking\b/.test(q)) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Include a guest name or booking code (WH-…) to look up a booking.',
    };
  }

  return null;
}

function bookingLookupBaseSelect() {
  return `
SELECT
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in::text  AS check_in,
  b.check_out::text AS check_out,
  b.status::text    AS booking_status,
  b.payment_status::text AS payment_status,
  b.balance_due_cents,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb.room_code || COALESCE('-' || NULLIF(bb.bed_code, ''), '') AS rm_bed
       FROM booking_beds bb
       WHERE bb.booking_id = b.id
         AND bb.room_code IS NOT NULL
     ) beds),
    NULLIF(b.primary_room_code, ''),
    ''
  ) AS bed_summary,
  (
    SELECT NULLIF(STRING_AGG(svc.line, ', ' ORDER BY svc.line), '')
    FROM (
      SELECT
        CASE LOWER(sr.service_type::text)
          WHEN 'meal' THEN
            SUM(sr.quantity)::text || ' meal' || CASE WHEN SUM(sr.quantity) > 1 THEN 's' ELSE '' END
          WHEN 'surf_lesson' THEN
            SUM(sr.quantity)::text || ' surf lesson' || CASE WHEN SUM(sr.quantity) > 1 THEN 's' ELSE '' END
          WHEN 'yoga' THEN
            SUM(sr.quantity)::text || ' yoga'
          WHEN 'wetsuit' THEN
            CASE WHEN SUM(sr.quantity) > 1 THEN SUM(sr.quantity)::text || ' wetsuits' ELSE 'wetsuit' END
          WHEN 'surfboard' THEN
            CASE WHEN SUM(sr.quantity) > 1 THEN SUM(sr.quantity)::text || ' surfboards' ELSE 'surfboard' END
          ELSE LOWER(sr.service_type::text)
        END AS line
      FROM booking_service_records sr
      WHERE sr.booking_id = b.id
        AND sr.status <> 'cancelled'
      GROUP BY sr.service_type
    ) svc
  ) AS services_summary
`;
}

function getAskLunaBookingLookupByCodeQuery() {
  return `${bookingLookupBaseSelect()}
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND UPPER(b.booking_code) = UPPER($2)
ORDER BY b.check_in DESC NULLS LAST
LIMIT 5
`;
}

function getAskLunaBookingLookupByGuestQuery() {
  return `${bookingLookupBaseSelect()}
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.guest_name ILIKE $2
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND (b.check_out >= $3::date OR b.check_in >= $3::date)
ORDER BY b.check_in ASC NULLS LAST, b.booking_code ASC
LIMIT 10
`;
}

function getAskLunaBookingLookupByRoomQuery() {
  return `${bookingLookupBaseSelect()}
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND (b.check_out >= $2::date OR b.check_in >= $2::date)
  AND (
    EXISTS (
      SELECT 1 FROM booking_beds bb
      WHERE bb.booking_id = b.id
        AND UPPER(bb.room_code) = UPPER($3)
    )
    OR UPPER(NULLIF(b.primary_room_code, '')) = UPPER($3)
  )
ORDER BY b.check_in ASC NULLS LAST, b.booking_code ASC
LIMIT 20
`;
}

function getAskLunaBookingLookupByBedQuery() {
  return `${bookingLookupBaseSelect()}
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
INNER JOIN booking_beds bb ON bb.booking_id = b.id
WHERE c.slug = $1
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
  AND (b.check_out >= $4::date OR b.check_in >= $4::date)
  AND UPPER(bb.room_code) = UPPER($2)
  AND UPPER(bb.bed_code) = UPPER($3)
ORDER BY b.check_in ASC NULLS LAST, b.booking_code ASC
LIMIT 20
`;
}

/**
 * @param {object} extraParams
 * @param {string} clientSlug
 * @returns {{ sql: string, params: unknown[] }}
 */
function buildAskLunaBookingLookupQuery(extraParams, clientSlug) {
  const mode = extraParams.lookupMode;
  const refDate = extraParams.refDate || askLunaIsoDateUTC(new Date());

  if (mode === 'booking_code') {
    return {
      sql: getAskLunaBookingLookupByCodeQuery(),
      params: [clientSlug, extraParams.searchValue],
    };
  }
  if (mode === 'guest_name') {
    return {
      sql: getAskLunaBookingLookupByGuestQuery(),
      params: [clientSlug, `%${extraParams.searchValue}%`, refDate],
    };
  }
  if (mode === 'room') {
    return {
      sql: getAskLunaBookingLookupByRoomQuery(),
      params: [clientSlug, refDate, extraParams.searchValue],
    };
  }
  if (mode === 'bed') {
    return {
      sql: getAskLunaBookingLookupByBedQuery(),
      params: [clientSlug, extraParams.roomCode, extraParams.bedCode, refDate],
    };
  }
  throw new Error(`unsupported booking lookup mode: ${mode}`);
}

function formatShortDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
}

function formatStayRange(checkIn, checkOut) {
  const a = formatShortDate(checkIn);
  const b = formatShortDate(checkOut);
  if (a && b) return `${a}–${b}`;
  return a || b || '';
}

function formatStatusLabel(status) {
  const s = String(status || '').trim();
  if (!s) return 'Unknown';
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

function formatEuro(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `€${(Math.round(n) / 100).toFixed(0)}`;
}

function formatLookupPayment(row) {
  const ps = String(row.payment_status || '').toLowerCase();
  const bal = formatEuro(row.balance_due_cents);
  const balPart = bal ? `, ${bal} balance due` : '';
  if (ps === 'paid') return 'Paid in full';
  if (ps === 'deposit_paid') return `Deposit paid${balPart}`;
  if (ps === 'waiting_payment' || ps === 'not_requested') return 'Payment pending';
  if (bal) return `${bal} balance due`;
  if (ps) return ps.replace(/_/g, ' ');
  return '';
}

function guestCountLabel(count) {
  const n = Number(count) > 0 ? Number(count) : 1;
  return `${n} guest${n !== 1 ? 's' : ''}`;
}

function dedupeBookings(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const code = r.booking_code;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(r);
  }
  return out;
}

function formatSingleBooking(row, ctx = {}) {
  const name = row.guest_name || row.booking_code || 'Guest';
  const stay = formatStayRange(row.check_in, row.check_out);
  const bed = row.bed_summary || '';
  const focus = ctx.lookupFocus || 'general';
  const lines = [];

  if (focus === 'checkout' && row.check_out) {
    lines.push(`${name} checks out ${formatShortDate(row.check_out)}${bed ? ` (${bed})` : ''}.`);
  } else if (focus === 'arrival' && row.check_in) {
    lines.push(`${name} arrives ${formatShortDate(row.check_in)}${bed ? ` (${bed})` : ''}.`);
  } else if (focus === 'room' || focus === 'bed') {
    lines.push(`${name} is in ${bed || 'no room assigned yet'}.`);
  } else {
    lines.push(`${name} is booked ${stay}${bed ? ` in ${bed}` : ''}.`);
  }

  lines.push('');
  lines.push(`Booking: ${row.booking_code || '?'}`);
  lines.push(`Guests: ${guestCountLabel(row.guest_count)}`);
  lines.push(`Status: ${formatStatusLabel(row.booking_status)}`);
  const pay = formatLookupPayment(row);
  if (pay) lines.push(`Payment: ${pay}`);
  if (row.services_summary) lines.push(`Services: ${row.services_summary}`);
  if (stay && (focus === 'checkout' || focus === 'arrival')) {
    lines.push(`Stay: ${stay}`);
  }
  return lines.join('\n');
}

function formatDisambiguationList(rows, searchName) {
  const list = dedupeBookings(rows);
  const lines = [
    `I found ${list.length} active/upcoming bookings for ${searchName}:`,
    '',
  ];
  list.forEach((r, i) => {
    const name = r.guest_name || r.booking_code || 'Guest';
    const stay = formatStayRange(r.check_in, r.check_out);
    const bed = r.bed_summary ? ` — ${r.bed_summary}` : '';
    lines.push(`${i + 1}. ${name} — ${r.booking_code} — ${stay}${bed}`);
  });
  lines.push('');
  lines.push('Please ask with the booking code or full name.');
  return lines.join('\n');
}

function formatRoomOccupancy(rows, ctx = {}) {
  const list = dedupeBookings(rows);
  const label = ctx.searchValue || ctx.roomCode
    ? `${ctx.searchValue || `${ctx.roomCode}-${ctx.bedCode}`}`
    : 'that room/bed';
  if (list.length === 0) {
    return `No active guests are currently assigned to ${label}.`;
  }
  const lines = [
    `${label} currently has ${list.length} active guest${list.length !== 1 ? 's' : ''} assigned:`,
    '',
  ];
  for (const r of list) {
    const stay = formatStayRange(r.check_in, r.check_out);
    const bed = r.bed_summary ? ` — ${r.bed_summary}` : '';
    lines.push(`* ${r.guest_name || r.booking_code} — ${r.booking_code} — ${stay}${bed}`);
  }
  lines.push('');
  lines.push(`Total: ${list.length} guest${list.length !== 1 ? 's' : ''}/booking${list.length !== 1 ? 's' : ''}.`);
  return lines.join('\n');
}

/**
 * @param {object[]} rows
 * @param {object} [ctx]
 */
function formatAskLunaBookingLookupAnswer(rows, ctx = {}) {
  const list = rows || [];
  const mode = ctx.lookupMode || 'guest_name';

  if (list.length === 0) {
    return 'I couldn\'t find an active booking matching that.';
  }

  if (mode === 'room' || mode === 'bed') {
    return formatRoomOccupancy(list, ctx);
  }

  const bookings = dedupeBookings(list);
  if (bookings.length > 1 && mode === 'guest_name') {
    return formatDisambiguationList(bookings, ctx.searchValue || 'that guest');
  }

  return formatSingleBooking(bookings[0], ctx);
}

function getAskLunaBookingLookupRoutingSmokeBlock() {
  const consts = `
const LOOKUP_KEY = ${JSON.stringify(LOOKUP_KEY)};
const BOOKING_CODE_RE = ${BOOKING_CODE_RE.toString()};
const ROOM_BED_CODE_RE = ${ROOM_BED_CODE_RE.toString()};
`;
  const fns = [
    askLunaIsoDateUTC,
    normalizeLookupQuestionText,
    cleanGuestSearchName,
    extractBookingCode,
    extractGuestName,
    extractRoomOrBed,
    detectLookupFocus,
    resolveAskLunaBookingLookupIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  LOOKUP_KEY,
  resolveAskLunaBookingLookupIntentKey,
  buildAskLunaBookingLookupQuery,
  getAskLunaBookingLookupByCodeQuery,
  getAskLunaBookingLookupByGuestQuery,
  getAskLunaBookingLookupByRoomQuery,
  getAskLunaBookingLookupByBedQuery,
  formatAskLunaBookingLookupAnswer,
  dedupeBookings,
  getAskLunaBookingLookupRoutingSmokeBlock,
};
