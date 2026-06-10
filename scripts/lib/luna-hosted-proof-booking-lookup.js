'use strict';

/**
 * Stage 33 — hosted proof helpers for idempotent hold reuse and late payment-link sends.
 */

function trimStr(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseTime(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function rowActivityTime(row) {
  if (!row) return null;
  return parseTime(row.updated_at) || parseTime(row.created_at);
}

/**
 * Filter booking rows matched by created_at OR updated_at since proof start.
 */
function filterBookingsSince(bookings, sinceIso) {
  const since = parseTime(sinceIso);
  if (since == null) return bookings || [];
  return (bookings || []).filter((row) => {
    const created = parseTime(row.created_at);
    const updated = parseTime(row.updated_at);
    return (created != null && created >= since) || (updated != null && updated >= since);
  });
}

/**
 * Pick the best booking candidate for a proof run.
 */
function pickProofBookingCandidate(bookings, opts) {
  const o = opts || {};
  const filtered = filterBookingsSince(bookings, o.sinceIso);
  const pool = filtered.length ? filtered : (bookings || []);
  const checkIn = trimStr(o.checkIn);
  const checkOut = trimStr(o.checkOut);
  const conversationId = trimStr(o.conversationId);
  const paymentDraftId = trimStr(o.paymentDraftId);

  let candidates = pool.slice();
  if (checkIn) {
    candidates = candidates.filter((b) => trimStr(b.check_in) === checkIn);
  }
  if (checkOut) {
    candidates = candidates.filter((b) => trimStr(b.check_out) === checkOut);
  }
  if (conversationId) {
    const byConv = candidates.filter((b) => trimStr(b.conversation_id) === conversationId);
    if (byConv.length) candidates = byConv;
  }
  if (paymentDraftId) {
    const byDraft = candidates.filter((b) => trimStr(b.payment_draft_id) === paymentDraftId);
    if (byDraft.length) candidates = byDraft;
  }

  candidates.sort((a, b) => (rowActivityTime(b) || 0) - (rowActivityTime(a) || 0));
  return candidates[0] || null;
}

/**
 * Poll outbound send rows for a Stripe/payment link after deposit turn.
 *
 * @returns {{ send: object|null, late_send_observed: boolean, waited_ms: number }}
 */
async function pollForPaymentLinkSend(fetchSends, opts) {
  const o = opts || {};
  const sinceIso = o.sinceIso;
  const since = parseTime(sinceIso);
  const intervalMs = Math.max(250, Number(o.intervalMs) || 1000);
  const maxWaitMs = Math.max(intervalMs, Number(o.maxWaitMs) || 45000);
  const matcher = typeof o.matcher === 'function'
    ? o.matcher
    : (send) => /https:\/\/checkout\.stripe\.com|pay\.stripe\.com|payment link|secure payment/i.test(trimStr(send.message_text));

  const correlate = (sends) => {
    const rows = (sends || []).slice().sort((a, b) => (parseTime(a.created_at) || 0) - (parseTime(b.created_at) || 0));
    const filtered = since == null
      ? rows
      : rows.filter((s) => {
        const created = parseTime(s.created_at);
        const updated = parseTime(s.updated_at);
        return (created != null && created >= since) || (updated != null && updated >= since);
      });
    const bookingId = trimStr(o.bookingId);
    const paymentDraftId = trimStr(o.paymentDraftId);
    const conversationId = trimStr(o.conversationId);
    let pool = filtered.length ? filtered : rows;
    if (bookingId) {
      const byBooking = pool.filter((s) => trimStr(s.booking_id) === bookingId);
      if (byBooking.length) pool = byBooking;
    }
    if (paymentDraftId) {
      const byDraft = pool.filter((s) => trimStr(s.payment_draft_id) === paymentDraftId);
      if (byDraft.length) pool = byDraft;
    }
    if (conversationId) {
      const byConv = pool.filter((s) => trimStr(s.conversation_id) === conversationId);
      if (byConv.length) pool = byConv;
    }
    return pool.find(matcher) || null;
  };

  const started = Date.now();
  let firstWindowSend = null;
  const firstWindowMs = Math.min(maxWaitMs, Math.max(intervalMs, Number(o.firstWindowMs) || 12000));

  while (Date.now() - started <= maxWaitMs) {
    const sends = await fetchSends();
    const match = correlate(sends);
    const elapsed = Date.now() - started;
    if (match) {
      if (!firstWindowSend && elapsed > firstWindowMs) {
        return { send: match, late_send_observed: true, waited_ms: elapsed };
      }
      return { send: match, late_send_observed: false, waited_ms: elapsed };
    }
    if (elapsed >= maxWaitMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return { send: null, late_send_observed: false, waited_ms: Date.now() - started };
}

module.exports = {
  parseTime,
  rowActivityTime,
  filterBookingsSince,
  pickProofBookingCandidate,
  pollForPaymentLinkSend,
};
