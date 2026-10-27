'use strict';
// Offline real booking-context handler -> real per-guest renderer. Boundary
// fixtures supply DB rows/config only; payment projection and HTML are production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const guests = require('./lib/booking-guests');
const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const portal = require('./lib/staff-portal-ui-source').readStaffPortalUiSource();
const actualRequire = createRequire(path.join(__dirname, 'staff-query-api.js'));
let network = 0;
function denied() { network++; throw new Error('network forbidden'); }
global.fetch = denied;
require('node:net').Socket.prototype.connect = denied;
require('node:http').request = denied;
require('node:https').request = denied;
function extract(text, start, end) { return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start))); }
const handler = extract(source, 'async function handleBookingContext(', '\n// ─────────────────────────────────────────────────────────────────────────────\n// Request router');
const renderer = extract(portal, 'function bcRenderPerGuestPaymentsHtml(', '\nfunction bcRenderPerGuestCollapseCard(');
function person(n, share, paid = 0) { return { booking_guest_id: 'guest-' + n, guest_number: n, guest_name: 'Guest ' + n, metadata: share == null ? {} : { subtotal_cents: share }, amount_paid_cents: paid, deposit_amount_cents: share, payment_status: 'not_requested' }; }
function receipt(paid, id = null, extra = {}) { return { payment_id: 'receipt-' + id + '-' + paid, booking_guest_id: id, payment_status: 'paid', amount_paid_cents: paid, ...extra }; }
async function context(rows, payments, tenant = 'wolfhouse-somo', perPerson = null) {
  const before = JSON.stringify({ rows, payments });
  const booking = { booking_id: 'booking', booking_code: 'OFFLINE-I4', guest_count: rows.length, total_amount_cents: rows.reduce((s,r) => s + Number(r.metadata.subtotal_cents || 0),0), amount_paid_cents: payments.filter(p => p.payment_status === 'paid' && p.display_eligible !== false).reduce((s,p) => s + p.amount_paid_cents,0) };
  const pg = { query: async (sql, args) => {
    assert.deepEqual(Array.from(args), [tenant, booking.booking_code], 'tenant and booking stay scoped');
    if (sql === 'detail') return { rows: [booking] };
    if (sql === 'payments') return { rows: payments };
    if (sql === guests.BOOKING_GUESTS_SELECT_SQL) return { rows };
    if (sql.includes('SELECT b.metadata')) return { rows: [{ metadata: { per_person: perPerson } }] };
    if (['rooming','conversation','handoff','addons'].includes(sql)) return { rows: [] };
    throw new Error('Unexpected query: ' + sql);
  } };
  const sandbox = {
    ...guests, Date, Number, Set, String, require: spec => spec === './lib/staff-transfer-pricing' ? { loadStaffTransferConfig: async () => ({}) } : actualRequire(spec),
    DEFAULT_CLIENT: tenant, SQL_INJECT_RE: /[;']/,
    withPgClient: fn => fn(pg), resolveStoredWolfhouseBookingCode: async (_pg,_client,code) => code,
    getBookingDetailQuery: () => 'detail', BOOKING_PAYMENTS_LEDGER_SQL: 'payments', BOOKING_CONTEXT_ROOMING_SQL: 'rooming',
    getBookingConversationQuery: () => 'conversation', getBookingHandoffQuery: () => 'handoff', getBookingAddOnSummaryQuery: () => 'addons',
    loadBookingServiceRecords: async () => ({ rows: [], available: true }), listBookingTransfersForBooking: async () => [],
    appendAuditLog: () => {}, getLunaGuestNotesFromMetadata: () => [], filterPendingManualServiceRecords: () => [],
    buildServiceChargesDueFromContext: () => ({}), buildTransfersDrawerPayload: () => ({}),
    projectBookingGuestStays: (_bk, rs) => rs, loadWolfhouseQuoteConfigWithOverlay: async () => null,
    buildGuestAccommodationLines: () => [], loadWolfhouseDepositRates: async () => ({}),
    send400: (_res,error) => { throw new Error(error); }, sendJSON: (_res,status,body) => { assert.equal(status,200,JSON.stringify(body)); return body; },
  };
  vm.createContext(sandbox);
  vm.runInContext(extract(source, 'function paymentLedgerIsPaidStatus(', '\n/* Phase 10.6g.2') + '\n' + handler, sandbox);
  const result = await sandbox.handleBookingContext(booking.booking_code, { client: tenant }, {}, null);
  assert.equal(JSON.stringify({rows,payments}), before, 'read projection must not mutate receipts or stored guest rows');
  return result;
}
function render(data, client = 'wolfhouse-somo') {
  const ctx = { Number, getClient: () => client, escHtml: x => String(x), t: key => key,
    pgPayGuestSubtotalFromMetadata: md => md.subtotal_cents == null ? null : Number(md.subtotal_cents),
    bcInvoiceGuestStaffLabel: (_n,name) => name,
    bcInvoicePaymentRequestDisplay: () => ({ createLink: true }) };
  vm.createContext(ctx); vm.runInContext(renderer,ctx);
  const paid = data.payments.amount_paid_cents;
  const fullyPaid = data.booking.total_amount_cents > 0 && paid >= data.booking.total_amount_cents;
  const blocked = fullyPaid || data.payments.rows.some(p => p.payment_status === 'paid' && !p.booking_guest_id && p.amount_paid_cents > 0);
  return ctx.bcRenderPerGuestPaymentsHtml(data.booking_guests,data.per_person,'Guest',blocked,fullyPaid,{});
}
function shown(html) { return [...html.matchAll(/class="bc-guest-pay-paid">[^\d]*(\d+\.\d{2})</g)].map(m => Math.round(Number(m[1])*100)); }
async function main() {
  const data = await context([person(1,8000)], [receipt(8000)]);
  assert.deepEqual(shown(render(data)), [8000], 'I4: a solo full booking receipt must appear as Paid 80.00, not 0.00');
  const cases = [
    ['unequal full group', [person(1,4000),person(2,8000)], [receipt(12000)], [4000,8000]],
    ['unequal partial group', [person(1,4000),person(2,8000)], [receipt(6000)], [2000,4000]],
    ['mixed guest and booking receipts', [person(1,4000),person(2,8000)], [receipt(3000,'guest-1'),receipt(6000)], [3667,5333]],
    ['already paid guest not credited twice', [person(1,4000),person(2,8000)], [receipt(4000,'guest-1'),receipt(8000)], [4000,8000]],
    ['linked group preserved, caches ignored', [person(1,4000,99),person(2,8000,88)], [receipt(4000,'guest-1'),receipt(8000,'guest-2')], [4000,8000]],
    ['multiple receipts same guest sum', [person(1,8000)], [receipt(3000,'guest-1'),receipt(5000,'guest-1')], [8000]],
    ['solo overpaid remains visible', [person(1,8000)], [receipt(9000)], [9000]],
    ['group overpaid remains visible', [person(1,4000),person(2,8000)], [receipt(13000)], [4333,8667]],
    ['partial cents stable by guest number', [person(3,100),person(1,100),person(2,100)], [receipt(101)], [33,34,34]],
    ['zero share gets no ordinary credit', [person(1,0),person(2,8000)], [receipt(8000)], [0,8000]],
    ['missing shares equal fallback', [person(1,null),person(2,null)], [receipt(101)], [51,50]],
    ['no receipt ignores stale stored paid', [person(1,8000,8000)], [], [0]],
    ['pending failed cancelled expired excluded', [person(1,8000)], ['pending','failed','cancelled','expired','draft','checkout_created'].map(payment_status => receipt(8000,null,{payment_status})), [0]],
    ['display-ineligible receipts excluded', [person(1,8000)], [receipt(1000),receipt(7000,null,{display_eligible:false})], [1000]],
  ];
  for (const [name, rows, payments, expected] of cases) {
    const result = await context(rows,payments);
    const html = render(result);
    assert.deepEqual(shown(html), expected, name);
    assert.equal(shown(html).reduce((s,n)=>s+n,0),result.payments.amount_paid_cents,name+' conserves ledger cents');
    assert.deepEqual(result.booking_guests.map(r=>r.amount_paid_cents),rows.map(r=>r.amount_paid_cents),name+' preserves stored guest amounts');
    assert.deepEqual(guests.projectGuestInvoicePayments(result.booking_guests,result.payments.rows),result.booking_guests,name+' idempotent');
    if (payments.some(p=>p.payment_status==='paid' && !p.booking_guest_id && p.amount_paid_cents>0)) {
      assert(!html.includes('data-payment-target='),name+' does not authorize collection from display attribution');
    }
  }
  const fallback = await context([person(1,null),person(2,null)],[receipt(6000)],'wolfhouse-somo',[
    {guest_number:1,subtotal_cents:4000},{guest_number:2,subtotal_cents:8000}]);
  assert.deepEqual(shown(render(fallback)),[2000,4000],'persisted per-person share fallback');
  const other = await context([person(1,8000,700)],[receipt(8000)],'other-client');
  assert.equal(other.booking_guests[0].invoice_paid_cents,undefined,'other clients are unchanged');
  assert.equal(other.booking_guests[0].amount_paid_cents,700);
  let seed = 2140;
  const next = max => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed % max; };
  for (let iteration=0;iteration<1000;iteration++) {
    const rows = Array.from({length:next(10)+1},(_,i)=>person(i+1,next(500000),next(100000)));
    const payments = rows.map(row=>receipt(next(300000),row.booking_guest_id)).concat(receipt(next(1000000)));
    const before=JSON.stringify({rows,payments});
    const projected=guests.projectGuestInvoicePayments(rows,payments);
    assert.equal(projected.reduce((s,r)=>s+r.invoice_paid_cents,0),payments.reduce((s,p)=>s+p.amount_paid_cents,0),'seeded cents conservation');
    projected.forEach((row,i)=>assert(row.invoice_paid_cents>=payments[i].amount_paid_cents,'direct receipt is retained'));
    assert.equal(JSON.stringify({rows,payments}),before,'no ledger/cache mutation');
    assert.deepEqual(guests.projectGuestInvoicePayments(projected,payments),projected,'seeded idempotence');
    const reversed=guests.projectGuestInvoicePayments(rows.slice().reverse(),payments.slice().reverse()).reverse();
    assert.deepEqual(reversed,projected,'stable ordering, not receipt or row arrival order');
  }
  assert.equal(network,0);
  console.log('PASS staff per-guest paid row: I4 + '+cases.length+' reconciliation cases, quote fallback, tenant isolation, 1000 seeded invariants, real context -> renderer, no network');
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { context, render, shown, person, receipt };
