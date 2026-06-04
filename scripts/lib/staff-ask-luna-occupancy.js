/**
 * Phase 11k — Staff Ask Luna occupancy / staying tonight (read-only).
 *
 * Nights-based: check_in <= night AND check_out > night.
 * Sources: bookings, booking_beds, clients.
 *
 * @module staff-ask-luna-occupancy
 */

'use strict';

const OCCUPANCY_TONIGHT_KEY = 'bookings.occupancy_tonight';
const OCCUPANCY_TOMORROW_NIGHT_KEY = 'bookings.occupancy_tomorrow_night';
const OCCUPANCY_REGISTRY_KEYS = new Set([OCCUPANCY_TONIGHT_KEY, OCCUPANCY_TOMORROW_NIGHT_KEY]);

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function askLunaTodayUTC(refDate = new Date()) {
  return askLunaIsoDateUTC(refDate);
}

function askLunaTomorrowUTC(refDate = new Date()) {
  const d = new Date(refDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return askLunaIsoDateUTC(d);
}

function normalizeOccupancyQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function askLunaHasTonightWord(q) {
  return /\b(tonight|this\s+night)\b/.test(q);
}

function askLunaHasTomorrowNightWord(q) {
  return /\b(tomorrow\s+night|tomorrow\s+evening)\b/.test(q)
    || (/\btomorrow\b/.test(q) && /\b(staying|in\s+house|occupied|occupancy|guests?)\b/.test(q));
}

function matchesOccupancyTopic(q) {
  if (/\b(staying|in\s+house|occupied|occupancy)\b/.test(q)) return true;
  if (/\bcurrently\s+in\s+house\b/.test(q)) return true;
  if (/\bwho\s+is\s+in\s+(?:the\s+)?house\b/.test(q)) return true;
  if (/\bhow\s+many\s+guests?\b/.test(q) && /\b(staying|in\s+house|tonight|tomorrow)\b/.test(q)) return true;
  if (/\bwhich\s+rooms?\s+(?:are\s+)?occupied\b/.test(q)) return true;
  if (/\bwho\s+is\s+staying\b/.test(q)) return true;
  return false;
}

function isCheckoutTonightPhrase(q) {
  return /\b(check\s*out|checkout|checking\s+out|leav(e|ing)|depart)\b/.test(q)
    && /\b(tonight|today)\b/.test(q);
}

/**
 * @returns {{ intentKey: string, extraParams: { date: string, nightLabel: string } } | null}
 */
function resolveAskLunaOccupancyIntentKey(question, registryByKey, refDate = new Date()) {
  const rawLower = String(question || '').trim().toLowerCase();

  if (registryByKey && registryByKey.has(rawLower) && OCCUPANCY_REGISTRY_KEYS.has(rawLower)) {
    const isTomorrow = rawLower === OCCUPANCY_TOMORROW_NIGHT_KEY;
    return {
      intentKey: rawLower,
      extraParams: {
        date: isTomorrow ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate),
        nightLabel: isTomorrow ? 'tomorrow night' : 'tonight',
      },
    };
  }

  const q = normalizeOccupancyQuestionText(question);
  if (!matchesOccupancyTopic(q)) return null;
  if (isCheckoutTonightPhrase(q)) return null;

  if (askLunaHasTomorrowNightWord(q)) {
    return {
      intentKey: OCCUPANCY_TOMORROW_NIGHT_KEY,
      extraParams: {
        date: askLunaTomorrowUTC(refDate),
        nightLabel: 'tomorrow night',
      },
    };
  }

  if (askLunaHasTonightWord(q) || /\bcurrently\s+in\s+house\b/.test(q) || /\bin\s+house\b/.test(q)) {
    return {
      intentKey: OCCUPANCY_TONIGHT_KEY,
      extraParams: {
        date: askLunaTodayUTC(refDate),
        nightLabel: 'tonight',
      },
    };
  }

  return null;
}

/**
 * Occupancy on a calendar night ($2): check_in <= night AND check_out > night.
 * $1 = client slug, $2 = night date (YYYY-MM-DD)
 */
function getAskLunaOccupancyOnNightQuery() {
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
  COALESCE(bb.room_code, NULLIF(b.primary_room_code, '')) AS room_code,
  bb.bed_code,
  bb.planning_row_label
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN booking_beds bb ON bb.booking_id = b.id
WHERE c.slug = $1
  AND b.check_in <= $2::date
  AND b.check_out > $2::date
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY room_code ASC NULLS LAST, bed_code ASC NULLS LAST, b.guest_name ASC NULLS LAST, b.booking_code ASC
`;
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
  if (!a && !b) return '';
  if (!a) return b;
  if (!b) return a;
  const inM = String(checkIn).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const outM = String(checkOut).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (inM && outM && inM[1] === outM[1] && inM[2] === outM[2]) {
    return `${a}–${parseInt(outM[3], 10)}`;
  }
  return `${a}–${b}`;
}

function guestCountLabel(count) {
  const n = Number(count) > 0 ? Number(count) : 1;
  return `${n} guest${n !== 1 ? 's' : ''}`;
}

function bookingPaymentLabel(row) {
  const ps = String(row.payment_status || '').toLowerCase();
  if (ps === 'paid') return 'Paid in full';
  if (ps === 'deposit_paid') return 'Deposit paid';
  if (Number(row.balance_due_cents) > 0) return 'Balance due';
  if (ps === 'waiting_payment' || ps === 'not_requested') return 'Payment pending';
  if (ps) return ps.replace(/_/g, ' ');
  return '';
}

function roomBedLabel(row) {
  if (row.room_code && row.bed_code) return `${row.room_code}-${row.bed_code}`;
  if (row.room_code) return String(row.room_code);
  return '';
}

/**
 * @param {object[]} rows
 */
function buildOccupancyGroups(rows) {
  const bookingGuestCounts = new Map();
  let bedCount = 0;
  const roomMap = new Map();

  for (const r of rows || []) {
    if (!r.booking_code) continue;

    if (!bookingGuestCounts.has(r.booking_code)) {
      bookingGuestCounts.set(
        r.booking_code,
        Number(r.guest_count) > 0 ? Number(r.guest_count) : 1,
      );
    }

    const room = r.room_code || 'Unassigned';
    if (!roomMap.has(room)) {
      roomMap.set(room, { room_code: room, bedLines: [], roomOnlyBookings: new Map() });
    }
    const grp = roomMap.get(room);
    const hasBed = Boolean(r.bed_code);

    if (hasBed) {
      bedCount += 1;
      const key = `${r.booking_code}:${r.bed_code}`;
      if (!grp.bedLines.some((line) => line.lineKey === key)) {
        grp.bedLines.push({
          lineKey: key,
          guest_name: r.guest_name || r.booking_code,
          booking_code: r.booking_code,
          room_bed: roomBedLabel(r),
          check_in: r.check_in,
          check_out: r.check_out,
          guest_count: r.guest_count,
          payment_status: r.payment_status,
          balance_due_cents: r.balance_due_cents,
        });
      }
    } else if (!grp.roomOnlyBookings.has(r.booking_code)) {
      grp.roomOnlyBookings.set(r.booking_code, {
        guest_name: r.guest_name || r.booking_code,
        booking_code: r.booking_code,
        room_bed: roomBedLabel(r) || room,
        check_in: r.check_in,
        check_out: r.check_out,
        guest_count: r.guest_count,
        payment_status: r.payment_status,
        balance_due_cents: r.balance_due_cents,
      });
    }
  }

  let guestTotal = 0;
  for (const g of bookingGuestCounts.values()) guestTotal += g;

  const rooms = [...roomMap.values()]
    .filter((r) => r.bedLines.length > 0 || r.roomOnlyBookings.size > 0)
    .sort((a, b) => String(a.room_code).localeCompare(String(b.room_code)));

  return {
    bookingCount: bookingGuestCounts.size,
    guestTotal,
    bedCount,
    rooms,
  };
}

function formatOccupancyLine(row) {
  const name = row.guest_name || row.booking_code || 'Guest';
  const code = row.booking_code || '?';
  const rb = row.room_bed ? ` — ${row.room_bed}` : '';
  const stay = formatStayRange(row.check_in, row.check_out);
  const stayPart = stay ? ` — ${stay}` : '';
  const guests = guestCountLabel(row.guest_count);
  const pay = bookingPaymentLabel(row);
  const payPart = pay ? ` — ${pay}` : '';
  return `* ${name}${rb} — ${code}${stayPart} — ${guests}${payPart}.`;
}

/**
 * @param {object[]} rows
 * @param {{ nightLabel?: string }} [ctx]
 */
function formatAskLunaOccupancyAnswer(rows, ctx = {}) {
  const nightLabel = ctx.nightLabel || 'tonight';
  const nightCap = nightLabel === 'tomorrow night' ? 'Tomorrow night' : 'Tonight';
  const { bookingCount, guestTotal, bedCount, rooms } = buildOccupancyGroups(rows);

  if (bookingCount === 0) {
    return nightLabel === 'tomorrow night'
      ? 'No active guests are staying tomorrow night.'
      : 'No active guests are staying tonight.';
  }

  const lines = [
    `${nightCap} there are ${guestTotal} guest${guestTotal !== 1 ? 's' : ''} staying across ${bookingCount} booking${bookingCount !== 1 ? 's' : ''}.`,
    '',
  ];

  for (const room of rooms) {
    lines.push(`${room.room_code}:`);
    lines.push('');
    for (const b of room.bedLines) {
      lines.push(formatOccupancyLine(b));
    }
    for (const ro of room.roomOnlyBookings.values()) {
      lines.push(formatOccupancyLine(ro));
    }
    lines.push('');
  }

  const bedPart = bedCount > 0
    ? `, ${bedCount} occupied bed${bedCount !== 1 ? 's' : ''}`
    : '';
  lines.push(
    `Total: ${guestTotal} guest${guestTotal !== 1 ? 's' : ''}, ${bookingCount} booking${bookingCount !== 1 ? 's' : ''}${bedPart}.`,
  );

  return lines.join('\n').replace(/\n\n\n+/g, '\n\n').trim();
}

/** Verifier smoke: inline resolver for API routing tests. */
function getAskLunaOccupancyRoutingSmokeBlock() {
  const consts = `
const OCCUPANCY_TONIGHT_KEY = ${JSON.stringify(OCCUPANCY_TONIGHT_KEY)};
const OCCUPANCY_TOMORROW_NIGHT_KEY = ${JSON.stringify(OCCUPANCY_TOMORROW_NIGHT_KEY)};
const OCCUPANCY_REGISTRY_KEYS = new Set([OCCUPANCY_TONIGHT_KEY, OCCUPANCY_TOMORROW_NIGHT_KEY]);
`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeOccupancyQuestionText,
    askLunaHasTonightWord,
    askLunaHasTomorrowNightWord,
    matchesOccupancyTopic,
    isCheckoutTonightPhrase,
    resolveAskLunaOccupancyIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  OCCUPANCY_TONIGHT_KEY,
  OCCUPANCY_TOMORROW_NIGHT_KEY,
  OCCUPANCY_REGISTRY_KEYS,
  resolveAskLunaOccupancyIntentKey,
  getAskLunaOccupancyOnNightQuery,
  formatAskLunaOccupancyAnswer,
  buildOccupancyGroups,
  getAskLunaOccupancyRoutingSmokeBlock,
};
