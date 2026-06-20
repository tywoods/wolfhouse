/**
 * Phase 11b — Staff Ask Luna surf lessons today/tomorrow (read-only).
 *
 * Structured sources: booking_service_records, bookings, booking_beds.
 * No chat logs, writes, Stripe, WhatsApp, or n8n.
 *
 * @module staff-ask-luna-lessons
 */

'use strict';

const LESSONS_TODAY_KEY = 'services.lessons_today';
const LESSONS_TOMORROW_KEY = 'services.lessons_tomorrow';

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

function normalizeLessonsQuestionText(question) {
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

function matchesLessonTopic(q) {
  return /\b(surf\s*lessons?|surf\s*lesson)\b/.test(q)
    || /\blessons?\b/.test(q);
}

function matchesLessonsTodayQuestion(question) {
  const raw = String(question || '').trim().toLowerCase();
  if (raw === LESSONS_TODAY_KEY) return true;
  const q = normalizeLessonsQuestionText(question);
  if (!askLunaHasTodayWord(q) || !matchesLessonTopic(q)) return false;
  if (askLunaHasTomorrowWord(q)) return false;
  return true;
}

function matchesLessonsTomorrowQuestion(question) {
  const raw = String(question || '').trim().toLowerCase();
  if (raw === LESSONS_TOMORROW_KEY) return true;
  const q = normalizeLessonsQuestionText(question);
  return askLunaHasTomorrowWord(q) && matchesLessonTopic(q);
}

/**
 * Resolve lessons today/tomorrow intent (deterministic routing only).
 * @returns {{ intentKey: string, extraParams: { date: string, dateLabel: string } } | null}
 */
function resolveAskLunaLessonsIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw)) {
    if (raw === LESSONS_TODAY_KEY || raw === LESSONS_TOMORROW_KEY) {
      const dateLabel = raw === LESSONS_TOMORROW_KEY ? 'tomorrow' : 'today';
      const date = dateLabel === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
      return { intentKey: raw, extraParams: { date, dateLabel } };
    }
  }
  if (matchesLessonsTomorrowQuestion(question)) {
    return {
      intentKey: LESSONS_TOMORROW_KEY,
      extraParams: { date: askLunaTomorrowUTC(refDate), dateLabel: 'tomorrow' },
    };
  }
  if (matchesLessonsTodayQuestion(question)) {
    return {
      intentKey: LESSONS_TODAY_KEY,
      extraParams: { date: askLunaTodayUTC(refDate), dateLabel: 'today' },
    };
  }
  return null;
}

/**
 * Surf lessons on a date from booking_service_records + active bookings.
 * $1 = client slug, $2 = service_date (YYYY-MM-DD)
 */
function getAskLunaLessonsOnDateQuery() {
  return `
SELECT
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  sr.service_type::text                       AS service_type,
  sr.service_date::text                     AS service_date,
  sr.quantity,
  sr.status::text                           AS service_status,
  sr.payment_status::text                   AS payment_status,
  sr.id::text                               AS service_record_id,
  sr.metadata->>'slot_time'                 AS slot_time,
  sr.metadata->>'notes'                     AS notes,
  COALESCE((sr.metadata->>'needs_reply')::boolean, false) AS needs_reply,
  sr.metadata->>'staff_ui_service_type'     AS staff_ui_service_type,
  sr.source                                 AS record_source,
  sr.metadata,
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
  AND sr.service_type = 'surf_lesson'
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_date ASC
`;
}

function lessonServiceLabel(serviceType) {
  const t = String(serviceType || 'surf_lesson').toLowerCase();
  if (t === 'surf_lesson') return 'surf lesson';
  return t.replace(/_/g, ' ');
}

function aggregateLessonsByBooking(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const code = r.booking_code || 'unknown';
    const qty = Number(r.quantity) > 0 ? Number(r.quantity) : 1;
    if (!map.has(code)) {
      map.set(code, {
        guest_name:      r.guest_name || null,
        booking_code:    code,
        bed_summary:     r.bed_summary || null,
        service_date:    r.service_date,
        service_status:  r.service_status || null,
        payment_status:  r.payment_status || null,
        lesson_count:    0,
      });
    }
    const entry = map.get(code);
    entry.lesson_count += qty;
    if (!entry.guest_name && r.guest_name) entry.guest_name = r.guest_name;
    if (!entry.bed_summary && r.bed_summary) entry.bed_summary = r.bed_summary;
  }
  return [...map.values()].sort((a, b) => b.lesson_count - a.lesson_count);
}

/**
 * Format lesson rows for staff (deterministic).
 * @param {object[]} rows
 * @param {{ dateLabel?: string }} [ctx]
 */
function formatAskLunaLessonsAnswer(rows, ctx = {}) {
  const dayLabel = ctx.dateLabel === 'tomorrow' ? 'tomorrow' : 'today';
  const list = rows || [];
  if (list.length === 0) {
    return `No surf lessons are currently booked for ${dayLabel}.`;
  }

  const totalLessons = list.reduce((s, r) => s + (Number(r.quantity) > 0 ? Number(r.quantity) : 1), 0);
  const bookings = aggregateLessonsByBooking(list);
  const lines = [
    `${dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1)} there are ${totalLessons} surf lesson${totalLessons !== 1 ? 's' : ''} booked.`,
    '',
  ];

  for (const b of bookings) {
    const name = b.guest_name || b.booking_code || 'Guest';
    const bed = b.bed_summary ? ` — ${b.bed_summary}` : '';
    const statusBits = [];
    if (b.payment_status) statusBits.push(`payment ${b.payment_status}`);
    if (b.service_status) statusBits.push(`service ${b.service_status}`);
    const statusPart = statusBits.length ? ` (${statusBits.join(', ')})` : '';
    lines.push(
      `${name} has ${b.lesson_count} lesson${b.lesson_count !== 1 ? 's' : ''} ${dayLabel}${bed} — booking ${b.booking_code}${statusPart}.`,
    );
  }

  lines.push('');
  lines.push(`Total: ${totalLessons} lesson${totalLessons !== 1 ? 's' : ''} across ${bookings.length} booking${bookings.length !== 1 ? 's' : ''}.`);
  return lines.join('\n');
}

/** Verifier smoke: inline helpers + resolver (no module scope). */
function getAskLunaLessonsRoutingSmokeBlock() {
  const consts = `const LESSONS_TODAY_KEY = ${JSON.stringify(LESSONS_TODAY_KEY)};
const LESSONS_TOMORROW_KEY = ${JSON.stringify(LESSONS_TOMORROW_KEY)};`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeLessonsQuestionText,
    askLunaHasTodayWord,
    askLunaHasTomorrowWord,
    matchesLessonTopic,
    matchesLessonsTodayQuestion,
    matchesLessonsTomorrowQuestion,
    resolveAskLunaLessonsIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  LESSONS_TODAY_KEY,
  LESSONS_TOMORROW_KEY,
  askLunaTodayUTC,
  askLunaTomorrowUTC,
  resolveAskLunaLessonsIntentKey,
  matchesLessonsTodayQuestion,
  matchesLessonsTomorrowQuestion,
  getAskLunaLessonsOnDateQuery,
  formatAskLunaLessonsAnswer,
  aggregateLessonsByBooking,
  getAskLunaLessonsRoutingSmokeBlock,
};
