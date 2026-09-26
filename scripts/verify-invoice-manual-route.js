#!/usr/bin/env node
'use strict';

// Offline HTTP projection regression. Runs the EXACT production handler and
// router branch in a VM; it does not start/import the server or open sockets.
// recordStaffManualPayment is a service spy (using its real input validator),
// NOT a SQL simulator/proof. Run the separate PGlite manual-payment verifier for
// persistence/transaction coverage. requireAuth is an explicit auth double:
// denied-dispatch tests are NOT proof of real cookies/session authentication.
// Tenant binding and assertStaffClientAccess are production code; the downstream
// client ACL decision is an explicit fixture seam, not a real access-config test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { bindStaffGuestPaymentClient } = require('./lib/staff-guest-payment-link-auth');
const { validateStaffManualPayment } = require('./lib/staff-manual-payment');

let networkAttempts = 0;
function forbidNetwork() { networkAttempts++; throw new Error('Offline route verifier forbids networking'); }
global.fetch = forbidNetwork;
require('node:http').request = forbidNetwork;
require('node:https').request = forbidNetwork;
require('node:net').connect = forbidNetwork;
require('node:net').Socket.prototype.connect = forbidNetwork;

const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
function productionFunction(name) {
  const start = source.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert(start >= 0, 'Production function not found: ' + name);
  const end = source.indexOf('\n}', start);
  assert(end > start, 'Top-level function end not found: ' + name);
  return source.slice(start, end + 2);
}
const handlerSource = productionFunction('handleBookingRecordCashPayment');
const routeMarker = "  if (pathname === '/staff/bookings/record-cash-payment') {";
const routeStart = source.indexOf(routeMarker);
assert(routeStart >= 0, 'Production manual-payment router branch not found');
assert.equal(source.indexOf(routeMarker, routeStart + 1), -1, 'Router extraction must be unambiguous');
const routeEnd = source.indexOf('\n  }', routeStart);
assert(routeEnd > routeStart, 'Production router branch end not found');
const routeSource = source.slice(routeStart, routeEnd + 4);

const B1 = '20000000-0000-4000-8000-000000000001';
const G1 = '30000000-0000-4000-8000-000000000001';
const P1 = '40000000-0000-4000-8000-000000000001';
const CLIENT = 'wolfhouse-somo';
const operator = { staff_user_id: 'offline-operator', email: 'operator@example.invalid', role: 'operator', client_slug: CLIENT };
const payload = { client_slug: CLIENT, booking_id: B1, booking_code: 'OFFLINE-1',
  idempotency_key: 'offline-manual-1', amount_cents: 1250, method: 'bank_transfer',
  payment_scope: 'guest', booking_guest_id: G1, payment_date: '2026-09-25', note: '  bank receipt  ' };
const serviceResult = { idempotent: false, payment: { payment_id: P1, payment_status: 'paid',
  booking_guest_id: G1, amount_due_cents: 1250, amount_paid_cents: 1250 },
booking_paid_cents: 3250, balance_due_cents: 6750 };
const plain = value => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = { auth: [], handlers: [], bind: [], acl: [], helper: [], queries: [], audit: [] };
  const booking = { booking_id: B1, booking_code: 'OFFLINE-1', client_id: '10000000-0000-4000-8000-000000000001',
    status: 'confirmed', total_amount_cents: 10000, payment_status: 'not_requested' };
  // Explicit lookup/legacy fixture, not SQL execution. Legacy statements are
  // accommodated so RED means missing integration, never a missing SQL fixture.
  const pg = { async query(sql, params) {
    calls.queries.push({ sql, params });
    if (sql === 'LOOKUP_BY_ID' || sql === 'LOOKUP_BY_CODE') {
      return { rows: options.missingBooking ? [] : [booking] };
    }
    if (/SELECT id FROM clients/.test(sql)) return { rows: [{ id: booking.client_id }] };
    if (/SUM\(/.test(sql)) return { rows: [{ total: 3250 }] };
    if (/INSERT INTO payments/.test(sql)) return { rows: [serviceResult.payment] };
    if (/FROM payments p/.test(sql) || /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /UPDATE bookings/.test(sql)) return { rows: [] };
    throw new Error('Unrecognized fixture query: ' + sql);
  } };
  function sendJSON(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  async function recordStaffManualPayment(connection, input) {
    assert.equal(connection, pg, 'Helper must receive the reserved PG client');
    calls.helper.push(plain(input));
    validateStaffManualPayment(input);
    if (options.helperError) throw options.helperError;
    return options.result || serviceResult;
  }
  const binding = args => { calls.bind.push(args); return bindStaffGuestPaymentClient(args); };
  const context = vm.createContext({
    URL, Date, console, Buffer, fetch: forbidNetwork,
    DEFAULT_CLIENT: CLIENT, STAFF_AUTH_REQUIRED: true,
    STAFF_ACTIONS_ENABLED: options.enabled !== false,
    staffActionsGate: () => options.enabled !== false,
    SQL_INJECT_RE: /['";\\]|--|\bDROP\b|\bALTER\b|\bTRUNCATE\b/i,
    UUID_VALIDATE_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    DATE_RE: /^\d{4}-\d{2}-\d{2}$/,
    EDIT_PREVIEW_BOOKING_BY_ID_SQL: 'LOOKUP_BY_ID', EDIT_PREVIEW_BOOKING_BY_CODE_SQL: 'LOOKUP_BY_CODE',
    readBody: async req => req.rawBody,
    sendJSON, send400: (res, error) => sendJSON(res, 400, { success: false, error }),
    appendAuditLog: entry => calls.audit.push(entry),
    withPgClient: async fn => fn(pg),
    getFortress15j3OfflineSeams: () => ({ canAccessClient(user, slug) {
      calls.acl.push({ user, slug }); return user.client_slug === slug;
    } }),
    bindStaffGuestPaymentClient: binding, recordStaffManualPayment,
    require(name) {
      if (name === './lib/staff-manual-payment') return { recordStaffManualPayment, validateStaffManualPayment };
      if (name === './lib/staff-guest-payment-link-auth') return { bindStaffGuestPaymentClient: binding };
      throw new Error('Unapproved dependency in offline handler: ' + name);
    },
    async requireAuth(req, res, role) {
      calls.auth.push({ role, req });
      // Deliberately an auth double; no real session/cookie processing here.
      const user = Object.hasOwn(options, 'user') ? options.user : operator;
      if (!user) { sendJSON(res, 401, { success: false, error: 'unauthenticated' }); return { ok: false }; }
      if (!['operator', 'admin', 'owner'].includes(user.role)) {
        sendJSON(res, 403, { success: false, error: 'insufficient_role' }); return { ok: false };
      }
      return { ok: true, user };
    },
  });
  vm.runInContext([
    productionFunction('staffClientAccessAllowed'), productionFunction('assertStaffClientAccess'),
    productionFunction('bookingStatusIsCancelled'), productionFunction('parseCalendarDate'), handlerSource,
    'this.productionHandler = handleBookingRecordCashPayment;',
  ].join('\n'), context, { filename: 'staff-query-api.manual-handler.extracted.js' });
  context.handleBookingRecordCashPayment = (...args) => { calls.handlers.push(args); return context.productionHandler(...args); };
  vm.runInContext('this.dispatch = async function(req, res) {\n' +
    'const pathname = new URL(req.url, "http://staff.local").pathname; const method = req.method;\n' +
    routeSource + '\n};', context, { filename: 'staff-query-api.manual-router.extracted.js' });
  async function request(body = payload, method = 'POST', url = '/staff/bookings/record-cash-payment?client=' + CLIENT) {
    const req = { method, url, headers: {}, rawBody: typeof body === 'string' ? body : JSON.stringify(body) };
    const res = { status: null, headers: {}, raw: null,
      writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
      end(raw) { assert.equal(this.raw, null, 'Response ended twice'); this.raw = raw; } };
    await context.dispatch(req, res);
    assert.notEqual(res.raw, null, 'Production route must finish response');
    return { status: res.status, headers: res.headers, body: JSON.parse(res.raw) };
  }
  return { calls, request };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });
function oneHelper(h) {
  assert.equal(h.calls.helper.length, 1, 'Actual production handler must call recordStaffManualPayment once (legacy inline SQL is not integration)');
  return h.calls.helper[0];
}
function noWork(h) {
  assert.equal(h.calls.helper.length, 0, 'Denied request must not invoke payment helper');
  assert.equal(h.calls.queries.length, 0, 'Denied request must not access payment DB');
}

test('POST executes actual handler and projects all raw named fields to payment service', async () => {
  const h = harness(); const response = await h.request();
  const input = oneHelper(h);
  for (const [key, value] of Object.entries({ clientSlug: CLIENT, bookingId: B1,
    amountCents: payload.amount_cents, paymentScope: payload.payment_scope,
    bookingGuestId: payload.booking_guest_id, method: payload.method,
    paymentDate: payload.payment_date, note: payload.note,
    idempotencyKey: payload.idempotency_key, actorLabel: operator.email })) assert.equal(input[key], value, key);
  assert.equal(response.status, 200);
  assert.equal(h.calls.handlers.length, 1);
  assert.equal(h.calls.auth[0].role, 'operator');
  assert.equal(h.calls.handlers[0][2], operator, 'Router must forward authenticated principal');
  assert.equal(h.calls.bind.length, 1, 'Production tenant binder must run');
  assert.equal(h.calls.acl.length, 1, 'Production assertStaffClientAccess must consult ACL');
  assert(h.calls.queries.every(q => q.sql === 'LOOKUP_BY_ID' || q.sql === 'LOOKUP_BY_CODE'), 'No duplicate inline payment persistence');
});

test('successful JSON response exposes helper receipt and authoritative totals', async () => {
  const result = { ...serviceResult, idempotent: true, booking_paid_cents: 9876, balance_due_cents: 124 };
  const h = harness({ result }); const response = await h.request(); oneHelper(h);
  assert.equal(response.status, 200); assert.equal(response.body.success, true);
  for (const key of ['payment', 'idempotent', 'booking_paid_cents', 'balance_due_cents']) assert.deepEqual(response.body[key], result[key]);
  for (const key of ['no_stripe', 'no_whatsapp', 'no_n8n']) assert.equal(response.body[key], true);
});

for (const [label, change, key, raw] of [
  ['fractional cents', { amount_cents: 1250.75 }, 'amountCents', 1250.75],
  ['string cents', { amount_cents: '1250' }, 'amountCents', '1250'],
  ['unsupported method', { method: 'stripe' }, 'method', 'stripe'],
  ['invalid scope', { payment_scope: 'room' }, 'paymentScope', 'room'],
  ['missing named guest', { booking_guest_id: undefined }, 'bookingGuestId', undefined],
  ['invalid date', { payment_date: '2026-02-30' }, 'paymentDate', '2026-02-30'],
]) test('raw ' + label + ' reaches real validator without coercion and returns 400', async () => {
  const h = harness(); const response = await h.request({ ...payload, ...change });
  assert.equal(oneHelper(h)[key], raw, 'Do not floor/default/sanitize service-owned inputs');
  assert.equal(response.status, 400); assert.equal(response.body.error, 'invalid_manual_payment');
});

test('legacy booking request preserves omitted scope/guest/method for helper defaults', async () => {
  const body = { ...payload }; delete body.payment_scope; delete body.booking_guest_id; delete body.method;
  const h = harness(); const response = await h.request(body); const input = oneHelper(h);
  assert.equal(input.paymentScope, undefined); assert.equal(input.bookingGuestId, undefined); assert.equal(input.method, undefined);
  assert.equal(response.status, 200);
});

test('STAFF_ACTIONS_ENABLED=false forbids payment before DB work', async () => {
  const h = harness({ enabled: false }); const response = await h.request();
  assert.equal(response.status, 403); assert.equal(response.body.success, false); noWork(h);
});

test('authenticated tenant ACL rejects foreign query tenant', async () => {
  const h = harness(); const response = await h.request({ ...payload, client_slug: 'sunset' }, 'POST', '/staff/bookings/record-cash-payment?client=sunset');
  assert.equal(response.status, 403); assert.equal(response.body.error, 'client_access_denied');
  assert.equal(h.calls.acl.length, 1); noWork(h);
});

test('body client_slug cannot override authenticated request tenant', async () => {
  const h = harness(); const response = await h.request({ ...payload, client_slug: 'sunset' });
  assert.equal(response.status, 403); assert.equal(response.body.error, 'client_scope_mismatch'); noWork(h);
});

test('legacy body client alias cannot redirect authenticated request tenant', async () => {
  const body = { ...payload, client: 'sunset' }; delete body.client_slug;
  const h = harness(); const response = await h.request(body);
  // Fail closed on the legacy alias too; silently ignoring it is not required.
  assert.equal(response.status, 403); assert.equal(response.body.error,'client_scope_mismatch'); noWork(h);
});

test('missing query client binds DEFAULT_CLIENT and still checks ACL', async () => {
  const h = harness(); const response = await h.request(payload, 'POST', '/staff/bookings/record-cash-payment');
  assert.equal(oneHelper(h).clientSlug, CLIENT); assert.equal(response.status, 200); assert.equal(h.calls.acl.length, 1);
});

for (const [label, user, status] of [['unauthenticated', null, 401], ['viewer role', { ...operator, role: 'viewer' }, 403]]) {
  test(label + ' auth DOUBLE denies actual router dispatch without handler invocation', async () => {
    const h = harness({ user }); const response = await h.request();
    assert.equal(response.status, status); assert.equal(h.calls.auth[0].role, 'operator');
    assert.equal(h.calls.handlers.length, 0); noWork(h);
  });
}

test('non-POST returns 405 and Allow POST without auth/handler invocation', async () => {
  const h = harness(); const response = await h.request(payload, 'GET');
  assert.equal(response.status, 405); assert.equal(response.headers.Allow, 'POST');
  assert.equal(h.calls.auth.length, 0); assert.equal(h.calls.handlers.length, 0); noWork(h);
});

for (const [code, status] of [['invalid_manual_payment', 400], ['booking_guest_not_found', 404],
  ['booking_not_found', 404], ['booking_not_active', 400], ['idempotency_conflict', 409]]) {
  test('service ' + code + ' maps public code and HTTP ' + status, async () => {
    const helperError = Object.assign(new Error('private diagnostic'), { code, httpStatus: status, publicMessage: 'Safe public explanation' });
    const h = harness({ helperError }); const response = await h.request(); oneHelper(h);
    assert.equal(response.status, status); assert.equal(response.body.success, false); assert.equal(response.body.error, code);
    assert(!JSON.stringify(response.body).includes('private diagnostic'), 'Typed errors must not leak internal diagnostics');
  });
}

test('unexpected helper failure returns 500 without a success receipt', async () => {
  const h = harness({ helperError: new Error('offline service failure') }); const response = await h.request(); oneHelper(h);
  assert.equal(response.status, 500); assert.equal(response.body.success, false); assert.equal(response.body.payment, undefined);
});

test('booking ID/code mismatch is rejected before recording payment', async () => {
  const h = harness(); const response = await h.request({ ...payload, booking_code: 'OTHER-BOOKING' });
  assert.equal(response.status, 409); assert.equal(response.body.success, false);
  assert.equal(h.calls.helper.length, 0); assert(!h.calls.queries.some(q => /INSERT|UPDATE/.test(q.sql)));
});

test('booking code-only request resolves booking ID before service call', async () => {
  const body = { ...payload }; delete body.booking_id;
  const h = harness(); const response = await h.request(body);
  assert.equal(oneHelper(h).bookingId, B1); assert.equal(response.status, 200);
  assert.deepEqual(plain(h.calls.queries[0].params), [CLIENT, payload.booking_code]);
});

test('missing booking returns 404 without service invocation', async () => {
  const h = harness({ missingBooking: true }); const response = await h.request();
  assert.equal(response.status, 404); assert.equal(h.calls.helper.length, 0);
});

test('malformed JSON returns 400 before service/DB access', async () => {
  const h = harness(); const response = await h.request('{broken'); assert.equal(response.status, 400); noWork(h);
});

(async () => {
  let failed = 0;
  for (const { name, run } of tests) {
    try { await run(); console.log('PASS ' + name); }
    catch (err) { failed++; console.error('FAIL ' + name + '\n  ' + err.message); }
  }
  assert.equal(networkAttempts, 0, 'No network attempts permitted');
  console.log(`${tests.length - failed}/${tests.length} passed; ${failed} failed; network attempts: ${networkAttempts}`);
  console.log('Scope: actual extracted handler/router + production tenant binder/assertion; service spy + real validator. No SQL or real session-auth proof.');
  if (failed) process.exitCode = 1;
})().catch(err => { console.error(err); process.exitCode = 1; });
