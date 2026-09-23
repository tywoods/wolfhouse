'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { handleBotBookingCreateFromPlan } = require('./lib/staff-bot-v2-routes');
const { applyStripeBookingPaymentTruthWrites } = require('./lib/stripe-hold-promote-policy');
const staleLinks = require('./lib/payment-ledger-stale-links');

const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start >= 0, `${name} exists`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const sandbox = {
  EDIT_PREVIEW_ACCOMM_LINE_CODES: Object.freeze({
    package: true, package_proration: true, room_supplement: true,
    accommodation_only: true, manual_accommodation: true,
    guest_package: true, guest_package_proration: true, guest_accommodation_only: true,
  }),
  PAYMENT_LEDGER_CANCELLABLE_LINK_STATUSES: new Set(['checkout_created', 'draft', 'pending']),
  paymentLedgerIsPerGuestLinkRow: staleLinks.paymentLedgerIsPerGuestLinkRow,
  paymentLedgerIsStaleUnpaidLinkRowCore: staleLinks.paymentLedgerIsStaleUnpaidLinkRow,
};
vm.createContext(sandbox);
vm.runInContext([
  extractFunction(apiSrc, 'bookingLedgerParseMetadata'),
  extractFunction(apiSrc, 'bookingLedgerAccommodationCents'),
  extractFunction(apiSrc, 'bookingLedgerInvoicePaidBalance'),
  extractFunction(apiSrc, 'paymentLedgerNormalizeCtx'),
  extractFunction(apiSrc, 'paymentLedgerParseMetadata'),
  extractFunction(apiSrc, 'paymentLedgerIsCancelledLinkStatus'),
  extractFunction(apiSrc, 'paymentLedgerRowHasLinkUrl'),
  extractFunction(apiSrc, 'paymentLedgerIsActiveUnpaidLinkRow'),
  extractFunction(apiSrc, 'paymentLedgerIsStaleUnpaidLinkRow'),
  extractFunction(apiSrc, 'ledgerActivePaymentLinkRow'),
].join('\n'), sandbox);

function assertMoneyTruth() {
  const booking = {
    total_amount_cents: 97500,
    deposit_required_cents: 32500,
    metadata: { quote_snapshot: { line_items: [{ code: 'guest_package', total_cents: 0 }] } },
  };
  const zeroSnapshot = sandbox.bookingLedgerInvoicePaidBalance(booking, 30000, 32500, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(zeroSnapshot)), {
    invoice_total_cents: 97500, paid_total_cents: 32500, balance_due_cents: 65000,
    deposit_required_cents: 32500, needs_refund: false,
  });
  const bundled = sandbox.bookingLedgerInvoicePaidBalance({
    ...booking,
    metadata: { quote_snapshot: { line_items: [{ code: 'guest_package', total_cents: 97500 }] } },
  }, 30000, 32500, 0);
  assert.equal(bundled.invoice_total_cents, 97500, '€300 bundled rental appears once');
  assert.equal(bundled.balance_due_cents, 65000);
}

function makeResponseCapture() {
  const capture = { status: null, payload: null };
  return {
    capture,
    response: { setHeader() {}, writeHead(status) { capture.status = status; }, end(raw) { capture.payload = JSON.parse(raw); } },
    sendJSON(res, status, payload) { capture.status = status; capture.payload = payload; return payload; },
  };
}

async function assertNamesDoNotImplySplit() {
  async function run(paymentChoice) {
    const out = makeResponseCapture();
    let guestLinkCalls = 0;
    const body = {
      client_slug: 'sunset', payment_choice: paymentChoice,
      guests: [{ name: 'Gina' }, { name: 'Jamie' }, { name: 'Tina' }],
    };
    await handleBotBookingCreateFromPlan({}, out.response, { staff_user_id: 'test' }, 'bot', {
      sendJSON: out.sendJSON, send400: out.sendJSON,
      readBody: async () => JSON.stringify(body),
      DEFAULT_CLIENT: 'sunset', STAFF_AUTH_REQUIRED: true, BOT_BOOKING_ENABLED: true,
      STRIPE_LINKS_ENABLED: true, STRIPE_SECRET_KEY: 'sk_test_fixture',
      handleBotBookingCreate: async (_req, res) => res.end(JSON.stringify({
        success: true, created: true, booking_id: 'booking-1', booking_code: 'GINA-1',
        uses_per_guest_model: true,
        booking_guests: [1, 2, 3].map((n) => ({ booking_guest_id: `guest-${n}`, guest_number: n })),
      })),
      handleBotGuestPaymentCreateLink: async (_id, _req, res) => {
        guestLinkCalls += 1;
        res.end(JSON.stringify({ success: true, booking_guest_id: _id, checkout_url: `https://example.test/${_id}` }));
      },
    });
    return { calls: guestLinkCalls, payload: out.capture.payload };
  }
  assert.equal((await run('full')).calls, 0, 'three names + full creates one group path, not guest links');
  assert.equal((await run('deposit')).calls, 0, 'three names + deposit does not imply split');
  const split = await run('split');
  assert.equal(split.calls, 3, 'explicit split creates individual links');
  assert.equal(split.payload.per_guest_payment_links_created, 3);
}

function assertActiveGroupLinkSelection() {
  const ctx = { balance_due_cents: 65000, deposit_required_cents: 32500 };
  const rows = [
    { payment_id: 'guest-new', payment_status: 'checkout_created', amount_due_cents: 65000,
      amount_paid_cents: 0, checkout_url: 'guest', metadata: { source: 'bot_guest_payment_slice_a' } },
    { payment_id: 'superseded', payment_status: 'checkout_created', amount_due_cents: 65000,
      amount_paid_cents: 0, checkout_url: 'superseded', metadata: { superseded: true } },
    { payment_id: 'oversized', payment_status: 'checkout_created', amount_due_cents: 97500,
      amount_paid_cents: 0, checkout_url: 'oversized' },
    { payment_id: 'expired', payment_status: 'checkout_created', amount_due_cents: 65000,
      amount_paid_cents: 0, checkout_url: 'expired', expires_at: '2020-01-01T00:00:00Z' },
    { payment_id: 'group-valid', payment_status: 'checkout_created', amount_due_cents: 65000,
      amount_paid_cents: 0, checkout_url: 'group-valid' },
  ];
  const selected = sandbox.ledgerActivePaymentLinkRow(rows, ctx);
  assert.equal(selected.payment_id, 'group-valid');
}

function makeDuplicateWebhookPg() {
  const state = { guestPaid: 0, paymentUpdates: 0, bookingUpdates: 0 };
  return {
    state,
    async query(sql, params = []) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      if (flat.includes('FROM bookings') && flat.endsWith('FOR UPDATE')) return { rows: [{
        booking_id: 'booking-1', booking_status: 'confirmed', hold_expires_at: null,
        hold_expired_by_db: false, bk_total: 97500, bk_amount_paid: 32500,
        bk_balance: 65000, bk_deposit: 32500,
      }] };
      if (flat.includes('FROM payments') && flat.endsWith('FOR UPDATE')) return { rows: [{
        payment_id: 'payment-1', booking_id: 'booking-1', client_id: 'client-1',
        booking_guest_id: 'tina-1', payment_status: 'paid', payment_kind: 'deposit_only',
        amount_due_cents: 32500, amount_paid_cents: 32500, currency: 'EUR',
        stripe_checkout_session_id: 'cs_tina',
      }] };
      if (flat.startsWith('UPDATE booking_guests')) {
        state.guestPaid = Math.max(state.guestPaid, Number(params[0]));
        return { rowCount: 1, rows: [] };
      }
      if (flat.startsWith('UPDATE payments')) { state.paymentUpdates += 1; return { rowCount: 1, rows: [] }; }
      if (flat.startsWith('UPDATE bookings')) { state.bookingUpdates += 1; return { rowCount: 1, rows: [] }; }
      throw new Error(`unexpected duplicate-webhook SQL: ${flat}`);
    },
  };
}

async function assertDuplicateWebhookRepairsProjectionOnly() {
  const pg = makeDuplicateWebhookPg();
  const input = {
    pm: { payment_id: 'payment-1', booking_id: 'booking-1', client_id: 'client-1', client_slug: 'sunset' },
    session: { id: 'cs_tina', amount_total: 32500, currency: 'eur', metadata: { payment_id: 'payment-1' } },
    stripePaidCents: 32500,
    env: { NODE_ENV: 'staging', LUNA_DEPLOYMENT: 'sunset-staging', DEFAULT_CLIENT_SLUG: 'sunset' },
  };
  const first = await applyStripeBookingPaymentTruthWrites(pg, input);
  const second = await applyStripeBookingPaymentTruthWrites(pg, input);
  assert.equal(first.idempotent, true);
  assert.equal(second.idempotent, true);
  assert.equal(pg.state.guestPaid, 32500, 'Tina projection is repaired to €325');
  assert.equal(pg.state.paymentUpdates, 0, 'duplicate webhook never rewrites payment truth');
  assert.equal(pg.state.bookingUpdates, 0, 'duplicate webhook never adds to booking paid total');
}

(async () => {
  assertMoneyTruth();
  await assertNamesDoNotImplySplit();
  assertActiveGroupLinkSelection();
  await assertDuplicateWebhookRepairsProjectionOnly();
  console.log('verify-gina-booking-payment-001: behavioral payment repair checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
