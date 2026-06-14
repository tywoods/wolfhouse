'use strict';

/**
 * Stage 34a — Ask Luna read-only pending manual service requests (yoga/meals).
 *
 * @module staff-ask-luna-pending-manual-services
 */

const {
  formatPendingManualServiceStaffLine,
} = require('./staff-pending-manual-services');

const PENDING_MANUAL_KEY = 'services.pending_manual';
const PENDING_YOGA_KEY = 'services.pending_yoga';
const PENDING_MEALS_KEY = 'services.pending_meals';

const PENDING_MANUAL_KEYS = new Set([
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
]);

function normalizePendingManualQuestionText(question) {
  let q = String(question || '').toLowerCase().trim();
  q = q.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  q = q.replace(/[''`´]/g, ' ');
  q = q.replace(/[?!.,;:()[\]{}""]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q;
}

function buildPendingManualServicesQuery(serviceType) {
  const typeFilter = serviceType
    ? `AND sr.service_type = '${serviceType}'`
    : '';
  return `
SELECT
  sr.id::text                         AS service_record_id,
  COALESCE(sr.booking_code, b.booking_code) AS booking_code,
  COALESCE(sr.guest_name, b.guest_name)     AS guest_name,
  sr.service_type::text               AS service_type,
  sr.status::text                     AS service_status,
  sr.source::text                     AS source,
  sr.service_date::text               AS service_date,
  sr.created_at::text                 AS requested_at,
  sr.metadata,
  b.check_in::text                    AS check_in,
  b.check_out::text                   AS check_out,
  COALESCE(
    (SELECT STRING_AGG(DISTINCT bb.room_code, ', ' ORDER BY bb.room_code)
     FROM booking_beds bb
     WHERE bb.booking_id = b.id AND bb.room_code IS NOT NULL),
    NULLIF(b.primary_room_code, '')
  ) AS room_label
FROM booking_service_records sr
INNER JOIN clients c ON c.slug = sr.client_slug
INNER JOIN bookings b ON b.id = sr.booking_id AND b.client_id = c.id
WHERE sr.client_slug = $1
  AND sr.source = 'luna_guest'
  AND sr.status = 'requested'
  AND sr.metadata->>'pending_origin' = 'luna_guest_pending'
  AND COALESCE((sr.metadata->>'needs_scheduling')::boolean, false) = true
  AND sr.service_date IS NULL
  ${typeFilter}
ORDER BY sr.created_at ASC, b.check_in ASC NULLS LAST, sr.booking_code ASC
LIMIT 50
`;
}

function getPendingManualServicesQuery() {
  return buildPendingManualServicesQuery(null);
}

function getPendingManualYogaQuery() {
  return buildPendingManualServicesQuery('yoga');
}

function getPendingManualMealsQuery() {
  return buildPendingManualServicesQuery('meal');
}

function detectPendingManualCategory(q) {
  const yoga = /\b(yoga)\b/.test(q);
  const meals = /\b(meals?|dinners?|food)\b/.test(q);
  if (yoga && !meals) return 'yoga';
  if (meals && !yoga) return 'meals';
  return 'all';
}

function matchesPendingManualServicesQuestion(q) {
  if (/\b(pending\s+(manual\s+)?services?|manual\s+services?\s+(need|needs|pending))\b/.test(q)) return true;
  if (/\b(services?\s+(need|needs)\s+(staff\s+)?follow[\-\s]?up)\b/.test(q)) return true;
  if (/\bwhat\s+services?\s+need\s+staff\s+follow[\-\s]?up\b/.test(q)) return true;
  if (/\bshow\s+pending\s+(manual\s+)?services?\b/.test(q)) return true;
  if (/\b(any|who)\s+pending\s+(yoga|meals?|dinners?)\b/.test(q)) return true;
  if (/\bwho\s+(asked\s+for|needs?|requested)\s+(yoga|meals?|dinners?)\b/.test(q)) return true;
  if (/\b(yoga|meals?|dinners?)\s+(requests?\s+)?pending\b/.test(q)) return true;
  if (/\bneeds?\s+(yoga|meals?)\s+schedul/.test(q)) return true;
  return false;
}

function intentKeyForCategory(category) {
  if (category === 'yoga') return PENDING_YOGA_KEY;
  if (category === 'meals') return PENDING_MEALS_KEY;
  return PENDING_MANUAL_KEY;
}

/**
 * @returns {{ intentKey: string, extraParams: object } | null}
 */
function resolveAskLunaPendingManualServicesIntentKey(question, registryByKey) {
  const raw = String(question || '').trim().toLowerCase();
  if (registryByKey && registryByKey.has(raw) && PENDING_MANUAL_KEYS.has(raw)) {
    const category = raw.includes('yoga') ? 'yoga' : (raw.includes('meal') ? 'meals' : 'all');
    return { intentKey: raw, extraParams: { pendingCategory: category } };
  }

  const q = normalizePendingManualQuestionText(question);
  if (!matchesPendingManualServicesQuestion(q)) return null;

  const category = detectPendingManualCategory(q);
  return {
    intentKey: intentKeyForCategory(category),
    extraParams: { pendingCategory: category },
  };
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

function formatPendingManualServiceRow(row) {
  const name = row.guest_name || row.booking_code || 'Guest';
  const stay = formatStayRange(row.check_in, row.check_out);
  const room = row.room_label ? ` — room ${row.room_label}` : '';
  const line = formatPendingManualServiceStaffLine(row);
  const when = row.requested_at ? ` (requested ${formatShortDate(row.requested_at)})` : '';
  return `* ${name} — ${row.booking_code} — ${stay}${room}: ${line}${when}`;
}

function formatAskLunaPendingManualServicesAnswer(intentKey, rows, ctx = {}) {
  const list = rows || [];
  const category = ctx.pendingCategory
    || (intentKey === PENDING_YOGA_KEY ? 'yoga'
      : intentKey === PENDING_MEALS_KEY ? 'meals' : 'all');

  if (list.length === 0) {
    if (category === 'yoga') return 'No pending yoga requests need scheduling right now. ✅';
    if (category === 'meals') return 'No pending meals requests need staff follow-up right now. ✅';
    return 'No pending manual service requests need staff follow-up right now. ✅';
  }

  const title = category === 'yoga'
    ? `Pending yoga requests (${list.length}):`
    : category === 'meals'
      ? `Pending meals requests (${list.length}):`
      : `Pending manual service requests (${list.length}):`;

  const lines = [title, ''];
  for (const row of list.slice(0, 10)) {
    lines.push(formatPendingManualServiceRow(row));
  }
  if (list.length > 10) {
    lines.push('');
    lines.push(`(+${list.length - 10} more)`);
  }
  lines.push('');
  lines.push('These are Luna guest requests — still need staff scheduling (no date/time set yet).');
  return lines.join('\n');
}

module.exports = {
  PENDING_MANUAL_KEY,
  PENDING_YOGA_KEY,
  PENDING_MEALS_KEY,
  getPendingManualServicesQuery,
  getPendingManualYogaQuery,
  getPendingManualMealsQuery,
  resolveAskLunaPendingManualServicesIntentKey,
  formatAskLunaPendingManualServicesAnswer,
  formatPendingManualServiceRow,
};
