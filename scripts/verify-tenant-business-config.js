'use strict';

/**
 * verify:tenant-business-config
 *
 * Offline assertions for tenant-business-config.js resolver.
 * No DB, no network, no secrets required.
 *
 * Run: node scripts/verify-tenant-business-config.js
 *      npm run verify:tenant-business-config
 */

const {
  DEFAULT_DAILY_CAP,
  SUNSET_ADMIN_CLIENT,
  resolveTenantBusinessConfig,
} = require('./lib/tenant-business-config');

let pass = 0;
let fail = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    pass++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

console.log('\nverify:tenant-business-config — read-only resolver checks\n');

console.log('[1] Sunset config resolution');
const sunset = resolveTenantBusinessConfig('sunset');
assert('sunset ok', sunset.ok === true);
assert('client_slug sunset', sunset.client_slug === 'sunset');
assert('read_only true', sunset.read_only === true);
assert('source is config', sunset.source === 'config');
assert('default_daily_cap 24', sunset.lesson_capacity.default_daily_cap === DEFAULT_DAILY_CAP);
assert('overrides empty array', Array.isArray(sunset.lesson_capacity.overrides) && sunset.lesson_capacity.overrides.length === 0);
assert('prices from baseline catalog', Array.isArray(sunset.prices) && sunset.prices.length > 0);
assert('includes rental price', sunset.prices.some((p) => p.category === 'rental' && p.offering_key === 'board_rental'));
assert('includes lesson price', sunset.prices.some((p) => p.category === 'lesson' && p.offering_key === 'group_lesson_adult'));
assert('lesson times from portal_demo', Array.isArray(sunset.lesson_times) && sunset.lesson_times.length >= 3);
assert('business name Sunset Surf School', sunset.business_info.name === 'Sunset Surf School');
assert('timezone Europe/Madrid', sunset.business_info.timezone === 'Europe/Madrid');
assert('change_history empty', Array.isArray(sunset.change_history) && sunset.change_history.length === 0);

console.log('\n[2] Tenant isolation');
const wolfhouse = resolveTenantBusinessConfig('wolfhouse-somo');
assert('wolfhouse blocked', wolfhouse.ok === false && wolfhouse.reason === 'unsupported_client');
assert('wolfhouse slug preserved', wolfhouse.client_slug === 'wolfhouse-somo');

console.log('\n[3] Constants');
assert('SUNSET_ADMIN_CLIENT is sunset', SUNSET_ADMIN_CLIENT === 'sunset');
assert('DEFAULT_DAILY_CAP is 24', DEFAULT_DAILY_CAP === 24);

console.log('\n' + '─'.repeat(48));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error('verify:tenant-business-config — FAILED');
  process.exit(1);
}
console.log('verify:tenant-business-config — ALL CHECKS PASSED');
