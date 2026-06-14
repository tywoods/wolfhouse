'use strict';

/**
 * Stage 54 — Merge live staging outcomes into luna_guest_context and persist to conversations.
 */

const { normalizeGuestContextForChain } = require('./luna-guest-context-merge');
const { attachActiveThreadToGuestContext } = require('./luna-guest-thread-state');

function trimStr(v) {
  return v == null ? '' : String(v).trim();
}

function parseMetadata(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return { ...raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Fold hold / Stripe / payment-link / confirmation outcomes into slim guest_context.
 */
function mergeLiveStagingGuestContext(priorCtx, live) {
  const src = live || {};
  const out = { ...(priorCtx || {}) };

  const bw = src.bookingWrite || {};
  if (bw.booking_code) out.booking_code = trimStr(bw.booking_code);
  if (bw.booking_id) out.booking_id = trimStr(bw.booking_id);
  if (bw.write_status === 'created' || bw.write_status === 'reused_existing') {
    out.hold_created = true;
  }

  const stripe = src.stripeLink || {};
  if (stripe.stripe_link_created === true || stripe.stripe_link_reused === true) {
    out.stripe_link_created = true;
    out.payment_link_sent = true;
  }

  const plSend = src.paymentLinkSend || {};
  if (plSend.payment_link_sent === true) out.payment_link_sent = true;

  const cs = src.confirmationSend || {};
  if (cs.confirmation_sent === true) out.confirmation_sent = true;

  const pt = src.paymentTruth || {};
  const payStatus = trimStr(pt.payment_status).toLowerCase();
  if (payStatus) {
    out.payment_truth = {
      payment_status: payStatus,
      booking_code: out.booking_code || pt.booking_code || null,
      booking_id: out.booking_id || pt.booking_id || null,
      source: pt.source || 'live_staging',
    };
    if (payStatus === 'deposit_paid' || payStatus === 'paid' || payStatus === 'fully_paid') {
      out.payment_received = true;
    }
  }

  if (src.proposedReply && /\/pay\/WH-G27-/i.test(String(src.proposedReply))) {
    out.payment_link_sent = true;
  }

  if (out.payment_link_sent === true) {
    out.payment_choice_needed = false;
    if (out.quote && typeof out.quote === 'object') {
      out.quote = { ...out.quote, payment_choice_needed: false };
    }
  }

  return attachActiveThreadToGuestContext(normalizeGuestContextForChain(out));
}

async function persistConversationGuestContext(pg, conversationId, guestContext) {
  if (!pg || !conversationId) return { persisted: false, reason: 'missing_pg_or_conversation' };
  const slim = normalizeGuestContextForChain(guestContext || {});
  const row = await pg.query(
    `SELECT metadata FROM conversations WHERE id = $1::uuid LIMIT 1`,
    [conversationId],
  );
  if (!row.rows[0]) return { persisted: false, reason: 'conversation_not_found' };
  const meta = parseMetadata(row.rows[0].metadata);
  const nextMeta = {
    ...meta,
    luna_guest_context: slim,
    luna_guest_context_updated_at: new Date().toISOString(),
  };
  await pg.query(
    `UPDATE conversations SET metadata = $2::jsonb, updated_at = NOW() WHERE id = $1::uuid`,
    [conversationId, JSON.stringify(nextMeta)],
  );
  return { persisted: true, conversation_id: conversationId };
}

module.exports = {
  mergeLiveStagingGuestContext,
  persistConversationGuestContext,
};
