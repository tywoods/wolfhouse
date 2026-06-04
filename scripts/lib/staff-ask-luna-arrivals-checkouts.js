/**
 * Phase 11e — Staff Ask Luna arrivals/checkouts today/tomorrow/weekday (read-only).
 *
 * Structured sources: bookings, booking_beds, clients.
 * Weekday window reuses resolveAskLunaWeekdayWithin5Days from Phase 11d.
 *
 * @module staff-ask-luna-arrivals-checkouts
 */

'use strict';

const { resolveAskLunaWeekdayWithin5Days } = require('./staff-ask-luna-meals-yoga');

const ARRIVALS_TODAY_KEY = 'bookings.arrivals_today';
const ARRIVALS_TOMORROW_KEY = 'bookings.arrivals_tomorrow';
const ARRIVALS_ON_DATE_KEY = 'bookings.arrivals_on_date';
const CHECKOUTS_TODAY_KEY = 'bookings.checkouts_today';
const CHECKOUTS_TOMORROW_KEY = 'bookings.checkouts_tomorrow';
const CHECKOUTS_ON_DATE_KEY = 'bookings.checkouts_on_date';

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const AC_REGISTRY_TODAY_TOMORROW = new Set([
  ARRIVALS_TODAY_KEY,
  ARRIVALS_TOMORROW_KEY,
  CHECKOUTS_TODAY_KEY,
  CHECKOUTS_TOMORROW_KEY,
]);

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

function normalizeArrivalsCheckoutsQuestionText(question) {
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

function matchesArrivalsTopic(q) {
  return /\b(arrivals?|arriving|arrives)\b/.test(q)
    || /\b(check|checks)\s+in\b/.test(q)
    || /\bchecking\s+in\b/.test(q);
}

function matchesCheckoutsTopic(q) {
  return /\b(checkouts?|checkout)\b/.test(q)
    || /\b(check|checks)\s+out\b/.test(q)
    || /\bchecking\s+out\b/.test(q)
    || /\b(leav(e|es|ing)|depart(ure|ures|ing)?|departs)\b/.test(q)
    || /\b(sale|salen|salida)\b/.test(q)
    || /\b(parte|partono|part|parts|uscita)\b/.test(q)
    || /\b(abreise|abreisen)\b/.test(q);
}

function detectArrivalsCheckoutsFlow(q) {
  const arrivals = matchesArrivalsTopic(q);
  const checkouts = matchesCheckoutsTopic(q);
  if (checkouts && !arrivals) return 'checkouts';
  if (arrivals && !checkouts) return 'arrivals';
  if (checkouts && arrivals) {
    if (/\b(check.?out|checkout|checkouts|leav|depart)\b/.test(q)) return 'checkouts';
    return 'arrivals';
  }
  return null;
}

function intentKeyForFlow(flow, when) {
  if (flow === 'arrivals') {
    if (when === 'today') return ARRIVALS_TODAY_KEY;
    if (when === 'tomorrow') return ARRIVALS_TOMORROW_KEY;
    return ARRIVALS_ON_DATE_KEY;
  }
  if (when === 'today') return CHECKOUTS_TODAY_KEY;
  if (when === 'tomorrow') return CHECKOUTS_TOMORROW_KEY;
  return CHECKOUTS_ON_DATE_KEY;
}

/**
 * @returns {{ intentKey: string, extraParams: object } | { intentKey: 'unsupported_intent', intentHint: string } | null}
 */
function resolveAskLunaArrivalsCheckoutsIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw) && AC_REGISTRY_TODAY_TOMORROW.has(raw)) {
    const flow = raw.includes('checkout') ? 'checkouts' : 'arrivals';
    const dateLabel = raw.includes('tomorrow') ? 'tomorrow' : 'today';
    const date = dateLabel === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
    return { intentKey: raw, extraParams: { date, dateLabel, flow } };
  }

  const q = normalizeArrivalsCheckoutsQuestionText(question);
  const flow = detectArrivalsCheckoutsFlow(q);
  if (!flow) return null;

  if (askLunaHasTodayWord(q) && !askLunaHasTomorrowWord(q)) {
    return {
      intentKey: intentKeyForFlow(flow, 'today'),
      extraParams: { date: askLunaTodayUTC(refDate), dateLabel: 'today', flow },
    };
  }

  if (askLunaHasTomorrowWord(q)) {
    return {
      intentKey: intentKeyForFlow(flow, 'tomorrow'),
      extraParams: { date: askLunaTomorrowUTC(refDate), dateLabel: 'tomorrow', flow },
    };
  }

  const weekday = resolveAskLunaWeekdayWithin5Days(q, refDate);
  if (weekday && weekday.rejected) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Arrivals and checkouts support today, tomorrow, or a weekday within the next 5 days only.',
    };
  }
  if (weekday) {
    return {
      intentKey: intentKeyForFlow(flow, 'weekday'),
      extraParams: { date: weekday.date, dateLabel: weekday.label, flow },
    };
  }

  return null;
}

function buildBookingsOnDateQuery(dateColumn) {
  const col = dateColumn === 'check_out' ? 'check_out' : 'check_in';
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
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.${col} = $2::date
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY b.guest_name ASC NULLS LAST, b.booking_code ASC
`;
}

function getAskLunaArrivalsOnDateQuery() {
  return buildBookingsOnDateQuery('check_in');
}

function getAskLunaCheckoutsOnDateQuery() {
  return buildBookingsOnDateQuery('check_out');
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

function formatStayRange(checkIn, checkOut) {
  const a = formatShortDate(checkIn);
  const b = formatShortDate(checkOut);
  if (a && b) return `${a}–${b}`;
  return a || b || '';
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

function guestCountLabel(count) {
  const n = Number(count) > 0 ? Number(count) : 1;
  return `${n} guest${n !== 1 ? 's' : ''}`;
}

/**
 * @param {object[]} rows
 * @param {{ dateLabel?: string, flow?: string }} [ctx]
 */
function formatAskLunaArrivalsCheckoutsAnswer(rows, ctx = {}) {
  const flow = ctx.flow === 'checkouts' ? 'checkouts' : 'arrivals';
  const dateLabel = ctx.dateLabel || 'today';
  const dayCap = capitalizeDateLabel(dateLabel);
  const list = rows || [];
  const unit = flow === 'checkouts' ? 'checkout' : 'arrival';
  const units = flow === 'checkouts' ? 'checkouts' : 'arrivals';

  if (list.length === 0) {
    const when = dateLabel === 'today' || dateLabel === 'tomorrow'
      ? dateLabel
      : dayCap;
    return `No ${units} are currently scheduled for ${when}.`;
  }

  const total = list.length;
  const lines = [
    `${dayCap} there are ${total} ${units}.`,
    '',
  ];

  for (const r of list) {
    const name = r.guest_name || r.booking_code || 'Guest';
    const code = r.booking_code || '?';
    const stay = formatStayRange(r.check_in, r.check_out);
    const bed = r.bed_summary ? ` — ${r.bed_summary}` : '';
    const guests = guestCountLabel(r.guest_count);
    const pay = bookingPaymentLabel(r);
    const payPart = pay ? ` — ${pay}` : '';
    const stayPart = stay ? ` — ${stay}` : '';
    lines.push(`${name} — ${code}${stayPart}${bed} — ${guests}${payPart}.`);
  }

  lines.push('');
  lines.push(`Total: ${total} ${units}.`);
  return lines.join('\n');
}

/** Verifier smoke: inline helpers + resolver (no module scope). */
function getAskLunaArrivalsCheckoutsRoutingSmokeBlock() {
  const consts = `
const ARRIVALS_TODAY_KEY = ${JSON.stringify(ARRIVALS_TODAY_KEY)};
const ARRIVALS_TOMORROW_KEY = ${JSON.stringify(ARRIVALS_TOMORROW_KEY)};
const ARRIVALS_ON_DATE_KEY = ${JSON.stringify(ARRIVALS_ON_DATE_KEY)};
const CHECKOUTS_TODAY_KEY = ${JSON.stringify(CHECKOUTS_TODAY_KEY)};
const CHECKOUTS_TOMORROW_KEY = ${JSON.stringify(CHECKOUTS_TOMORROW_KEY)};
const CHECKOUTS_ON_DATE_KEY = ${JSON.stringify(CHECKOUTS_ON_DATE_KEY)};
const WEEKDAYS = ${JSON.stringify(WEEKDAYS)};
const AC_REGISTRY_TODAY_TOMORROW = new Set([ARRIVALS_TODAY_KEY, ARRIVALS_TOMORROW_KEY, CHECKOUTS_TODAY_KEY, CHECKOUTS_TOMORROW_KEY]);
`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeArrivalsCheckoutsQuestionText,
    askLunaHasTodayWord,
    askLunaHasTomorrowWord,
    matchesArrivalsTopic,
    matchesCheckoutsTopic,
    detectArrivalsCheckoutsFlow,
    intentKeyForFlow,
    resolveAskLunaArrivalsCheckoutsIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  ARRIVALS_TODAY_KEY,
  ARRIVALS_TOMORROW_KEY,
  ARRIVALS_ON_DATE_KEY,
  CHECKOUTS_TODAY_KEY,
  CHECKOUTS_TOMORROW_KEY,
  CHECKOUTS_ON_DATE_KEY,
  resolveAskLunaArrivalsCheckoutsIntentKey,
  getAskLunaArrivalsOnDateQuery,
  getAskLunaCheckoutsOnDateQuery,
  formatAskLunaArrivalsCheckoutsAnswer,
  getAskLunaArrivalsCheckoutsRoutingSmokeBlock,
};
