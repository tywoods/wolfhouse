'use strict';

/**
 * Sunset Luna booking-truth policy (Hernan contradiction).
 *
 * Staff API create/list results are authoritative. Conversational memory must
 * never deny a successful create or a list that returned rows. If list truth is
 * unclear, ask — do not contradict. take_request "nothing is booked yet" is
 * allowed only when no create/list rows exist.
 *
 * Pure. No DB, no HTTP, no send.
 */

const DENY_RE = /nothing is booked|nothing'?s booked|no booking yet|no bookings?(?:\s+yet)?(?:\s+(?:on|for)\s+you)?|nada est[aá] reservad|no hay reserva|no tienes reserva|todav[ií]a no (?:hay|tiene) reserva/i;

function toolName(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.tool || row.name || '').trim();
}

function toolSuccess(row) {
  return !!(row && row.success === true);
}

function listCount(row) {
  if (!row || typeof row !== 'object') return 0;
  if (row.count != null && Number.isFinite(Number(row.count))) return Number(row.count);
  return Array.isArray(row.bookings) ? row.bookings.length : 0;
}

function authoritativeSunsetBookingsExist(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  for (const row of list) {
    if (toolName(row) === 'create_sunset_booking' && toolSuccess(row)) return true;
    if (toolName(row) === 'list_sunset_bookings' && toolSuccess(row) && listCount(row) > 0) {
      return true;
    }
  }
  return false;
}

function listTruthUnclear(toolResults) {
  const list = Array.isArray(toolResults) ? toolResults : [];
  const calls = list.filter((row) => toolName(row) === 'list_sunset_bookings');
  if (!calls.length) return false;
  return calls.some((row) => row.success !== true);
}

function replyDeniesBookings(replyText) {
  return DENY_RE.test(String(replyText || ''));
}

/**
 * @param {{ toolResults?: object[], replyText?: string }} input
 * @returns {{ ok: boolean, reason: string }}
 */
function evaluateSunsetBookingTruthClaim(input) {
  const toolResults = input && input.toolResults;
  const replyText = input && input.replyText;
  if (!replyDeniesBookings(replyText)) {
    return { ok: true, reason: 'no_denial' };
  }
  if (authoritativeSunsetBookingsExist(toolResults)) {
    return { ok: false, reason: 'deny_after_authoritative_bookings' };
  }
  if (listTruthUnclear(toolResults)) {
    return { ok: false, reason: 'deny_while_list_unclear' };
  }
  return { ok: true, reason: 'denial_without_authoritative_bookings' };
}

module.exports = {
  DENY_RE,
  authoritativeSunsetBookingsExist,
  listTruthUnclear,
  replyDeniesBookings,
  evaluateSunsetBookingTruthClaim,
};
