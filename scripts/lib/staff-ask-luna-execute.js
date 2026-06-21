'use strict';

/**
 * Shared Staff Ask Luna / Command Center query execution (read-only).
 * Used by Staff Portal API and owner WhatsApp inbound routing (Phase 25c).
 */

const { withPgClient } = require('./pg-connect');
const { getEntry, resolveParams } = require('./staff-query-registry');
const {
  computeBalanceDueRows,
  formatAskLunaBalanceDueAnswer,
  matchesBalanceDueQuestion,
  resolveBalanceDueIntentKey,
} = require('./staff-ask-luna-balance-due');
const { classifyAskLunaIntentWithAi } = require('./staff-ask-luna-ai-intent');
const { formatBalanceDueAnswerNatural } = require('./staff-ask-luna-ai-answer-format');
const {
  resolveAskLunaLessonsIntentKey,
  getAskLunaLessonsOnDateQuery,
  formatAskLunaLessonsAnswer,
} = require('./staff-ask-luna-lessons');
const {
  resolveAskLunaGearIntentKey,
  getAskLunaGearOnDateQuery,
  formatAskLunaGearAnswer,
} = require('./staff-ask-luna-gear');
const {
  resolveAskLunaMealsYogaIntentKey,
  getAskLunaMealsOnDateQuery,
  getAskLunaYogaOnDateQuery,
  formatAskLunaMealsYogaAnswer,
} = require('./staff-ask-luna-meals-yoga');
const {
  resolveAskLunaPendingManualServicesIntentKey,
  getPendingManualServicesQuery,
  getPendingManualYogaQuery,
  getPendingManualMealsQuery,
  formatAskLunaPendingManualServicesAnswer,
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
} = require('./staff-ask-luna-pending-manual-services');
const {
  resolveAskLunaArrivalsCheckoutsIntentKey,
  getAskLunaArrivalsOnDateQuery,
  getAskLunaCheckoutsOnDateQuery,
  formatAskLunaArrivalsCheckoutsAnswer,
} = require('./staff-ask-luna-arrivals-checkouts');
const {
  resolveAskLunaCleaningIntentKey,
  getAskLunaCleaningOnDateQuery,
  formatAskLunaCleaningAnswer,
} = require('./staff-ask-luna-cleaning');
const {
  resolveAskLunaBookingLookupIntentKey,
  buildAskLunaBookingLookupQuery,
  getAskLunaBookingLookupByCodeQuery,
  formatAskLunaBookingLookupAnswer,
} = require('./staff-ask-luna-booking-lookup');
const {
  OPS_MULTI_TOOL_INTENT,
  resolveOpsPlannerIntent,
  executeOpsPlannerTools,
  formatCombinedOpsPlannerAnswer,
} = require('./staff-ask-luna-multi-tool-planner');
const {
  resolveAskLunaHandoffsIntentKey,
  fetchAskLunaHandoffRows,
  formatAskLunaHandoffsAnswer,
} = require('./staff-ask-luna-handoffs');
const {
  resolveAskLunaOccupancyIntentKey,
  getAskLunaOccupancyOnNightQuery,
  formatAskLunaOccupancyAnswer,
} = require('./staff-ask-luna-occupancy');
const {
  resolveAskLunaFreeBedsIntentKey,
  getAskLunaFreeBedsOnNightQuery,
  formatAskLunaFreeBedsAnswer,
} = require('./staff-ask-luna-free-beds');
const {
  fetchSurfForecastForAskLuna,
  resolveAskLunaSurfForecastIntentKey,
  SURF_FORECAST_TODAY_KEY,
  SURF_FORECAST_TOMORROW_KEY,
  ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER,
} = require('./staff-stormglass-forecast');
const {
  isSunsetClientSlug,
  buildSunsetAskLunaQueryParams,
  applySunsetAskLunaLocationFilter,
  DEFAULT_SUNSET_LOCATION_ID,
} = require('./sunset-luna-school-context');
const { normalizeSunsetLocationId } = require('./sunset-school-locations');

const DEFAULT_CLIENT = 'wolfhouse-somo';
const MAX_ROWS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Ask Luna local intents (Stage 8.6.9) — read-only SQL, not in registry yet.
// Uses structured bookings + booking_beds only (no chat/conversation logs).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Ask Luna local intents (Stage 8.6.9) — read-only SQL, not in registry yet.
// Uses structured bookings + booking_beds only (no chat/conversation logs).
// ─────────────────────────────────────────────────────────────────────────────

function getAskLunaDeparturesTodayQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  bb.room_code,
  bb.bed_code,
  bb.planning_row_label
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
LEFT JOIN booking_beds bb ON bb.booking_id = b.id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY bb.room_code ASC NULLS LAST, bb.bed_code ASC NULLS LAST, b.booking_code ASC
`;
}

function getAskLunaRoomsNeedCleaningQuery() {
  return `
SELECT DISTINCT ON (bb.room_code, bb.bed_code)
  bb.room_code,
  bb.bed_code,
  bb.planning_row_label,
  b.booking_code,
  b.guest_name,
  b.check_out
FROM booking_beds bb
INNER JOIN bookings b ON b.id = bb.booking_id
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
  AND bb.room_code IS NOT NULL
  AND bb.bed_code IS NOT NULL
ORDER BY bb.room_code, bb.bed_code, b.booking_code
`;
}

/** Stage 8.8.2 — bookings.check_in on a resolved date (one row per booking). */
function getAskLunaCheckInsOnDateQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb2.room_code || '/' || bb2.bed_code AS rm_bed
       FROM booking_beds bb2
       WHERE bb2.booking_id = b.id
         AND bb2.room_code IS NOT NULL
         AND bb2.bed_code IS NOT NULL
     ) beds),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_in = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.booking_code ASC
`;
}

/** Stage 8.8.2 — bookings.check_out on a resolved date (one row per booking). */
function getAskLunaCheckOutsOnDateQuery() {
  return `
SELECT
  b.id::text                AS booking_id,
  b.booking_code,
  b.guest_name,
  b.guest_count,
  b.check_in,
  b.check_out,
  b.status::text            AS booking_status,
  COALESCE(
    (SELECT STRING_AGG(rm_bed, ', ' ORDER BY rm_bed)
     FROM (
       SELECT DISTINCT bb2.room_code || '/' || bb2.bed_code AS rm_bed
       FROM booking_beds bb2
       WHERE bb2.booking_id = b.id
         AND bb2.room_code IS NOT NULL
         AND bb2.bed_code IS NOT NULL
     ) beds),
    ''
  ) AS bed_summary
FROM bookings b
INNER JOIN clients c ON c.id = b.client_id
WHERE c.slug = $1
  AND b.check_out = $2::date
  AND b.status NOT IN ('cancelled', 'expired', 'hold')
ORDER BY b.booking_code ASC
`;
}

/** Stage 8.8.11 — booking_service_records SELECT columns for Ask Luna service intents. */
const ASK_LUNA_SERVICE_RECORD_COLUMNS = `
  guest_name,
  booking_code,
  service_type,
  service_date,
  quantity,
  status,
  payment_status,
  amount_due_cents,
  amount_paid_cents`;

function getAskLunaServiceYogaPaidQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'yoga'
  AND service_date = $2::date
  AND payment_status = 'paid'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceMealPaidQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'meal'
  AND service_date = $2::date
  AND payment_status = 'paid'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceSurfLessonQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surf_lesson'
  AND service_date = $2::date
  AND status IN ('requested', 'confirmed', 'paid')
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceWetsuitQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'wetsuit'
  AND service_date = $2::date
  AND status <> 'cancelled'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceSurfboardQuery() {
  return `
SELECT${ASK_LUNA_SERVICE_RECORD_COLUMNS}
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surfboard'
  AND service_date = $2::date
  AND status <> 'cancelled'
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST
`;
}

function getAskLunaServiceWetsuitCountQuery() {
  return `
SELECT
  NULL::text AS guest_name,
  NULL::text AS booking_code,
  'wetsuit'::text AS service_type,
  $2::date AS service_date,
  COALESCE(SUM(quantity), 0)::int AS quantity,
  NULL::text AS status,
  NULL::text AS payment_status,
  0 AS amount_due_cents,
  0 AS amount_paid_cents
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'wetsuit'
  AND service_date = $2::date
  AND status <> 'cancelled'
`;
}

function getAskLunaServiceSurfboardCountQuery() {
  return `
SELECT
  NULL::text AS guest_name,
  NULL::text AS booking_code,
  'surfboard'::text AS service_type,
  $2::date AS service_date,
  COALESCE(SUM(quantity), 0)::int AS quantity,
  NULL::text AS status,
  NULL::text AS payment_status,
  0 AS amount_due_cents,
  0 AS amount_paid_cents
FROM booking_service_records
WHERE client_slug = $1
  AND service_type = 'surfboard'
  AND service_date = $2::date
  AND status <> 'cancelled'
`;
}

const ASK_LUNA_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const ASK_LUNA_MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

function askLunaIsoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

function askLunaTodayUTC(refDate = new Date()) {
  return askLunaIsoDateUTC(refDate);
}

/**
 * Normalize staff Ask Luna question text (Stage 8.8.4).
 * Lowercase, strip accents, collapse punctuation/contractions — deterministic only.
 */
function normalizeAskLunaQuestion(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/\bwho\s+s\b/g, 'who');
  q = q.replace(/\bwhat\s+s\b/g, 'what');
  q = q.replace(/\bit\s+s\b/g, 'it');
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

function askLunaIsCountQuestion(q) {
  return /\b(how many|cuantos|cuantas|quanti|wie viele|combien)\b/.test(q);
}

function askLunaMatchesCheckout(q) {
  return /\b(check(ing)?\s*out|checkout|leav(e|es|ing)|depart(ure|ures|ing)?|departs)\b/.test(q)
    || /\b(sale|salen|salida)\b/.test(q)
    || /\b(parte|partono|part|parts|uscita)\b/.test(q)
    || /\b(abreise|abreisen)\b/.test(q);
}

function askLunaMatchesCleaning(q) {
  if (/\b(clean(ed|ing)?|housekeep(ing)?|limpiar|limpieza|pulire|pulizia|reinigen|gereinigt|sauber|nettoyer|menage)\b/.test(q)) {
    return true;
  }
  return /\b(room|rooms|bed|beds|cuarto|cuartos|habitacion|habitaciones|camera|camere|zimmer|chambre|chambres)\b/.test(q)
    && /\b(clean|limpiar|pulire|reinigen|nettoyer|gereinigt|sauber|menage|needs?\s+to\s+be\s+cleaned)\b/.test(q);
}

function askLunaMatchesBalanceDue(question) {
  return matchesBalanceDueQuestion(question);
}

function askLunaIsDeparturesTodayPhrase(q, dateInfo, today) {
  const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
  if (!di || di.date !== today) return false;
  if (/\b(who leaves|leave.?today|leaving.?today|check.?out.?today|depart.*today)\b/.test(q)) {
    return true;
  }
  if (!askLunaMatchesCheckout(q)) return false;
  if (!askLunaHasTodayWord(q) && !(dateInfo && dateInfo.label === 'today')) return false;
  return /\b(quien|chi|qui|wer|who)\b/.test(q) || /\bwho\b/.test(q);
}

/**
 * Resolve a date phrase from a staff Ask Luna question (Stage 8.8.2 + 8.8.4 i18n).
 * tonight = today; tomorrow; ISO; named month/day; weekday; hoy/oggi/heute/aujourd'hui…
 * @returns {{ date: string, label: string } | null}
 */
function resolveAskLunaDatePhrase(question, refDate = new Date()) {
  const q = normalizeAskLunaQuestion(question);

  const isoMatch = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return { date: isoMatch[1], label: isoMatch[1] };

  let monthIdx = null;
  let dayNum = null;
  let m = q.match(/\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (m) {
    monthIdx = ASK_LUNA_MONTHS[m[1]];
    dayNum = parseInt(m[2], 10);
  } else {
    m = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
    if (m) {
      dayNum = parseInt(m[1], 10);
      monthIdx = ASK_LUNA_MONTHS[m[2]];
    }
  }
  if (monthIdx != null && dayNum >= 1 && dayNum <= 31) {
    const y = refDate.getUTCFullYear();
    const d = new Date(Date.UTC(y, monthIdx, dayNum));
    return { date: askLunaIsoDateUTC(d), label: askLunaIsoDateUTC(d) };
  }

  if (/\btonight\b/.test(q) || /\bhoy\b/.test(q) || /\boggi\b/.test(q) || /\bheute\b/.test(q)
      || /\baujourdhui\b/.test(q) || /\baujourd hui\b/.test(q)) {
    return { date: askLunaTodayUTC(refDate), label: 'today' };
  }
  if (/\btomorrow\b/.test(q) || /\bmanana\b/.test(q) || /\bdomani\b/.test(q)
      || /\bmorgen\b/.test(q) || /\bdemain\b/.test(q)) {
    const d = new Date(refDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: askLunaIsoDateUTC(d), label: 'tomorrow' };
  }
  if (/\btoday\b/.test(q) || /\bhoy\b/.test(q) || /\boggi\b/.test(q) || /\bheute\b/.test(q)
      || /\baujourdhui\b/.test(q) || /\baujourd hui\b/.test(q)) {
    return { date: askLunaTodayUTC(refDate), label: 'today' };
  }

  for (let i = 0; i < ASK_LUNA_WEEKDAYS.length; i++) {
    const name = ASK_LUNA_WEEKDAYS[i];
    if (new RegExp(`\\b${name}\\b`).test(q)) {
      const refDay = refDate.getUTCDay();
      let delta = i - refDay;
      if (delta < 0) delta += 7;
      const d = new Date(refDate);
      d.setUTCDate(d.getUTCDate() + delta);
      return { date: askLunaIsoDateUTC(d), label: name };
    }
  }

  return null;
}

function askLunaDatePhraseLabel(ctx) {
  const label = ctx.dateLabel || 'today';
  if (label === 'today') return 'today';
  if (label === 'tomorrow') return 'tomorrow';
  if (ASK_LUNA_WEEKDAYS.includes(label)) {
    return `on ${label.charAt(0).toUpperCase() + label.slice(1)}`;
  }
  if (/^20\d{2}-\d{2}-\d{2}$/.test(label)) return `on ${label}`;
  return ctx.date ? `on ${ctx.date}` : 'today';
}

function askLunaTotalGuestCount(rows) {
  return rows.reduce((sum, r) => {
    const gc = Number(r.guest_count);
    return sum + (gc > 0 ? gc : 1);
  }, 0);
}

function isBlockedAddOnServiceQuestion(q) {
  return /\b(yoga|meal|meals|surf\s*lesson|lessons?|wetsuit|surfboard|surf\s*board|board\s*rental)\b/.test(q);
}

function askLunaMatchesServiceYogaPaid(q) {
  return /\byoga\b/.test(q) && /\b(paid|paid for|pay for|who paid)\b/.test(q);
}

function askLunaMatchesServiceMealPaid(q) {
  return /\b(meal|meals)\b/.test(q) && /\b(paid|paid for|pay for|who paid)\b/.test(q);
}

function askLunaMatchesServiceLesson(q) {
  return /\b(surf\s*lesson|surf\s*lessons)\b/.test(q)
    || (/\blesson/.test(q) && /\b(surf|has|who|need)\b/.test(q));
}

function askLunaMatchesServiceWetsuit(q) {
  return /\bwetsuit/.test(q);
}

function askLunaMatchesServiceSurfboard(q) {
  return /\b(surfboard|surf\s*board|surf\s*boards)\b/.test(q)
    || (/\bboards?\b/.test(q) && /\b(surf|need|many|ready)\b/.test(q));
}

function askLunaServiceDateParams(question, today) {
  const dateInfo = resolveAskLunaDatePhrase(question);
  return dateInfo || { date: today, label: 'today' };
}

function resolveAskLunaServiceIntent(question, q, today, isCountQ) {
  const di = askLunaServiceDateParams(question, today);
  const extraParams = { date: di.date, dateLabel: di.label };

  if (isCountQ && askLunaMatchesServiceWetsuit(q)) {
    return { intentKey: 'services.wetsuit.count_on_date', extraParams };
  }
  if (isCountQ && askLunaMatchesServiceSurfboard(q)) {
    return { intentKey: 'services.surfboard.count_on_date', extraParams };
  }
  if (askLunaMatchesServiceYogaPaid(q)) {
    return { intentKey: 'services.yoga.paid_on_date', extraParams };
  }
  if (askLunaMatchesServiceMealPaid(q)) {
    return { intentKey: 'services.meal.paid_on_date', extraParams };
  }
  if (askLunaMatchesServiceLesson(q)) {
    return { intentKey: 'services.surf_lesson.on_date', extraParams };
  }
  if (askLunaMatchesServiceWetsuit(q)) {
    return { intentKey: 'services.wetsuit.on_date', extraParams };
  }
  if (askLunaMatchesServiceSurfboard(q)) {
    return { intentKey: 'services.surfboard.on_date', extraParams };
  }
  return null;
}

const ASK_LUNA_LOCAL_QUERY = {
  departures_today:              getAskLunaDeparturesTodayQuery,
  rooms_or_beds_need_cleaning:   getAskLunaRoomsNeedCleaningQuery,
  'check_ins.on_date':           getAskLunaCheckInsOnDateQuery,
  'check_ins.count':             getAskLunaCheckInsOnDateQuery,
  'check_outs.on_date':          getAskLunaCheckOutsOnDateQuery,
  'check_outs.count':            getAskLunaCheckOutsOnDateQuery,
  'services.yoga.paid_on_date':  getAskLunaServiceYogaPaidQuery,
  'services.meal.paid_on_date':  getAskLunaServiceMealPaidQuery,
  'services.surf_lesson.on_date': getAskLunaServiceSurfLessonQuery,
  'services.wetsuit.on_date':    getAskLunaServiceWetsuitQuery,
  'services.surfboard.on_date':  getAskLunaServiceSurfboardQuery,
  'services.wetsuit.count_on_date': getAskLunaServiceWetsuitCountQuery,
  'services.surfboard.count_on_date': getAskLunaServiceSurfboardCountQuery,
  'services.lessons_today':    getAskLunaLessonsOnDateQuery,
  'services.lessons_tomorrow': getAskLunaLessonsOnDateQuery,
  'services.gear_today':       getAskLunaGearOnDateQuery,
  'services.gear_tomorrow':    getAskLunaGearOnDateQuery,
  'services.meals_today':      getAskLunaMealsOnDateQuery,
  'services.meals_tomorrow':   getAskLunaMealsOnDateQuery,
  'services.yoga_today':       getAskLunaYogaOnDateQuery,
  'services.yoga_tomorrow':    getAskLunaYogaOnDateQuery,
  'services.meals_on_date':    getAskLunaMealsOnDateQuery,
  'services.yoga_on_date':     getAskLunaYogaOnDateQuery,
  [PENDING_MANUAL_KEY]:          getPendingManualServicesQuery,
  [PENDING_YOGA_KEY]:            getPendingManualYogaQuery,
  [PENDING_MEALS_KEY]:           getPendingManualMealsQuery,
  'bookings.arrivals_today':     getAskLunaArrivalsOnDateQuery,
  'bookings.arrivals_tomorrow':  getAskLunaArrivalsOnDateQuery,
  'bookings.arrivals_on_date':   getAskLunaArrivalsOnDateQuery,
  'bookings.checkouts_today':    getAskLunaCheckoutsOnDateQuery,
  'bookings.checkouts_tomorrow': getAskLunaCheckoutsOnDateQuery,
  'bookings.checkouts_on_date':  getAskLunaCheckoutsOnDateQuery,
  'housekeeping.cleaning_today':    getAskLunaCleaningOnDateQuery,
  'housekeeping.cleaning_tomorrow': getAskLunaCleaningOnDateQuery,
  'housekeeping.cleaning_on_date':  getAskLunaCleaningOnDateQuery,
  'bookings.occupancy_tonight':       getAskLunaOccupancyOnNightQuery,
  'bookings.occupancy_tomorrow_night': getAskLunaOccupancyOnNightQuery,
  'inventory.free_beds_tonight':       getAskLunaFreeBedsOnNightQuery,
  'inventory.free_beds_tomorrow_night': getAskLunaFreeBedsOnNightQuery,
  'bookings.lookup':               getAskLunaBookingLookupByCodeQuery,
};

const PENDING_MANUAL_QUERY_KEYS = new Set([
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
]);

/**
 * Returns { intentKey, extraParams } or null for unsupported questions.
 */
function resolveNaturalLanguageIntent(question) {
  const { REGISTRY_BY_KEY } = require('./staff-query-registry');
  const refDate = new Date();

  // Surf/wave forecast (Stormglass backend) before lessons/gear to avoid "good for lessons" mis-route
  const surfForecastIntentEarly = resolveAskLunaSurfForecastIntentKey(question, REGISTRY_BY_KEY);
  if (surfForecastIntentEarly) return surfForecastIntentEarly;

  // Lessons today/tomorrow before generic registry passthrough (needs date params)
  const lessonsIntentEarly = resolveAskLunaLessonsIntentKey(question, REGISTRY_BY_KEY, refDate);
  if (lessonsIntentEarly) return lessonsIntentEarly;

  const gearIntentEarly = resolveAskLunaGearIntentKey(question, REGISTRY_BY_KEY, refDate);
  if (gearIntentEarly) return gearIntentEarly;

  const pendingManualIntentEarly = resolveAskLunaPendingManualServicesIntentKey(
    question, REGISTRY_BY_KEY,
  );
  if (pendingManualIntentEarly) return pendingManualIntentEarly;

  const mealsYogaIntentEarly = resolveAskLunaMealsYogaIntentKey(question, REGISTRY_BY_KEY, refDate);
  if (mealsYogaIntentEarly) return mealsYogaIntentEarly;

  const bookingLookupIntentEarly = resolveAskLunaBookingLookupIntentKey(
    question, REGISTRY_BY_KEY, refDate,
  );
  if (bookingLookupIntentEarly) return bookingLookupIntentEarly;

  const handoffsIntentEarly = resolveAskLunaHandoffsIntentKey(question, REGISTRY_BY_KEY);
  if (handoffsIntentEarly) return handoffsIntentEarly;

  const cleaningIntentEarly = resolveAskLunaCleaningIntentKey(
    question, REGISTRY_BY_KEY, refDate,
  );
  if (cleaningIntentEarly) return cleaningIntentEarly;

  const occupancyIntentEarly = resolveAskLunaOccupancyIntentKey(
    question, REGISTRY_BY_KEY, refDate,
  );
  if (occupancyIntentEarly) return occupancyIntentEarly;

  const freeBedsIntentEarly = resolveAskLunaFreeBedsIntentKey(
    question, REGISTRY_BY_KEY, refDate,
  );
  if (freeBedsIntentEarly) return freeBedsIntentEarly;

  const arrivalsCheckoutsIntentEarly = resolveAskLunaArrivalsCheckoutsIntentKey(
    question, REGISTRY_BY_KEY, refDate,
  );
  if (arrivalsCheckoutsIntentEarly) return arrivalsCheckoutsIntentEarly;

  // Direct registry key passthrough before normalize (keeps dots in keys)
  const rawQ = String(question || '').trim().toLowerCase();
  if (REGISTRY_BY_KEY.has(rawQ)) return { intentKey: rawQ, extraParams: {} };

  const q = normalizeAskLunaQuestion(question);
  const today = askLunaTodayUTC();

  if (REGISTRY_BY_KEY.has(q)) return { intentKey: q, extraParams: {} };

  const dateInfo = resolveAskLunaDatePhrase(question);
  const isCountQ = askLunaIsCountQuestion(q);

  // ── Cleaning (8.8.4 i18n) — before checkout/payment to avoid false routes ──
  if (askLunaMatchesCleaning(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : { date: today, label: 'today' });
    return { intentKey: 'rooms_or_beds_need_cleaning', extraParams: { date: di.date, dateLabel: di.label } };
  }

  // ── Balance due (Phase 11a / 11a.1) — registry key + phrase list ──
  const balanceDueIntent = resolveBalanceDueIntentKey(question, REGISTRY_BY_KEY);
  if (balanceDueIntent && !/\bpayment.?link|checkout.?link|pending.?link|waiting.?for.?pay\b/.test(q)) {
    return { intentKey: balanceDueIntent, extraParams: {} };
  }

  // ── Check-in / check-out date queries (8.8.2 + 8.8.4) ──
  if (isCountQ && /\b(check.?in|checking in|arriv|arrival)\b/.test(q)) {
    const di = dateInfo || { date: today, label: 'today' };
    return { intentKey: 'check_ins.count', extraParams: { date: di.date, dateLabel: di.label } };
  }
  if (isCountQ && askLunaMatchesCheckout(q)) {
    const di = dateInfo || { date: today, label: 'today' };
    return { intentKey: 'check_outs.count', extraParams: { date: di.date, dateLabel: di.label } };
  }
  if (/\b(check.?in|checking in)\b/.test(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
    if (di) {
      return { intentKey: 'check_ins.on_date', extraParams: { date: di.date, dateLabel: di.label } };
    }
  }
  if (askLunaMatchesCheckout(q)) {
    const di = dateInfo || (askLunaHasTodayWord(q) ? { date: today, label: 'today' } : null);
    if (di) {
      if (askLunaIsDeparturesTodayPhrase(q, dateInfo, today)) {
        return { intentKey: 'departures_today', extraParams: { date: today, dateLabel: 'today' } };
      }
      return { intentKey: 'check_outs.on_date', extraParams: { date: di.date, dateLabel: di.label } };
    }
  }

  // ── Service / add-on records (8.8.11) — booking_service_records only ──
  const serviceIntent = resolveAskLunaServiceIntent(question, q, today, isCountQ);
  if (serviceIntent) return serviceIntent;

  // Natural language → intent mapping (English fallbacks)
  if (/payment.?link|checkout.?link|pending.?link|waiting.?for.?pay/.test(q))   return { intentKey: 'payments.waiting',            extraParams: {} };
  if (/arriv|check.?in.?today|arriving.?today/.test(q))                         return { intentKey: 'rooming.arrivals',            extraParams: { date: today } };
  if (/deposit.paid|paid.?deposit/.test(q))                                     return { intentKey: 'payments.deposit',            extraParams: {} };
  if (/confirm|confirmation.?need/.test(q))                                     return { intentKey: 'payments.confirmation_needed', extraParams: {} };
  if (/fully.?paid|paid.?in.?full/.test(q))                                     return { intentKey: 'payments.fully_paid',         extraParams: {} };
  if (/no.?payment.?record|missing.?payment/.test(q))                           return { intentKey: 'payments.no_record',          extraParams: {} };
  if (/active.?hold|holds?.active/.test(q))                                     return { intentKey: 'holds.active',                extraParams: {} };
  if (/unassign|no.?bed.?assign/.test(q))                                       return { intentKey: 'rooming.unassigned',          extraParams: {} };
  if (/addon.?action|add.?on.?action|staff.?action/.test(q))                    return { intentKey: 'addons.action_required',      extraParams: {} };

  if (/depart|check.?out.?today|leaving.?today|leave.?today|who leaves/.test(q)) return { intentKey: 'departures_today',            extraParams: { date: today, dateLabel: 'today' } };

  if (isBlockedAddOnServiceQuestion(q)) {
    return {
      intentKey: 'unsupported_intent',
      intentHint: 'Add-on or service queries (yoga, meals, lessons, wetsuit/board rentals)',
    };
  }

  return null;
}

/**
 * Resolve Ask Luna intent: deterministic phrases/registry first, then optional AI classifier.
 */
async function resolveAskLunaIntent(question) {
  const deterministic = resolveNaturalLanguageIntent(question);
  if (deterministic && deterministic.intentKey !== 'unsupported_intent') {
    return { ...deterministic, intent_source: 'deterministic' };
  }

  try {
    const opsPlan = await resolveOpsPlannerIntent(question);
    if (opsPlan && opsPlan.intentKey === OPS_MULTI_TOOL_INTENT) {
      return opsPlan;
    }
    if (opsPlan && opsPlan.intentKey === 'unsupported_intent') {
      return { ...opsPlan, intent_source: 'ops_planner' };
    }
  } catch (err) {
    console.warn('[ask-luna] ops planner error:', err.message);
  }

  try {
    const ai = await classifyAskLunaIntentWithAi(question);
    if (ai && ai.intent) {
      return {
        intentKey:     ai.intent,
        extraParams:   {},
        intent_source: 'ai',
        ai_confidence: ai.confidence,
        ai_reason:     ai.reason,
      };
    }
  } catch (err) {
    console.warn('[ask-luna] AI intent fallback error:', err.message);
  }

  if (deterministic) {
    return { ...deterministic, intent_source: 'deterministic' };
  }
  return null;
}

function askLunaIntentMeta(resolution) {
  if (!resolution) return { intent_source: 'none' };
  const meta = { intent_source: resolution.intent_source || 'deterministic' };
  if (resolution.ai_confidence != null) meta.ai_confidence = resolution.ai_confidence;
  if (resolution.ai_reason) meta.ai_reason = resolution.ai_reason;
  return meta;
}

/**
 * Formats query rows into a concise WhatsApp-friendly answer string.
 */
function formatAnswer(intentKey, rows, ctx = {}) {
  const n = rows.length;
  const when = askLunaDatePhraseLabel(ctx);

  if (n === 0) {
    const empty = {
      'payments.balance_due':         'No active bookings currently have a balance due.',
      'payments.waiting':             'No payment links are pending right now. ✅',
      'payments.deposit':             'No guests are in deposit-paid state.',
      'payments.fully_paid':          'No guests have paid in full yet.',
      'payments.confirmation_needed': 'No paid bookings awaiting confirmation.',
      'payments.no_record':           'No bookings missing a payment record.',
      'rooming.arrivals':             'No arriving guests need a bed assignment today. ✅',
      'rooming.unassigned':           'All bookings have a bed assigned. ✅',
      'departures_today':             'No guests are checking out today. ✅',
      'rooms_or_beds_need_cleaning':  'No beds need cleaning after today\'s departures. ✅',
      'check_ins.on_date':            `No guests are checking in ${when}.`,
      'check_ins.count':              `0 guests checking in ${when}.`,
      'check_outs.on_date':           `No guests are checking out ${when}.`,
      'check_outs.count':             `0 guests checking out ${when}.`,
      'handoffs.open':                'No conversations are currently waiting for staff.',
      'handoffs.urgent':              'No urgent handoffs are currently open.',
      'holds.active':                 'No active holds at the moment.',
      'addons.action_required':       'No add-ons require staff action.',
      'addons.lessons':               'No surf lessons found for that date.',
      'addons.yoga':                  'No yoga sessions found for that date.',
      'addons.rentals':               'No active rentals found for that date.',
      'services.yoga.paid_on_date':   `No yoga payments recorded ${when}.`,
      'services.meal.paid_on_date':   `No meal payments recorded ${when}.`,
      'services.surf_lesson.on_date': `No surf lessons scheduled ${when}.`,
      'services.lessons_today':       'No surf lessons are currently booked for today.',
      'services.lessons_tomorrow':    'No surf lessons are currently booked for tomorrow.',
      'services.gear_today':          'No surf gear is currently booked for today.',
      'services.gear_tomorrow':       'No surf gear is currently booked for tomorrow.',
      'services.meals_today':         'No meals are currently booked for today.',
      'services.meals_tomorrow':      'No meals are currently booked for tomorrow.',
      'services.yoga_today':          'No yoga classes are currently booked for today.',
      'services.yoga_tomorrow':       'No yoga classes are currently booked for tomorrow.',
      'services.meals_on_date':       'No meals are currently booked for that date.',
      'services.yoga_on_date':        'No yoga classes are currently booked for that date.',
      'services.pending_manual':      'No pending manual service requests need staff follow-up right now. ✅',
      'services.pending_yoga':        'No pending yoga requests need scheduling right now. ✅',
      'services.pending_meals':       'No pending meals requests need staff follow-up right now. ✅',
      'bookings.arrivals_today':      'No arrivals are currently scheduled for today.',
      'bookings.arrivals_tomorrow':   'No arrivals are currently scheduled for tomorrow.',
      'bookings.arrivals_on_date':    'No arrivals are currently scheduled for that date.',
      'bookings.checkouts_today':     'No checkouts are currently scheduled for today.',
      'bookings.checkouts_tomorrow':  'No checkouts are currently scheduled for tomorrow.',
      'bookings.checkouts_on_date':   'No checkouts are currently scheduled for that date.',
      'bookings.occupancy_tonight':       'No active guests are staying tonight.',
      'bookings.occupancy_tomorrow_night': 'No active guests are staying tomorrow night.',
      'inventory.free_beds_tonight':       'No sellable beds appear free tonight.',
      'inventory.free_beds_tomorrow_night': 'No sellable beds appear free tomorrow night.',
      'housekeeping.cleaning_today':    'No rooms or beds are currently flagged for checkout cleaning today.',
      'housekeeping.cleaning_tomorrow': 'No rooms or beds are currently flagged for checkout cleaning tomorrow.',
      'housekeeping.cleaning_on_date':  `No rooms or beds are currently flagged for checkout cleaning ${when}.`,
      'bookings.lookup':              'I couldn\'t find an active booking matching that.',
      'services.wetsuit.on_date':     `No wetsuits needed ${when}.`,
      'services.surfboard.on_date':   `No surfboards needed ${when}.`,
    };
    return empty[intentKey] || `No results for ${intentKey}.`;
  }

  const MAX_SUMMARY = 5;
  const extra = n > MAX_SUMMARY ? ` (+${n - MAX_SUMMARY} more)` : '';

  const nameLine = (r) => r.guest_name ? `${r.guest_name} (${r.booking_code || ''})` : (r.booking_code || r.id || '?');
  const serviceNameLine = (r) => {
    const qty = Number(r.quantity) > 1 ? ` ×${r.quantity}` : '';
    return `${nameLine(r)}${qty}`;
  };
  const centsStr = (c) => c != null ? `€${(Math.round(c) / 100).toFixed(0)}` : '';
  const stayLine = (r) => {
    const beds = r.bed_summary ? ` — ${r.bed_summary}` : (
      r.room_code && r.bed_code ? ` — ${r.room_code}/${r.bed_code}` : ''
    );
    const gc = r.guest_count > 0 ? `, ${r.guest_count} guest${r.guest_count !== 1 ? 's' : ''}` : '';
    return `${nameLine(r)}${gc}${beds}`;
  };

  switch (intentKey) {
    case 'payments.balance_due':
      return formatAskLunaBalanceDueAnswer(rows);
    case 'payments.deposit': {
      const list = rows.slice(0, MAX_SUMMARY).map(r =>
        `${nameLine(r)} — balance ${centsStr(r.balance_due_cents)}`
      ).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} still owe${n !== 1 ? '' : 's'} a balance: ${list}${extra}`;
    }
    case 'payments.waiting': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} a payment link pending: ${list}${extra}`;
    }
    case 'payments.fully_paid': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} paid in full: ${list}${extra}`;
    }
    case 'payments.confirmation_needed': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} still need${n !== 1 ? '' : 's'} a confirmation sent: ${list}${extra}`;
    }
    case 'payments.no_record': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} booking${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} no payment record: ${list}${extra}`;
    }
    case 'rooming.arrivals': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} arrival${n !== 1 ? 's' : ''} still need${n !== 1 ? '' : 's'} a bed assignment today: ${list}${extra}`;
    }
    case 'rooming.unassigned': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} booking${n !== 1 ? 's' : ''} ha${n !== 1 ? 've' : 's'} no bed assigned yet: ${list}${extra}`;
    }
    case 'departures_today': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => {
        const bed = r.room_code && r.bed_code ? ` — ${r.room_code}/${r.bed_code}` : '';
        return `${nameLine(r)}${bed}`;
      }).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} leaving today: ${list}${extra}`;
    }
    case 'check_ins.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(stayLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} checking in ${when}: ${list}${extra}`;
    }
    case 'check_ins.count': {
      const people = askLunaTotalGuestCount(rows);
      return `${people} guest${people !== 1 ? 's' : ''} checking in ${when}.`;
    }
    case 'check_outs.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(stayLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} checking out ${when}: ${list}${extra}`;
    }
    case 'check_outs.count': {
      const people = askLunaTotalGuestCount(rows);
      return `${people} guest${people !== 1 ? 's' : ''} checking out ${when}.`;
    }
    case 'rooms_or_beds_need_cleaning': {
      const list = rows.slice(0, MAX_SUMMARY).map(r =>
        `${r.room_code}/${r.bed_code}${r.guest_name ? ` (${r.guest_name} checked out)` : ''}`
      ).join('; ');
      return `${n} bed${n !== 1 ? 's' : ''} need cleaning after today's departures: ${list}${extra}`;
    }
    case 'handoffs.open':
    case 'handoffs.urgent':
      return formatAskLunaHandoffsAnswer(intentKey, rows, ctx);
    case 'holds.active': {
      const list = rows.slice(0, MAX_SUMMARY).map(r => nameLine(r)).join('; ');
      return `${n} active hold${n !== 1 ? 's' : ''}: ${list}${extra}`;
    }
    case 'services.yoga.paid_on_date':
    case 'services.meal.paid_on_date': {
      const svc = intentKey.includes('meal') ? 'meal' : 'yoga';
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} paid ${svc}${n !== 1 ? 's' : ''} ${when}: ${list}${extra}`;
    }
    case 'services.surf_lesson.on_date': {
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} surf lesson${n !== 1 ? 's' : ''} ${when}: ${list}${extra}`;
    }
    case 'services.wetsuit.on_date':
    case 'services.surfboard.on_date': {
      const gear = intentKey.includes('wetsuit') ? 'wetsuit' : 'surfboard';
      const list = rows.slice(0, MAX_SUMMARY).map(serviceNameLine).join('; ');
      return `${n} guest${n !== 1 ? 's' : ''} need${n !== 1 ? '' : 's'} a ${gear} ${when}: ${list}${extra}`;
    }
    case 'services.wetsuit.count_on_date': {
      const total = Number(rows[0]?.quantity ?? 0);
      return `${total} wetsuit${total !== 1 ? 's' : ''} needed ${when}.`;
    }
    case 'services.surfboard.count_on_date': {
      const total = Number(rows[0]?.quantity ?? 0);
      return `${total} surfboard${total !== 1 ? 's' : ''} needed ${when}.`;
    }
    case 'services.lessons_today':
    case 'services.lessons_tomorrow':
      return formatAskLunaLessonsAnswer(rows, ctx);
    case 'services.gear_today':
    case 'services.gear_tomorrow':
      return formatAskLunaGearAnswer(rows, ctx);
    case 'services.meals_today':
    case 'services.meals_tomorrow':
    case 'services.yoga_today':
    case 'services.yoga_tomorrow':
    case 'services.meals_on_date':
    case 'services.yoga_on_date': {
      const serviceCategory = intentKey.includes('yoga') ? 'yoga' : 'meals';
      return formatAskLunaMealsYogaAnswer(rows, { ...ctx, serviceCategory });
    }
    case PENDING_MANUAL_KEY:
    case PENDING_YOGA_KEY:
    case PENDING_MEALS_KEY:
      return formatAskLunaPendingManualServicesAnswer(intentKey, rows, ctx);
    case 'bookings.arrivals_today':
    case 'bookings.arrivals_tomorrow':
    case 'bookings.arrivals_on_date':
    case 'bookings.checkouts_today':
    case 'bookings.checkouts_tomorrow':
    case 'bookings.checkouts_on_date': {
      const flow = intentKey.includes('checkout') ? 'checkouts' : 'arrivals';
      return formatAskLunaArrivalsCheckoutsAnswer(rows, { ...ctx, flow });
    }
    case 'housekeeping.cleaning_today':
    case 'housekeeping.cleaning_tomorrow':
    case 'housekeeping.cleaning_on_date':
      return formatAskLunaCleaningAnswer(rows, ctx);
    case 'bookings.occupancy_tonight':
    case 'bookings.occupancy_tomorrow_night':
      return formatAskLunaOccupancyAnswer(rows, ctx);
    case 'inventory.free_beds_tonight':
    case 'inventory.free_beds_tomorrow_night':
      return formatAskLunaFreeBedsAnswer(rows, ctx);
    case 'bookings.lookup':
      return formatAskLunaBookingLookupAnswer(rows, ctx);
    default: {
      return `${n} result${n !== 1 ? 's' : ''} for ${intentKey}${extra}.`;
    }
  }
}
async function executeStaffAskLunaQuestion(input, context = {}) {
  const started = Date.now();
  const clientSlug = String((input && input.client_slug) || DEFAULT_CLIENT).trim();
  const locationId = isSunsetClientSlug(clientSlug)
    ? normalizeSunsetLocationId((input && input.location_id) || DEFAULT_SUNSET_LOCATION_ID)
    : null;
  const question = String((input && input.question) || '').trim();
  const source = String((input && input.source) || 'staff_portal').trim();
  const staffAccess = (input && input.staff_access) || 'session';
  const runPg = (context && context.pg)
    ? (fn) => fn(context.pg)
    : (fn) => withPgClient(fn);

  if (!question) {
    return { success: false, error: 'question_required', elapsed_ms: Date.now() - started };
  }

  const resolution = await resolveAskLunaIntent(question);
  const supportedList = [
    'who owes money (payments.balance_due)',
    'payment links pending (payments.waiting)',
    'arrivals today (rooming.arrivals)',
    'who is checking in today/tomorrow/Saturday (check_ins.on_date)',
    'how many check in tomorrow (check_ins.count)',
    'departures today (departures_today)',
    'who is checking out tomorrow/Saturday (check_outs.on_date)',
    'how many check out tomorrow (check_outs.count)',
    'rooms/beds needing cleaning (rooms_or_beds_need_cleaning)',
    'who paid for yoga/meals (services.yoga/meal.paid_on_date)',
    'surf lessons today or tomorrow (services.lessons_today / services.lessons_tomorrow)',
    'surf/wave forecast today or tomorrow (forecast.surf_today / forecast.surf_tomorrow)',
    'surf gear today or tomorrow (services.gear_today / services.gear_tomorrow)',
    'meals or yoga today/tomorrow/weekday (services.meals_* / services.yoga_*)',
    'pending manual services (services.pending_manual / services.pending_yoga / services.pending_meals)',
    'arrivals or checkouts today/tomorrow/weekday (bookings.arrivals_* / bookings.checkouts_*)',
    'surf lessons / wetsuits / surfboards (services.*)',
    'who needs human reply (handoffs.open)',
    'deposit paid (payments.deposit)',
    'confirmation needed (payments.confirmation_needed)',
    'active holds (holds.active)',
    'unassigned beds (rooming.unassigned)',
  ].join(', ');

  if (!resolution || resolution.intentKey === 'unsupported_intent') {
    const hint = resolution ? resolution.intentHint : null;
    const answer = hint
      ? `"${hint}" is not yet in the query registry. You can ask: ${supportedList}`
      : `I don't know how to answer that yet. You can ask about: ${supportedList}`;
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: 'unsupported_intent',
      intent_hint: hint || null,
      answer,
      rows: [],
      row_count: 0,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
    };
  }

  const { intentKey, extraParams } = resolution;
  const intentMeta = askLunaIntentMeta(resolution);

  if (intentKey === OPS_MULTI_TOOL_INTENT) {
    const toolIntents = extraParams.tool_intents || [];
    const planDate = extraParams.date || askLunaTodayUTC();
    const planCtx = { date: planDate, dateLabel: extraParams.dateLabel || 'today' };
    let allRows = [];
    let sections = [];
    try {
      await runPg(async (pgClient) => {
        const out = await executeOpsPlannerTools(pgClient, clientSlug, toolIntents, planCtx);
        sections = out.sections;
        allRows = out.allRows;
      });
    } catch (err) {
      return { success: false, error: 'query_error', detail: err.message, elapsed_ms: Date.now() - started };
    }
    const answer = formatCombinedOpsPlannerAnswer(sections, planCtx.dateLabel);
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: OPS_MULTI_TOOL_INTENT,
      category: 'ops',
      query_date: planDate,
      tool_intents: toolIntents,
      answer,
      rows: allRows.slice(0, MAX_ROWS),
      row_count: allRows.length,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  if (intentKey === SURF_FORECAST_TODAY_KEY || intentKey === SURF_FORECAST_TOMORROW_KEY) {
    const day = extraParams.day || (intentKey === SURF_FORECAST_TOMORROW_KEY ? 'tomorrow' : 'today');
    let surfResult;
    try {
      surfResult = await fetchSurfForecastForAskLuna({ clientSlug, day });
    } catch (err) {
      surfResult = { ok: false, answer: ASK_LUNA_SURF_FORECAST_UNAVAILABLE_ANSWER, unavailable: true };
    }
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: intentKey,
      category: 'forecast',
      query_day: day,
      answer: surfResult.answer,
      rows: [],
      row_count: 0,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      surf_forecast_unavailable: surfResult.unavailable === true,
      surf_forecast_source: surfResult.source || (surfResult.unavailable ? null : 'stormglass'),
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  if (ASK_LUNA_LOCAL_QUERY[intentKey]) {
    const today = extraParams.date || askLunaTodayUTC();
    const fmtCtx = {
      date: today,
      dateLabel: extraParams.dateLabel || 'today',
      serviceCategory: extraParams.serviceCategory,
      flow: extraParams.flow,
      nightLabel: extraParams.nightLabel,
      lookupMode: extraParams.lookupMode,
      lookupFocus: extraParams.lookupFocus,
      searchValue: extraParams.searchValue,
      roomCode: extraParams.roomCode,
      bedCode: extraParams.bedCode,
      pendingCategory: extraParams.pendingCategory,
    };
    let localRows = [];
    try {
      let sql;
      let queryParams;
      if (intentKey === 'bookings.lookup') {
        const bundle = buildAskLunaBookingLookupQuery(extraParams, clientSlug);
        sql = bundle.sql;
        queryParams = bundle.params;
      } else if (PENDING_MANUAL_QUERY_KEYS.has(intentKey)) {
        sql = ASK_LUNA_LOCAL_QUERY[intentKey]();
        queryParams = [clientSlug];
      } else {
        sql = ASK_LUNA_LOCAL_QUERY[intentKey]();
        queryParams = [clientSlug, today];
      }
      if (isSunsetClientSlug(clientSlug) && intentKey.startsWith('services.')) {
        const scoped = applySunsetAskLunaLocationFilter(sql, queryParams, clientSlug, locationId);
        sql = scoped.sql;
        queryParams = scoped.params;
      }
      localRows = await runPg(async (pgClient) => {
        const result = await pgClient.query(sql, queryParams);
        return result.rows;
      });
    } catch (err) {
      return { success: false, error: 'query_error', detail: err.message, elapsed_ms: Date.now() - started };
    }
    const answer = formatAnswer(intentKey, localRows, fmtCtx);
    const category = intentKey.startsWith('services.') ? 'services'
      : intentKey.startsWith('check_ins') ? 'arrivals'
      : (intentKey.startsWith('check_outs') || intentKey === 'departures_today') ? 'departures'
      : 'rooming';
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: intentKey,
      category,
      query_date: today,
      answer,
      rows: localRows.slice(0, MAX_ROWS),
      row_count: localRows.length,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  if (intentKey === 'payments.balance_due') {
    let balanceRows = [];
    try {
      balanceRows = await runPg((pgClient) => computeBalanceDueRows(pgClient, clientSlug));
    } catch (err) {
      return { success: false, error: 'query_error', detail: err.message, elapsed_ms: Date.now() - started };
    }
    const { answer, answer_format_source } = await formatBalanceDueAnswerNatural(balanceRows);
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: intentKey,
      category: 'payments',
      answer,
      answer_format_source,
      rows: balanceRows.slice(0, MAX_ROWS),
      row_count: balanceRows.length,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  if (intentKey === 'handoffs.open' || intentKey === 'handoffs.urgent') {
    let handoffRows = [];
    try {
      handoffRows = await runPg((pgClient) => fetchAskLunaHandoffRows(pgClient, clientSlug, intentKey));
    } catch (err) {
      return { success: false, error: 'query_error', detail: err.message, elapsed_ms: Date.now() - started };
    }
    const answer = formatAskLunaHandoffsAnswer(intentKey, handoffRows);
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: intentKey,
      category: 'handoffs',
      answer,
      rows: handoffRows.slice(0, MAX_ROWS),
      row_count: handoffRows.length,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  const registryEntry = getEntry(intentKey);
  if (!registryEntry || registryEntry.missingHelper === true || typeof registryEntry.helperRef !== 'function') {
    return {
      success: true,
      client_slug: clientSlug,
      location_id: locationId,
      source,
      staff_access: staffAccess,
      intent: intentKey,
      answer: `The "${intentKey}" query helper is not yet available (migration or implementation pending).`,
      rows: [],
      row_count: 0,
      read_only: true,
      no_write_performed: true,
      sends_whatsapp: false,
      elapsed_ms: Date.now() - started,
      ...intentMeta,
    };
  }

  const queryObj = { client: clientSlug, ...extraParams };
  const { params } = resolveParams(registryEntry, clientSlug, queryObj);
  let rows = [];
  try {
    const sql = registryEntry.helperRef();
    rows = await runPg(async (pgClient) => {
      const result = await pgClient.query(sql, params);
      return result.rows;
    });
  } catch (err) {
    return { success: false, error: 'query_error', detail: err.message, elapsed_ms: Date.now() - started };
  }
  const answer = formatAnswer(intentKey, rows);
  return {
    success: true,
    client_slug: clientSlug,
    source,
    staff_access: staffAccess,
    intent: intentKey,
    category: registryEntry.category,
    answer,
    rows: rows.slice(0, MAX_ROWS),
    row_count: rows.length,
    read_only: true,
    no_write_performed: true,
    sends_whatsapp: false,
    elapsed_ms: Date.now() - started,
    ...intentMeta,
  };
}


module.exports = {
  DEFAULT_CLIENT,
  MAX_ROWS,
  askLunaTodayUTC,
  normalizeAskLunaQuestion,
  resolveNaturalLanguageIntent,
  resolveAskLunaIntent,
  askLunaIntentMeta,
  formatAnswer,
  executeStaffAskLunaQuestion,
  ASK_LUNA_LOCAL_QUERY,
};
