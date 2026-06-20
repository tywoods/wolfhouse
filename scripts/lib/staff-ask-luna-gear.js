/**
 * Phase 11c — Staff Ask Luna surf gear (boards/wetsuits) today/tomorrow (read-only).
 *
 * Structured sources: booking_service_records, bookings, booking_beds.
 * Combo add-ons are stored as separate wetsuit + surfboard rows — both count in totals.
 *
 * @module staff-ask-luna-gear
 */

'use strict';

const GEAR_TODAY_KEY = 'services.gear_today';
const GEAR_TOMORROW_KEY = 'services.gear_tomorrow';

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

function normalizeGearQuestionText(question) {
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

function matchesGearTopic(q) {
  if (/\b(surf\s*lessons?)\b/.test(q) && !/\b(gear|wetsuit|board|surfboard|soft|hard)\b/.test(q)) {
    return false;
  }
  return /\b(gear|surf\s*gear)\b/.test(q)
    || /\bwetsuits?\b/.test(q)
    || /\b(soft\s*tops?|soft\s*boards?|softboards?)\b/.test(q)
    || /\b(hard\s*boards?|hardboards?)\b/.test(q)
    || /\b(surfboards?|surf\s*boards?)\b/.test(q)
    || (/\bboards?\b/.test(q) && /\b(need|needs|many|how many|ready|surf|gear|rental|wetsuit)\b/.test(q));
}

function matchesGearTodayQuestion(question) {
  const raw = String(question || '').trim().toLowerCase();
  if (raw === GEAR_TODAY_KEY) return true;
  const q = normalizeGearQuestionText(question);
  if (!askLunaHasTodayWord(q) || !matchesGearTopic(q)) return false;
  if (askLunaHasTomorrowWord(q)) return false;
  return true;
}

function matchesGearTomorrowQuestion(question) {
  const raw = String(question || '').trim().toLowerCase();
  if (raw === GEAR_TOMORROW_KEY) return true;
  const q = normalizeGearQuestionText(question);
  return askLunaHasTomorrowWord(q) && matchesGearTopic(q);
}

/**
 * @returns {{ intentKey: string, extraParams: { date: string, dateLabel: string } } | null}
 */
function resolveAskLunaGearIntentKey(question, registryByKey, refDate = new Date()) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw)) {
    if (raw === GEAR_TODAY_KEY || raw === GEAR_TOMORROW_KEY) {
      const dateLabel = raw === GEAR_TOMORROW_KEY ? 'tomorrow' : 'today';
      const date = dateLabel === 'tomorrow' ? askLunaTomorrowUTC(refDate) : askLunaTodayUTC(refDate);
      return { intentKey: raw, extraParams: { date, dateLabel } };
    }
  }
  if (matchesGearTomorrowQuestion(question)) {
    return {
      intentKey: GEAR_TOMORROW_KEY,
      extraParams: { date: askLunaTomorrowUTC(refDate), dateLabel: 'tomorrow' },
    };
  }
  if (matchesGearTodayQuestion(question)) {
    return {
      intentKey: GEAR_TODAY_KEY,
      extraParams: { date: askLunaTodayUTC(refDate), dateLabel: 'today' },
    };
  }
  return null;
}

/**
 * Wetsuits and boards on a date — booking_service_records + active bookings.
 * $1 = client slug, $2 = service_date (YYYY-MM-DD)
 */
function getAskLunaGearOnDateQuery() {
  return `
SELECT
  b.id::text                                AS booking_id,
  NULLIF(BTRIM(b.phone), '')                AS phone,
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
  AND sr.service_type IN ('wetsuit', 'surfboard')
  AND sr.booking_id IS NOT NULL
  AND sr.status <> 'cancelled'
  AND LOWER(b.status::text) NOT IN ('cancelled', 'canceled', 'expired', 'hold')
ORDER BY guest_name ASC NULLS LAST, booking_code ASC NULLS LAST, sr.service_type ASC
`;
}

function parseGearMetadata(meta) {
  if (!meta) return {};
  if (typeof meta === 'object' && !Array.isArray(meta)) return meta;
  try {
    return JSON.parse(meta);
  } catch (_) {
    return {};
  }
}

function rowGearPartLabel(row) {
  const meta = parseGearMetadata(row.metadata);
  const code = String(meta.source_quote_line_code || '').toLowerCase();
  if (row.service_type === 'wetsuit') return 'wetsuit';
  if (code.includes('soft') || code.includes('soft_top')) return 'soft board';
  if (code.includes('hard') || code.includes('hard_board')) return 'hard board';
  return 'board';
}

function rowQuantity(row) {
  return Number(row.quantity) > 0 ? Number(row.quantity) : 1;
}

function countGearTotals(rows) {
  let totalBoards = 0;
  let totalWetsuits = 0;
  for (const r of rows || []) {
    const qty = rowQuantity(r);
    if (r.service_type === 'wetsuit') totalWetsuits += qty;
    else if (r.service_type === 'surfboard') totalBoards += qty;
  }
  return { totalBoards, totalWetsuits };
}

const GEAR_PART_ORDER = ['soft board', 'hard board', 'board', 'wetsuit'];

function aggregateGearByBooking(rows) {
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
        parts:          new Set(),
        board_count:    0,
        wetsuit_count:  0,
      });
    }
    const entry = map.get(code);
    entry.parts.add(rowGearPartLabel(r));
    if (r.service_type === 'wetsuit') entry.wetsuit_count += qty;
    else if (r.service_type === 'surfboard') entry.board_count += qty;
    if (!entry.guest_name && r.guest_name) entry.guest_name = r.guest_name;
    if (!entry.bed_summary && r.bed_summary) entry.bed_summary = r.bed_summary;
    if (!entry.service_status && r.service_status) entry.service_status = r.service_status;
    if (!entry.payment_status && r.payment_status) entry.payment_status = r.payment_status;
  }
  return [...map.values()].map((e) => {
    const gear_label = GEAR_PART_ORDER.filter((p) => e.parts.has(p)).join(' + ');
    return { ...e, gear_label: gear_label || 'gear' };
  }).sort((a, b) => (b.board_count + b.wetsuit_count) - (a.board_count + a.wetsuit_count));
}

/**
 * @param {object[]} rows
 * @param {{ dateLabel?: string }} [ctx]
 */
function formatAskLunaGearAnswer(rows, ctx = {}) {
  const dayLabel = ctx.dateLabel === 'tomorrow' ? 'tomorrow' : 'today';
  const list = rows || [];
  if (list.length === 0) {
    return `No surf gear is currently booked for ${dayLabel}.`;
  }

  const { totalBoards, totalWetsuits } = countGearTotals(list);
  const bookings = aggregateGearByBooking(list);
  const dayCap = dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);

  const lines = [
    `${dayCap} you need ${totalBoards} board${totalBoards !== 1 ? 's' : ''} and ${totalWetsuits} wetsuit${totalWetsuits !== 1 ? 's' : ''}.`,
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
      `${name} — ${b.gear_label}${bed} — booking ${b.booking_code}${statusPart}.`,
    );
  }

  lines.push('');
  lines.push(
    `Totals: ${totalBoards} board${totalBoards !== 1 ? 's' : ''}, ${totalWetsuits} wetsuit${totalWetsuits !== 1 ? 's' : ''} across ${bookings.length} booking${bookings.length !== 1 ? 's' : ''}.`,
  );
  return lines.join('\n');
}

/** Verifier smoke: inline helpers + resolver (no module scope). */
function getAskLunaGearRoutingSmokeBlock() {
  const consts = `const GEAR_TODAY_KEY = ${JSON.stringify(GEAR_TODAY_KEY)};
const GEAR_TOMORROW_KEY = ${JSON.stringify(GEAR_TOMORROW_KEY)};`;
  const fns = [
    askLunaIsoDateUTC,
    askLunaTodayUTC,
    askLunaTomorrowUTC,
    normalizeGearQuestionText,
    askLunaHasTodayWord,
    askLunaHasTomorrowWord,
    matchesGearTopic,
    matchesGearTodayQuestion,
    matchesGearTomorrowQuestion,
    resolveAskLunaGearIntentKey,
  ].map((fn) => fn.toString()).join('\n');
  return `${consts}\n${fns}`;
}

module.exports = {
  GEAR_TODAY_KEY,
  GEAR_TOMORROW_KEY,
  askLunaTodayUTC,
  askLunaTomorrowUTC,
  resolveAskLunaGearIntentKey,
  matchesGearTodayQuestion,
  matchesGearTomorrowQuestion,
  getAskLunaGearOnDateQuery,
  formatAskLunaGearAnswer,
  countGearTotals,
  aggregateGearByBooking,
  rowGearPartLabel,
  getAskLunaGearRoutingSmokeBlock,
};
