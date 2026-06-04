/**
 * Phase 11f — Staff Ask Luna checkout cleaning / turnover (read-only).
 *
 * Candidates = active bookings with check_out on the requested date.
 * Sources: bookings, booking_beds, clients.
 * Weekday window reuses resolveAskLunaWeekdayWithin5Days from Phase 11d.
 *
 * @module staff-ask-luna-cleaning
 */

'use strict';

const { resolveAskLunaWeekdayWithin5Days } = require('./staff-ask-luna-meals-yoga');

const CLEANING_TODAY_KEY = 'housekeeping.cleaning_today';
const CLEANING_TOMORROW_KEY = 'housekeeping.cleaning_tomorrow';
const CLEANING_ON_DATE_KEY = 'housekeeping.cleaning_on_date';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const HK_REGISTRY_TODAY_TOMORROW = new Set([CLEANING_TODAY_KEY, CLEANING_TOMORROW_KEY]);

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

function normalizeCleaningQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function askLunaHasTodayWord(q) {
  return /\b(today|tonight|hoy|oggi|heute|aujourdhui|aujourd hui)\b/.test(q);
}

function askLunaHasTomorrowWord(q) {
  return /\b(tomorrow|manana|domani|morgen|demain)\b/.test(q);
}

function matchesCleaningTopic(q) {
  if (/\b(clean(ed|ing)?|housekeep(ing)?|turnover|limpiar|limpieza|pulire|pulizia|reinigen|gereinigt|sauber|nettoyer|menage)\b/.test(q)) {
    return true;
  }
  if (/\b(needs?\s+cleaning|need\s+cleaning|needs?\s+to\s+be\s+cleaned)\b/.test(q)) {
    return true;
  }
  return /\b(room|rooms|bed|beds|cuarto|cuartos|habitacion|habitaciones|camera|camere|zimmer|chambre|chambres)\b/.test(q)
    && /\b(clean|turnover|limpiar|pulire|reinigen|nettoyer|menage)\b/.test(q);
}

/**
 * @returns {{ intentKey: string, extraParams: { date: string, dateLabel: string } } | { intentKey: 'unsupported_intent', intentHint: string } | null}
 */
function resolveAskLunaCleaningIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw) && HK_REGISTRY_TODAY_TOMORROW.has(raw)) {
    const dateLabel = raw.includes('tomorrow') ? 'tomorrow' : 'today';
    const date = dateLabel === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
    return { intentKey: raw, extraParams: { date, dateLabel } };
  }

  const q = normalizeCleaningQuestionText(question);
  if (!matchesCleaningTopic(q)) return null;

  if (askLunaHasTodayWord(q) && !askLunaHasTomorrowWord(q)) {
    return {
      intentKey: CLEANING_TODAY_KEY,
      extraParams: { date: askLunaTodayUTC(refDate), dateLabel: 'today' },
    };
  }

  if (askLunaHasTomorrowWord(q)) {
    return {
      intentKey: CLEANING_TOMORROW_KEY,
      extraParams: { date: askLunaTomorrowUTC(refDate), dateLabel: 'tomorrow' },
    };
  }

  const weekday = resolveAskLunaWeekdayWithin5Days(q, refDate);
  if (weekday && weekday.rejected) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Cleaning queries support today, tomorrow, or a weekday within the next 5 days only.',
    };
  }
  if (weekday) {
    return {
      intentKey: CLEANING_ON_DATE_KEY,
      extraParams: { date: weekday.date, dateLabel: weekday.label },
    };
  }

  return {
    intentKey: CLEANING_TODAY_KEY,
    extraParams: { date: askLunaTodayUTC(refDate), dateLabel: 'today' },
  };
}

/**
 * Checkout-date cleaning candidates — one row per bed when assigned, else one room-level row.
 * $1 = client slug, $2 = check_out date (YYYY-MM-DD)
 */
function getAskLunaCleaningOnDateQuery() {
  return `
SELECT
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_out::text AS check_out,
  COALESCE(bb.room_code, NULLIF(b.primary_room_code, '')) AS room_code,
  bb.bed_code,
  bb.planning_row_label
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN booking_beds bb ON bb.booking_id = b.id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY room_code ASC NULLS LAST, bed_code ASC NULLS LAST, b.booking_code ASC
`;
}

function capitalizeDateLabel(dateLabel) {
  if (!dateLabel) return 'Today';
  if (dateLabel === 'today') return 'Today';
  if (dateLabel === 'tomorrow') return 'Tomorrow';
  if (WEEKDAYS.includes(dateLabel)) {
    return dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
  }
  return dateLabel;
}

function formatShortDate(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}`;
}

function bedLabel(row) {
  if (row.bed_code) return `Bed ${row.bed_code}`;
  if (row.planning_row_label) return row.planning_row_label;
  return 'Bed';
}

function guestCountLabel(count) {
  const n = Number(count) > 0 ? Number(count) : 1;
  return `${n} guest${n !== 1 ? 's' : ''}`;
}

/**
 * Build room-grouped structure from query rows.
 */
function buildCleaningGroups(rows) {
  const bookingCodes = new Set();
  let bedCount = 0;
  const roomMap = new Map();

  for (const r of rows || []) {
    if (!r.booking_code) continue;
    bookingCodes.add(r.booking_code);
    const room = r.room_code || 'Unassigned';
    const hasBed = Boolean(r.bed_code);

    if (!roomMap.has(room)) {
      roomMap.set(room, { room_code: room, bedLines: [], roomOnlyBookings: new Map() });
    }
    const grp = roomMap.get(room);

    if (hasBed) {
      bedCount += 1;
      grp.bedLines.push({
        bed_label: bedLabel(r),
        guest_name: r.guest_name || r.booking_code,
        booking_code: r.booking_code,
        check_out: r.check_out,
        guest_count: r.guest_count,
      });
    } else if (!grp.roomOnlyBookings.has(r.booking_code)) {
      grp.roomOnlyBookings.set(r.booking_code, {
        guest_name: r.guest_name || r.booking_code,
        booking_code: r.booking_code,
        check_out: r.check_out,
        guest_count: r.guest_count,
      });
    }
  }

  const rooms = [...roomMap.values()].sort((a, b) => {
    const ac = String(a.room_code);
    const bc = String(b.room_code);
    return ac.localeCompare(bc);
  });

  return {
    bookingCount: bookingCodes.size,
    bedCount,
    rooms,
  };
}

/**
 * @param {object[]} rows
 * @param {{ dateLabel?: string }} [ctx]
 */
function formatAskLunaCleaningAnswer(rows, ctx = {}) {
  const dateLabel = ctx.dateLabel || 'today';
  const dayCap = capitalizeDateLabel(dateLabel);
  const whenPhrase = dateLabel === 'today' || dateLabel === 'tomorrow'
    ? dateLabel
    : (WEEKDAYS.includes(dateLabel) ? `on ${dayCap}` : dayCap);

  const { bookingCount, bedCount, rooms } = buildCleaningGroups(rows);

  if (bookingCount === 0) {
    return `No rooms or beds are currently flagged for checkout cleaning ${whenPhrase}.`;
  }

  const lines = [];
  const hasBedDetail = bedCount > 0;

  if (hasBedDetail) {
    lines.push(
      `${dayCap} there are ${bedCount} bed${bedCount !== 1 ? 's' : ''} likely needing turnover from ${bookingCount} checkout${bookingCount !== 1 ? 's' : ''}.`,
      '',
    );
    for (const room of rooms) {
      const roomOnly = [...room.roomOnlyBookings.values()];
      if (room.bedLines.length === 0 && roomOnly.length === 0) continue;
      lines.push(`${room.room_code}:`);
      lines.push('');
      for (const b of room.bedLines) {
        const co = formatShortDate(b.check_out);
        const coPart = co ? ` — checkout ${co}` : '';
        lines.push(`* ${b.bed_label} — ${b.guest_name} — booking ${b.booking_code}${coPart}.`);
      }
      for (const ro of roomOnly) {
        lines.push(
          `* ${ro.guest_name} — booking ${ro.booking_code} — ${guestCountLabel(ro.guest_count)} (room-level).`,
        );
      }
      lines.push('');
    }
    const roomCount = rooms.filter((r) => r.bedLines.length > 0 || r.roomOnlyBookings.size > 0).length;
    lines.push(`Total: ${bedCount} bed${bedCount !== 1 ? 's' : ''} across ${roomCount} room${roomCount !== 1 ? 's' : ''}.`);
  } else {
    lines.push(
      `${dayCap} there are ${bookingCount} room-level checkout${bookingCount !== 1 ? 's' : ''} that likely need cleaning.`,
      '',
    );
    for (const room of rooms) {
      for (const ro of room.roomOnlyBookings.values()) {
        lines.push(
          `${room.room_code} — ${ro.guest_name} — booking ${ro.booking_code} — ${guestCountLabel(ro.guest_count)}.`,
        );
      }
    }
    lines.push('');
    lines.push(`Total: ${bookingCount} room${bookingCount !== 1 ? 's' : ''}/booking${bookingCount !== 1 ? 's' : ''}.`);
  }

  return lines.join('\n').replace(/\n\n\n+/g, '\n\n').trim();
}

/** Verifier smoke: inline helpers + resolver (depends on meals-yoga weekday fn in scope). */
function getAskLunaCleaningRoutingSmokeBlock() {
  const consts = `
const CLEANING_TODAY_KEY = ${JSON.stringify(CLEANING_TODAY_KEY)};
const CLEANING_TOMORROW_KEY = ${JSON.stringify(CLEANING_TOMORROW_KEY)};
const CLEANING_ON_DATE_KEY = ${JSON.stringify(CLEANING_ON_DATE_KEY)};
const HK_REGISTRY_TODAY_TOMORROW = new Set([CLEANING_TODAY_KEY, CLEANING_TOMORROW_KEY]);
`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeCleaningQuestionText,
    askLunaHasTodayWord,
    askLunaHasTomorrowWord,
    matchesCleaningTopic,
    resolveAskLunaCleaningIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  CLEANING_TODAY_KEY,
  CLEANING_TOMORROW_KEY,
  CLEANING_ON_DATE_KEY,
  resolveAskLunaCleaningIntentKey,
  getAskLunaCleaningOnDateQuery,
  formatAskLunaCleaningAnswer,
  buildCleaningGroups,
  getAskLunaCleaningRoutingSmokeBlock,
};
