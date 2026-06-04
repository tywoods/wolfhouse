/**
 * Phase 11d — Staff Ask Luna meals & yoga today/tomorrow/weekday (read-only).
 *
 * Weekdays resolve to the next occurrence within 5 days only (0–5 days ahead).
 *
 * @module staff-ask-luna-meals-yoga
 */

'use strict';

const MEALS_TODAY_KEY = 'services.meals_today';
const MEALS_TOMORROW_KEY = 'services.meals_tomorrow';
const YOGA_TODAY_KEY = 'services.yoga_today';
const YOGA_TOMORROW_KEY = 'services.yoga_tomorrow';
const MEALS_ON_DATE_KEY = 'services.meals_on_date';
const YOGA_ON_DATE_KEY = 'services.yoga_on_date';

const MEALS_YOGA_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MEALS_YOGA_WEEKDAY_MAX = 5;

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

function normalizeMealsYogaQuestionText(question) {
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

function matchesMealsTopic(q) {
  return /\b(meals?|dinners?|food)\b/.test(q);
}

function matchesYogaTopic(q) {
  return /\byoga(\s*class(es)?)?\b/.test(q);
}

function detectMealsYogaCategory(q) {
  const meals = matchesMealsTopic(q);
  const yoga = matchesYogaTopic(q);
  if (meals && !yoga) return 'meals';
  if (yoga && !meals) return 'yoga';
  if (meals && yoga) return null;
  return null;
}

/**
 * Next occurrence of a named weekday; only if within 5 days (inclusive).
 * @returns {{ date: string, label: string, daysUntil: number } | { rejected: true, weekday: string, daysUntil: number }}
 */
function resolveAskLunaWeekdayWithin5Days(q, refDate = new Date()) {
  for (let i = 0; i < MEALS_YOGA_WEEKDAYS.length; i++) {
    const name = MEALS_YOGA_WEEKDAYS[i];
    if (new RegExp(`\\b${name}\\b`).test(q)) {
      const refDay = refDate.getUTCDay();
      const daysUntil = (i - refDay + 7) % 7;
      if (daysUntil > MEALS_YOGA_WEEKDAY_MAX) {
        return { rejected: true, weekday: name, daysUntil };
      }
      const d = new Date(refDate);
      d.setUTCDate(d.getUTCDate() + daysUntil);
      return { date: askLunaIsoDateUTC(d), label: name, daysUntil };
    }
  }
  return null;
}

function intentKeyForCategory(category, when) {
  if (category === 'meals') {
    if (when === 'today') return MEALS_TODAY_KEY;
    if (when === 'tomorrow') return MEALS_TOMORROW_KEY;
    return MEALS_ON_DATE_KEY;
  }
  if (when === 'today') return YOGA_TODAY_KEY;
  if (when === 'tomorrow') return YOGA_TOMORROW_KEY;
  return YOGA_ON_DATE_KEY;
}

const REGISTRY_TODAY_TOMORROW = new Set([
  MEALS_TODAY_KEY, MEALS_TOMORROW_KEY, YOGA_TODAY_KEY, YOGA_TOMORROW_KEY,
]);

/**
 * @returns {{ intentKey: string, extraParams: { date: string, dateLabel: string, serviceCategory: string } } | { intentKey: 'unsupported_intent', intentHint: string } | null}
 */
function resolveAskLunaMealsYogaIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw) && REGISTRY_TODAY_TOMORROW.has(raw)) {
    const category = raw.includes('yoga') ? 'yoga' : 'meals';
    const dateLabel = raw.includes('tomorrow') ? 'tomorrow' : 'today';
    const date = dateLabel === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
    return { intentKey: raw, extraParams: { date, dateLabel, serviceCategory: category } };
  }

  const q = normalizeMealsYogaQuestionText(question);
  const category = detectMealsYogaCategory(q);
  if (!category) return null;

  if (askLunaHasTodayWord(q) && !askLunaHasTomorrowWord(q)) {
    return {
      intentKey: intentKeyForCategory(category, 'today'),
      extraParams: {
        date: askLunaTodayUTC(refDate),
        dateLabel: 'today',
        serviceCategory: category,
      },
    };
  }

  if (askLunaHasTomorrowWord(q)) {
    return {
      intentKey: intentKeyForCategory(category, 'tomorrow'),
      extraParams: {
        date: askLunaTomorrowUTC(refDate),
        dateLabel: 'tomorrow',
        serviceCategory: category,
      },
    };
  }

  const weekday = resolveAskLunaWeekdayWithin5Days(q, refDate);
  if (weekday && weekday.rejected) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Meals and yoga queries support today, tomorrow, or a weekday within the next 5 days only.',
    };
  }
  if (weekday) {
    return {
      intentKey: intentKeyForCategory(category, 'weekday'),
      extraParams: {
        date: weekday.date,
        dateLabel: weekday.label,
        serviceCategory: category,
      },
    };
  }

  return null;
}

function buildMealsYogaOnDateQuery(serviceType) {
  return `
SELECT
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                       AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                           AS service_status,
  sr.payment_status::text                   AS payment_status,
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
FROM booking_service_records sr
INNER JOIN bookings b ON b.id = sr.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND sr.service_date = $2::date
  AND sr.service_type = '${serviceType}'
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

function getAskLunaMealsOnDateQuery() {
  return buildMealsYogaOnDateQuery('meal');
}

function getAskLunaYogaOnDateQuery() {
  return buildMealsYogaOnDateQuery('yoga');
}

function rowQuantity(row) {
  return Number(row.quantity) > 0 ? Number(row.quantity) : 1;
}

function capitalizeDateLabel(dateLabel) {
  if (!dateLabel) return 'Today';
  if (dateLabel === 'today') return 'Today';
  if (dateLabel === 'tomorrow') return 'Tomorrow';
  if (MEALS_YOGA_WEEKDAYS.includes(dateLabel)) {
    return dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
  }
  return dateLabel;
}

function serviceUnitLabel(category, count) {
  if (category === 'yoga') {
    return count === 1 ? 'yoga class' : 'yoga classes';
  }
  return count === 1 ? 'meal' : 'meals';
}

function paymentStatusSuffix(paymentStatus) {
  const ps = String(paymentStatus || '').toLowerCase();
  if (ps === 'paid') return ' — paid';
  if (ps === 'pending' || ps === 'not_requested') return ' — unpaid/pending';
  if (ps) return ` — ${ps}`;
  return '';
}

function aggregateMealsYogaByBooking(rows, category) {
  const map = new Map();
  for (const r of rows || []) {
    const code = r.booking_code || 'unknown';
    const qty = rowQuantity(r);
    if (!map.has(code)) {
      map.set(code, {
        guest_name:     r.guest_name || null,
        booking_code:   code,
        bed_summary:    r.bed_summary || null,
        service_date:   r.service_date,
        service_status: r.service_status || null,
        payment_status: r.payment_status || null,
        unit_count:     0,
      });
    }
    const entry = map.get(code);
    entry.unit_count += qty;
    if (!entry.guest_name && r.guest_name) entry.guest_name = r.guest_name;
    if (!entry.bed_summary && r.bed_summary) entry.bed_summary = r.bed_summary;
    if (!entry.payment_status && r.payment_status) entry.payment_status = r.payment_status;
    if (!entry.service_status && r.service_status) entry.service_status = r.service_status;
  }
  return [...map.values()].sort((a, b) => b.unit_count - a.unit_count);
}

/**
 * @param {object[]} rows
 * @param {{ dateLabel?: string, serviceCategory?: string }} [ctx]
 */
function formatAskLunaMealsYogaAnswer(rows, ctx = {}) {
  const category = ctx.serviceCategory === 'yoga' ? 'yoga' : 'meals';
  const dateLabel = ctx.dateLabel || 'today';
  const dayCap = capitalizeDateLabel(dateLabel);
  const list = rows || [];

  const emptyMeals = dateLabel === 'today' || dateLabel === 'tomorrow'
    ? `No meals are currently booked for ${dateLabel}.`
    : `No meals are currently booked for ${dayCap}.`;
  const emptyYoga = dateLabel === 'today' || dateLabel === 'tomorrow'
    ? `No yoga classes are currently booked for ${dateLabel}.`
    : `No yoga classes are currently booked for ${dayCap}.`;

  if (list.length === 0) {
    return category === 'yoga' ? emptyYoga : emptyMeals;
  }

  const totalUnits = list.reduce((s, r) => s + rowQuantity(r), 0);
  const bookings = aggregateMealsYogaByBooking(list, category);
  const unitWord = serviceUnitLabel(category, totalUnits);

  const header = category === 'yoga'
    ? `${dayCap} has ${totalUnits} ${totalUnits === 1 ? 'person' : 'people'} booked for yoga.`
    : `${dayCap} has ${totalUnits} ${unitWord} booked.`;

  const lines = [header, ''];

  for (const b of bookings) {
    const name = b.guest_name || b.booking_code || 'Guest';
    const bed = b.bed_summary ? ` — ${b.bed_summary}` : '';
    const unit = serviceUnitLabel(category, b.unit_count);
    const pay = paymentStatusSuffix(b.payment_status);
    lines.push(
      `${name} — ${b.unit_count} ${unit}${bed} — booking ${b.booking_code}${pay}.`,
    );
  }

  lines.push('');
  const totalLabel = category === 'yoga'
    ? `${totalUnits} yoga class${totalUnits !== 1 ? 'es' : ''}`
    : `${totalUnits} meal${totalUnits !== 1 ? 's' : ''}`;
  lines.push(
    `Total: ${totalLabel} across ${bookings.length} booking${bookings.length !== 1 ? 's' : ''}.`,
  );
  return lines.join('\n');
}

/** Verifier smoke: inline helpers + resolver (no module scope). */
function getAskLunaMealsYogaRoutingSmokeBlock() {
  const consts = `
const MEALS_TODAY_KEY = ${JSON.stringify(MEALS_TODAY_KEY)};
const MEALS_TOMORROW_KEY = ${JSON.stringify(MEALS_TOMORROW_KEY)};
const YOGA_TODAY_KEY = ${JSON.stringify(YOGA_TODAY_KEY)};
const YOGA_TOMORROW_KEY = ${JSON.stringify(YOGA_TOMORROW_KEY)};
const MEALS_ON_DATE_KEY = ${JSON.stringify(MEALS_ON_DATE_KEY)};
const YOGA_ON_DATE_KEY = ${JSON.stringify(YOGA_ON_DATE_KEY)};
const MEALS_YOGA_WEEKDAYS = ${JSON.stringify(MEALS_YOGA_WEEKDAYS)};
const MEALS_YOGA_WEEKDAY_MAX = ${MEALS_YOGA_WEEKDAY_MAX};
const REGISTRY_TODAY_TOMORROW = new Set([MEALS_TODAY_KEY, MEALS_TOMORROW_KEY, YOGA_TODAY_KEY, YOGA_TOMORROW_KEY]);
`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeMealsYogaQuestionText,
    askLunaHasTodayWord,
    askLunaHasTomorrowWord,
    matchesMealsTopic,
    matchesYogaTopic,
    detectMealsYogaCategory,
    resolveAskLunaWeekdayWithin5Days,
    intentKeyForCategory,
    resolveAskLunaMealsYogaIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  MEALS_TODAY_KEY,
  MEALS_TOMORROW_KEY,
  YOGA_TODAY_KEY,
  YOGA_TOMORROW_KEY,
  MEALS_ON_DATE_KEY,
  YOGA_ON_DATE_KEY,
  MEALS_YOGA_WEEKDAY_MAX,
  resolveAskLunaMealsYogaIntentKey,
  resolveAskLunaWeekdayWithin5Days,
  matchesMealsTopic,
  matchesYogaTopic,
  getAskLunaMealsOnDateQuery,
  getAskLunaYogaOnDateQuery,
  formatAskLunaMealsYogaAnswer,
  getAskLunaMealsYogaRoutingSmokeBlock,
};
