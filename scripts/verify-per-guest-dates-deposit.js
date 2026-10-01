'use strict';

// PER-GUEST-DATES-001: offline amount-only proof. No DB, provider or payment writes.
// Execute actual backend functions and helpers extracted from production-emitted HTML.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { wolfhouseBookingDepositCents } = require('./lib/wolfhouse-stay-deposit');
const { bookingDepositLinkAmount } = require('./lib/booking-deposit-payment-link');

const root = path.resolve(__dirname, '..');
const evidence = process.env.DEPOSIT_EVIDENCE_DIR;
const out = evidence ? path.resolve(evidence) : fs.mkdtempSync(path.join(os.tmpdir(), 'per-guest-dates-deposit-'));
fs.mkdirSync(out, { recursive: true });
const emitted = path.join(out, 'wolfhouse-somo.html');
const emit = spawnSync(process.execPath, [path.join(__dirname, 'verify-inbox-ui-parity.js'), '--emit', 'wolfhouse-somo', emitted], {
  cwd: root, encoding: 'utf8', timeout: 60000,
  env: { ...process.env, NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1' },
});
assert.equal(emit.status, 0, emit.stderr || emit.stdout);
const html = fs.readFileSync(emitted, 'utf8');
function emittedFunction(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, name + ' present in production HTML');
  const end = html.indexOf('\n}', start);
  assert.notEqual(end, -1, name + ' closing brace');
  return html.slice(start, end + 2);
}
const browser = vm.createContext({
  // Only UI formatting/translation adapters are synthetic; deposit/night logic is emitted.
  escHtml: String, t: String, bcInvoiceText: String,
  bcBookingStatusIsCancelled: status => status === 'cancelled',
});
vm.runInContext([
  'bcStayNightsFromCheckInOut', 'bcWolfhouseStayDepositCents',
  'bcInvoiceTotalLinkActionHtml', 'bcInvoiceDepositRowHtml',
].map(emittedFunction).join('\n'), browser);
if (!evidence) fs.rmSync(out, { recursive: true, force: true });

const rates = { long_stay_cents: 25000, short_stay_cents: 12500, source: 'admin_pricing' };
function booking(overrides = {}) {
  return { booking_id: 'synthetic-booking', check_in: '2026-09-01', check_out: '2026-09-08',
    guest_count: 3, deposit_required_cents: 27000, stay_deposit_rates: rates,
    metadata: { quote_snapshot: { per_guest_dates: true } }, ...overrides };
}
const invalidStored = [undefined, null, '', ' ', false, true, [], {}, -1, '-1', 1.5, '1.5', NaN, Infinity, 'bad', Number.MAX_SAFE_INTEGER + 1];
const implementations = [
  ['backend', b => wolfhouseBookingDepositCents(b)],
  ['emitted browser', b => browser.bcWolfhouseStayDepositCents(b)],
];
for (const [name, required] of implementations) {
  test(name + ': marked historical KEEP beats long/short envelope and current Admin rates', () => {
    for (const check_out of ['2026-09-06', '2026-09-07', '2026-09-08']) {
      for (const stored of [27000, '27000', 0, '0', Number.MAX_SAFE_INTEGER]) {
        const b = booking({ check_out, deposit_required_cents: stored });
        assert.equal(required(b), Number(stored));
        assert.equal(required({ ...b, guest_count: 10, stay_deposit_rates: { long_stay_cents: 99999, short_stay_cents: 88888 } }), Number(stored));
      }
    }
    assert.equal(required(booking({ check_in: null, check_out: null, guest_count: null })), 27000);
  });
  test(name + ': invalid marked deposit is unknown, never envelope-recalculated', () => {
    for (const value of invalidStored) assert.equal(required(booking({ deposit_required_cents: value })), null, String(value));
  });
  test(name + ': only exact nested boolean marker changes ordinary Admin policy', () => {
    for (const metadata of [undefined, null, {}, { per_guest_dates: true }, { quote_snapshot: null },
      { quote_snapshot: { per_guest_dates: false } }, { quote_snapshot: { per_guest_dates: 'true' } },
      { quote_snapshot: { per_guest_dates: 1 } }]) {
      for (const stored of [0, 20000, 27000]) {
        assert.equal(required(booking({ metadata, deposit_required_cents: stored })), 75000);
        assert.equal(required(booking({ metadata, check_out: '2026-09-06', deposit_required_cents: stored })), 37500);
        assert.equal(required(booking({ metadata, check_out: '2026-09-07', deposit_required_cents: stored })), 75000);
      }
    }
    assert.equal(required(booking({ metadata: {}, stay_deposit_rates: undefined })), 60000);
    assert.equal(required(booking({ metadata: {}, stay_deposit_rates: undefined, check_out: '2026-09-06' })), 30000);
  });
}
test('backend: explicit Admin rates still apply only to ordinary bookings', () => {
  const current = { long_stay_cents: 31000, short_stay_cents: 14000 };
  assert.equal(wolfhouseBookingDepositCents(booking(), current), 27000);
  assert.equal(wolfhouseBookingDepositCents(booking({ metadata: {} }), current), 93000);
  assert.equal(wolfhouseBookingDepositCents({ deposit_required_cents: 20000 }), 20000);
  assert.equal(wolfhouseBookingDepositCents({ deposit_required_cents: 0 }), 0);
  assert.equal(wolfhouseBookingDepositCents({}), null);
});
test('emitted invoice row: KEEP amount, zero paid, invalid unknown without deposit action', () => {
  const row = b => browser.bcInvoiceDepositRowHtml(b, 0, 100000);
  assert.match(row(booking()), /€270\.00/);
  assert.match(row(booking()), /data-deposit-state="unpaid"/);
  assert.match(row(booking()), /data-payment-target="deposit"/);
  assert.match(row(booking({ deposit_required_cents: 0 })), /€0\.00/);
  assert.match(row(booking({ deposit_required_cents: 0 })), /data-deposit-state="paid"/);
  assert.doesNotMatch(row(booking({ deposit_required_cents: 0 })), /data-payment-target="deposit"/);
  for (const value of invalidStored) {
    const result = row(booking({ deposit_required_cents: value }));
    assert.match(result, /data-deposit-state="unknown"/, String(value));
    assert.doesNotMatch(result, /data-payment-target="deposit"/, String(value));
  }
  assert.match(row(booking({ metadata: {} })), /€750\.00/);
});

async function link(b, rows = [], invoiceTotal = 100000, target = 'deposit') {
  let reads = 0;
  const result = await bookingDepositLinkAmount(null, b, rows, {
    loadBookingPaymentLedger: async (pg, actual) => {
      assert.equal(pg, null); assert.equal(actual, b); reads++;
      return { invoice_total_cents: invoiceTotal };
    },
  }, target);
  return { result, reads };
}
const paid = cents => ({ payment_status: 'paid', amount_paid_cents: cents });
test('bookingDepositLinkAmount: KEEP less actual paid receipts; ignore cached paid and unpaid rows', async () => {
  const { result, reads } = await link(booking({ amount_paid_cents: 99999 }), [paid(5000),
    { payment_status: 'checkout_created', amount_paid_cents: 80000 }]);
  assert.deepEqual(result, { ok: true, amountDueCents: 22000 });
  assert.equal(reads, 1);
  assert.deepEqual((await link(booking({ check_out: '2026-09-06' }))).result, { ok: true, amountDueCents: 27000 });
});
test('bookingDepositLinkAmount: explicit zero and met historical deposit create no amount', async () => {
  for (const [stored, rows] of [[0, []], ['0', []], [27000, [paid(27000)]], [27000, [paid(30000)]]]) {
    const { result } = await link(booking({ deposit_required_cents: stored }), rows);
    assert.equal(result.ok, false); assert.equal(result.body.reason_code, 'no_deposit_due');
  }
});
test('bookingDepositLinkAmount: invalid marked deposit fails closed before ledger', async () => {
  for (const value of invalidStored) {
    const { result, reads } = await link(booking({ deposit_required_cents: value }));
    assert.equal(result.ok, false, String(value));
    assert.equal(result.status, 422);
    assert.equal(result.body.reason_code, 'deposit_configuration_unknown');
    assert.equal(reads, 0);
  }
});
test('bookingDepositLinkAmount: invoice cap, balance and refund-review safeguards unchanged', async () => {
  assert.deepEqual((await link(booking(), [paid(5000)], 20000)).result, { ok: true, amountDueCents: 15000 });
  assert.deepEqual((await link(booking(), [paid(5000)], 100000, 'balance')).result, { ok: true, amountDueCents: 95000 });
  assert.equal((await link(booking(), [paid(100001)])).result.body.reason_code, 'refund_review_needed');
  assert.equal((await link(booking(), [], null)).result.body.reason_code, 'invoice_total_unknown');
  const result = await bookingDepositLinkAmount(null, booking(), [], {});
  assert.equal(result.body.reason_code, 'payment_ledger_unavailable');
});
test('bookingDepositLinkAmount: ordinary booking still uses Admin nights times guests, not stored flat', async () => {
  assert.deepEqual((await link(booking({ metadata: {}, deposit_required_cents: 20000 }))).result, { ok: true, amountDueCents: 75000 });
  assert.deepEqual((await link(booking({ metadata: {}, check_out: '2026-09-06', deposit_required_cents: 0 }))).result, { ok: true, amountDueCents: 37500 });
});
