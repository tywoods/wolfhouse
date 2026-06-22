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

function buildGuestPaymentAmountsMap(bookingGuests, perPerson) {
  const map = {};
  const rows = (perPerson && perPerson.length) ? perPerson : (bookingGuests || []);
  for (const g of rows) {
    const id = g.booking_guest_id;
    if (!id) continue;
    map[String(id)] = {
      deposit_cents: g.deposit_amount_cents != null ? Number(g.deposit_amount_cents)
        : (g.deposit_cents != null ? Number(g.deposit_cents) : null),
      subtotal_cents: g.subtotal_cents != null ? Number(g.subtotal_cents)
        : guestSubtotalFromMetadata(g.metadata || g.guest_metadata),
    };
  }
  return map;
}

function paymentGuestLinkIntendedAmountCents(pr, ledgerCtx, md) {
  md = md || parseMetadata(pr && pr.metadata);
  const paymentTarget = String((md && md.payment_target) || 'deposit').toLowerCase();
  const kind = String((pr && pr.payment_kind) || '').toLowerCase();

  let depositCents = pr && pr.guest_deposit_amount_cents != null
    ? Number(pr.guest_deposit_amount_cents) : null;
  let subtotalCents = pr && pr.guest_subtotal_cents != null
    ? Number(pr.guest_subtotal_cents) : null;
  if (subtotalCents == null && pr && pr.guest_metadata != null) {
    subtotalCents = guestSubtotalFromMetadata(pr.guest_metadata);
  }

  const guestId = paymentLedgerRowBookingGuestId(pr, md);
  const guestMap = ledgerCtx && ledgerCtx.guest_amounts_by_id;
  if (guestId && guestMap && guestMap[guestId]) {
    if (depositCents == null) depositCents = guestMap[guestId].deposit_cents;
    if (subtotalCents == null) subtotalCents = guestMap[guestId].subtotal_cents;
  }

  if (kind === 'deposit_only' || kind === 'deposit' || paymentTarget === 'deposit') {
    return depositCents;
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
    if (guestIntended != null && guestIntended > 0) return guestIntended;
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
  const intended = paymentLinkIntendedAmountCents(pr, ledgerCtx);
  if (intended == null || intended <= 0) return false;
  return Number(pr.amount_due_cents) !== Number(intended);
}

module.exports = {
  parseMetadata,
  buildGuestPaymentAmountsMap,
  paymentLedgerRowBookingGuestId,
  paymentLedgerIsPerGuestLinkRow,
  paymentGuestLinkIntendedAmountCents,
  paymentLinkIntendedAmountCents,
  paymentLedgerIsStaleUnpaidLinkRow,
};
