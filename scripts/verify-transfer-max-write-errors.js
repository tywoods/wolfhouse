'use strict';
// Narrow HTTP error mapping test: real Admin PUT handler, injected database
// errors. SQL rollback/non-mutation is covered by verify-transfer-max-group-size.
const assert = require('node:assert/strict');
const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
async function run() {
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true'; // disposable process, injected DB only
  for (const [error, expected] of [
    [{ code: '23514', constraint: 'wh_pricing_transfer_rules_max_guest_count_check', message: 'synthetic check violation' }, 400],
    [{ code: '23514', constraint: 'another_unrelated_check', message: 'synthetic unrelated failure' }, 500],
    [{ code: 'XX000', message: 'synthetic DB unavailable' }, 500],
  ]) {
    const routes = createWolfhousePricingRoutes({
      withPgClient: async () => { throw Object.assign(new Error(error.message), error); },
      sendJSON: (res, status, body) => Object.assign(res, { status, body }),
      send400: (res, message) => Object.assign(res, { status: 400, body: { success: false, error: message } }),
      readBody: async req => req.body,
      assertStaffClientAccess: () => true, appendAuditLog() {},
      DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[;'"\\]/,
      STAFF_AUTH_REQUIRED: true, resolveStaffRole: user => user.role,
    });
    const res = {};
    await routes.match('/staff/admin/wh/pricing/transfers', 'PUT')(
      { client: 'wolfhouse-somo' },
      { body: JSON.stringify({ airport_code: 'SDR', label: 'Santander', min_guest_count: 9,
        unavailable_below_min_group_message: 'Minimum nine' }) }, res, { role: 'admin' });
    assert.equal(res.status, expected, JSON.stringify({ error, result: res }));
    assert.equal(res.body.success, false);
    if (expected === 400) assert.match(res.body.error, /max_guest_count/);
  }
  console.log('PASS: named max-bound CHECK maps to HTTP 400; unrelated constraints/outages stay 500.');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
