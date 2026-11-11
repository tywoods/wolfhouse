'use strict';

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function paymentLedgerRowBookingGuestId(pr, md) {
  if (pr && pr.booking_guest_id) return String(pr.booking_guest_id);
  md = md || parseMetadata(pr && pr.metadata);
  if (md && md.booking_guest_id) return String(md.booking_guest_id);
  return null;
}

const PER_GUEST_LINK_SOURCES = new Set([
  'bot_guest_payment_link_slice_a',
  'bot_guest_payment_slice_a',
]);

function paymentLedgerIsPerGuestLinkRow(pr, md) {
  if (paymentLedgerRowBookingGuestId(pr, md)) return true;
  md = md || parseMetadata(pr && pr.metadata);
  const source = String((md && md.source) || '').toLowerCase();
  return PER_GUEST_LINK_SOURCES.has(source);
}

function guestSubtotalFromMetadata(raw) {
  const meta = parseMetadata(raw);
  const n = Number(meta.subtotal_cents);
  return n > 0 ? n : null;
}

function positiveCents(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function guestDepositCents(g) {
  if (!g) return null;
  if (g.deposit_amount_cents != null) return Number(g.deposit_amount_cents);
  if (g.deposit_cents != null) return Number(g.deposit_cents);
  return null;
}

function guestSubtotalCents(g) {
  if (!g) return null;
  if (g.subtotal_cents != null) return Number(g.subtotal_cents);
  return guestSubtotalFromMetadata(g.metadata || g.guest_metadata);
}

function overlayAmount(preferred, fallback) {
  const live = positiveCents(preferred);
  if (live != null) return live;
  const other = positiveCents(fallback);
  if (other != null) return other;
  if (preferred != null && Number.isFinite(Number(preferred))) return Number(preferred);
  if (fallback != null && Number.isFinite(Number(fallback))) return Number(fallback);
  return null;
}

function buildGuestPaymentAmountsMap(bookingGuests, perPerson) {
  const map = {};
  function take(g) {
    if (!g) return;
    const id = g.booking_guest_id;
    if (!id) return;
    const key = String(id);
    const prev = map[key] || {};
    map[key] = {
      deposit_cents: overlayAmount(guestDepositCents(g), prev.deposit_cents),
      subtotal_cents: overlayAmount(guestSubtotalCents(g), prev.subtotal_cents),
      amount_paid_cents: overlayAmount(g.amount_paid_cents, prev.amount_paid_cents) || 0,
    };
  }
  for (const g of perPerson || []) take(g);
  for (const g of bookingGuests || []) take(g);
  return map;
}

function overlayPerPersonFromGuests(perPerson, bookingGuests) {
  const guests = Array.isArray(bookingGuests) ? bookingGuests : [];
  const byNum = {};
  for (const g of guests) {
    if (!g || g.guest_number == null) continue;
    byNum[Number(g.guest_number)] = g;
  }
  const src = Array.isArray(perPerson) && perPerson.length
    ? perPerson
    : guests.map((g) => ({
      guest_number: g.guest_number,
      booking_guest_id: g.booking_guest_id,
      deposit_cents: guestDepositCents(g),
      amount_paid_cents: Number(g.amount_paid_cents || 0),
      payment_status: g.payment_status || 'not_requested',
      subtotal_cents: guestSubtotalCents(g),
    }));
  return src.map((row) => {
    const g = byNum[Number(row && row.guest_number)];
    if (!g) return row;
    return Object.assign({}, row, {
      booking_guest_id: row.booking_guest_id || g.booking_guest_id || null,
      deposit_cents: overlayAmount(guestDepositCents(g), row.deposit_cents),
      amount_paid_cents: overlayAmount(g.amount_paid_cents, row.amount_paid_cents) || 0,
      payment_status: g.payment_status || row.payment_status,
    });
  });
}

function paymentGuestLinkIntendedAmountCents(pr, ledgerCtx, md) {
  md = md || parseMetadata(pr && pr.metadata);
  const paymentTarget = String((md && md.payment_target) || 'deposit').toLowerCase();
  const kind = String((pr && pr.payment_kind) || '').toLowerCase();

  let depositCents = pr && pr.guest_deposit_amount_cents != null
    ? Number(pr.guest_deposit_amount_cents) : null;
  let subtotalCents = pr && pr.guest_subtotal_cents != null
    ? Number(pr.guest_subtotal_cents) : null;
  let receivedCents = pr && pr.guest_amount_paid_cents != null
    ? Number(pr.guest_amount_paid_cents) : 0;
  if (subtotalCents == null && pr && pr.guest_metadata != null) {
    subtotalCents = guestSubtotalFromMetadata(pr.guest_metadata);
  }

  const guestId = paymentLedgerRowBookingGuestId(pr, md);
  const guestMap = ledgerCtx && ledgerCtx.guest_amounts_by_id;
  if (guestId && guestMap && guestMap[guestId]) {
    if (depositCents == null) depositCents = guestMap[guestId].deposit_cents;
    if (subtotalCents == null) subtotalCents = guestMap[guestId].subtotal_cents;
    receivedCents = Number(guestMap[guestId].amount_paid_cents || 0);
  }

  if (kind === 'deposit_only' || kind === 'deposit' || paymentTarget === 'deposit') {
    // A configured deposit can exceed a discounted guest share. Both values
    // are required so unknown money does not become zero or an over-collection.
    return depositCents == null || subtotalCents == null ? null
      : Math.max(0, Math.min(depositCents, subtotalCents) - receivedCents);
  }
  if (paymentTarget === 'remaining_share') {
    return subtotalCents == null ? null : Math.max(0, subtotalCents - receivedCents);
  }
  if (kind === 'full_amount' || paymentTarget === 'full_share') {
    if (subtotalCents != null && subtotalCents > 0) return subtotalCents;
    return depositCents;
  }
  return null;
}

function paymentLinkIntendedAmountCents(pr, ledgerCtx) {
  if (!pr) return null;
  const md = parseMetadata(pr.metadata);
  ledgerCtx = ledgerCtx || {};
  const kind = String(pr.payment_kind || '').toLowerCase();

  if (paymentLedgerIsPerGuestLinkRow(pr, md)) {
    const guestIntended = paymentGuestLinkIntendedAmountCents(pr, ledgerCtx, md);
    // Zero is authoritative (fully paid); only null means unavailable.
    if (guestIntended != null) return guestIntended;
    if (pr.amount_due_cents != null) return Number(pr.amount_due_cents);
    return null;
  }

  if (kind === 'deposit_only' || kind === 'deposit') {
    return ledgerCtx.deposit_required_cents != null ? Number(ledgerCtx.deposit_required_cents) : null;
  }
  if (kind === 'addon_service') return null;
  if (kind === 'full_amount') {
    return ledgerCtx.balance_due_cents != null ? Number(ledgerCtx.balance_due_cents) : null;
  }
  return ledgerCtx.balance_due_cents != null ? Number(ledgerCtx.balance_due_cents) : null;
}

function paymentLedgerIsStaleUnpaidLinkRow(pr, isActiveUnpaid, ledgerCtx) {
  if (!isActiveUnpaid(pr)) return false;
  const md = parseMetadata(pr && pr.metadata);
  if (md.superseded === true || md.superseded_by_payment_id || md.superseded_at) return true;
  if (pr.expires_at) {
    const expiresAt = Date.parse(pr.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return true;
  }
  const intended = paymentLinkIntendedAmountCents(pr, ledgerCtx);
  if (intended == null) return false;
  if (intended === 0) return Number(pr.amount_due_cents) !== 0;
  return Number(pr.amount_due_cents) !== Number(intended);
}

module.exports = {
  parseMetadata,
  buildGuestPaymentAmountsMap,
  overlayPerPersonFromGuests,
  paymentLedgerRowBookingGuestId,
  paymentLedgerIsPerGuestLinkRow,
  paymentGuestLinkIntendedAmountCents,
  paymentLinkIntendedAmountCents,
  paymentLedgerIsStaleUnpaidLinkRow,
};
