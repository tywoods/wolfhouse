'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');

process.env.NODE_ENV = 'test';
process.env.STAFF_UI_BUILDER_TEST_SEAM = '1';
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';

const { buildUiHtmlForOfflineTest } = require('./staff-query-api');
assert.equal(typeof buildUiHtmlForOfflineTest, 'function', 'production UI builder seam is exposed');
const html = buildUiHtmlForOfflineTest(0, 'sunset');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `generated browser helper missing: ${name}`);
  let depth = 0;
  let brace = html.indexOf('{', start);
  for (let i = brace; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated generated browser helper: ${name}`);
}

const names = [
  'pgPayParseMetadata',
  'pgPayRowBookingGuestId',
  'pgPayIsPerGuestLinkRow',
  'pgPayGuestSubtotalFromMetadata',
  'buildGuestPaymentAmountsMap',
  'pgPayGuestLinkIntendedAmountCents',
  'paymentLinkIntendedAmountCents',
  'paymentLedgerIsStaleUnpaidLinkRowCore',
];
const sandbox = { PG_PAY_PER_GUEST_LINK_SOURCES: { bot_guest_payment_link_slice_a: true, bot_guest_payment_slice_a: true } };
vm.createContext(sandbox);
vm.runInContext(names.map(extractFunction).join('\n'), sandbox);

const guestId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const active = () => true;
function context({ subtotal = 32500, deposit = 10000, paid = 0 } = {}) {
  return { guest_amounts_by_id: sandbox.buildGuestPaymentAmountsMap([{
    booking_guest_id: guestId,
    subtotal_cents: subtotal,
    deposit_amount_cents: deposit,
    amount_paid_cents: paid,
  }]) };
}
function guestLink(target, amount, kind = target === 'deposit' ? 'deposit_only' : 'full_amount') {
  return { booking_guest_id: guestId, payment_kind: kind, amount_due_cents: amount,
    metadata: { booking_guest_id: guestId, payment_target: target } };
}

assert.equal(sandbox.paymentLinkIntendedAmountCents(guestLink('deposit', 10000), context()), 10000, 'unpaid deposit');
assert.equal(sandbox.paymentLinkIntendedAmountCents(guestLink('deposit', 6000), context({ paid: 4000 })), 6000, 'partial deposit');
assert.equal(sandbox.paymentLinkIntendedAmountCents(guestLink('remaining_share', 22500), context({ paid: 10000 })), 22500, 'remaining share');
assert.equal(sandbox.paymentLinkIntendedAmountCents(guestLink('deposit', 4000), context({ subtotal: 5000, deposit: 10000, paid: 1000 })), 4000, 'deposit capped by share');

const paidLink = guestLink('remaining_share', 22500);
assert.equal(sandbox.paymentLinkIntendedAmountCents(paidLink, context({ paid: 32500 })), 0, 'fully paid zero is authoritative');
assert.equal(sandbox.paymentLedgerIsStaleUnpaidLinkRowCore(paidLink, active, context({ paid: 32500 })), true, 'fully paid active checkout is stale/noncollectible');
assert.equal(sandbox.paymentLedgerIsStaleUnpaidLinkRowCore(guestLink('remaining_share', 0), active, context({ paid: 32500 })), true, 'authoritative zero always retires an active checkout');

const unknown = guestLink('deposit', 7777);
assert.equal(sandbox.paymentLinkIntendedAmountCents(unknown, { guest_amounts_by_id: {
  [guestId]: { deposit_cents: null, subtotal_cents: null, amount_paid_cents: 0 },
} }), 7777, 'unknown guest money may fall back to recorded checkout amount');
assert.equal(sandbox.paymentLedgerIsStaleUnpaidLinkRowCore(unknown, active, { guest_amounts_by_id: {
  [guestId]: { deposit_cents: null, subtotal_cents: null, amount_paid_cents: 0 },
} }), false, 'unknown guest money does not manufacture staleness');

for (const fixture of [
  [{ payment_kind: 'full_amount', amount_due_cents: 45000 }, { balance_due_cents: 45000 }, false],
  [{ payment_kind: 'full_amount', amount_due_cents: 45000 }, { balance_due_cents: 30000 }, true],
  [{ payment_kind: 'deposit_only', amount_due_cents: 10000 }, { deposit_required_cents: 10000 }, false],
  [{ payment_kind: 'deposit_only', amount_due_cents: 10000 }, { deposit_required_cents: 8000 }, true],
]) {
  assert.equal(sandbox.paymentLedgerIsStaleUnpaidLinkRowCore(fixture[0], active, fixture[1]), fixture[2], 'booking Balance-due behavior unchanged');
}

console.log('PASS generated browser per-guest stale-link helpers (8 money/stale cases + 4 booking controls)');
