'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const resolve = require('./lib/wolfhouse-pricing-resolve');
const routesMod = require('./lib/wolfhouse-pricing-routes');

const config = resolve.loadPricingConfig();
assert.equal(Object.prototype.hasOwnProperty.call(config, 'package_min_nights'), false);

const overlay = resolve.applyOverlayPackageItemsToConfig(structuredClone(config), [
  { item_type: 'policy', item_code: 'package_min_nights', metadata: { minimum_nights: 9 }, active: true },
]);
assert.equal(overlay.package_min_nights, null);

const ui = fs.readFileSync(path.join(__dirname, 'browser', 'wolfhouse-admin-pricing-ui.js'), 'utf8');
assert.equal(ui.includes('Package Night minimum'), false);
assert.equal(ui.includes('data-wh-package-minimum'), false);
assert.equal(ui.includes('/package-minimum'), false);

const fake = {
  sendJSON() {}, send400() {}, readBody: async () => ({}),
  assertStaffClientAccess: () => true, appendAuditLog() {},
  withPgClient: async (run) => run({ query: async () => ({ rows: [] }) }),
  DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[;'"\\\\]/,
  STAFF_AUTH_REQUIRED: true, resolveStaffRole: () => 'admin',
};
const routes = routesMod.createWolfhousePricingRoutes(fake);
assert.equal(routes.match('/staff/admin/wh/pricing/package-minimum', 'PUT'), null);

console.log('verify-package-minimum-admin: PASS');
