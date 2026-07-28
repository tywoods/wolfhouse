'use strict';

/** Executable production-owner gate for the staff Sunset Stripe-link API. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const owner = fs.readFileSync(path.join(__dirname, 'lib', 'sunset-stripe-payment-links.js'), 'utf8');
const handlerStart = api.indexOf('async function handleSunsetScheduleStripeLinkCreate');
const handlerEnd = api.indexOf('async function handleSunsetScheduleDayGet', handlerStart);
const handlers = api.slice(handlerStart, handlerEnd);

assert(handlerStart >= 0 && handlerEnd > handlerStart, 'production staff API handlers found');
assert.match(handlers, /isSunsetLocationId\(locationId\)/, 'API validates exact supported location');
assert.match(handlers, /assertStaffClientAccess\(user, clientSlug, res\)/, 'API authorizes staff tenant access');
assert.doesNotMatch(handlers, /err\.message|detail\s*:/, 'API never returns provider/DB exception details');
assert.match(owner, /INNER JOIN clients c ON c\.id = b\.client_id[\s\S]*c\.slug = \$1[\s\S]*b\.id = \$2::uuid[\s\S]*FOR UPDATE/,
  'production owner locks booking under exact tenant ownership');
assert.match(owner, /unsupported_location/, 'production owner rejects missing/unknown/spoofed location');

for (const script of ['scripts/verify-issue274-payment-link-replacement.js', 'scripts/verify-sunset-payment-link-concurrency.js']) {
  const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  assert.strictEqual(run.status, 0, `${script} must pass`);
}

console.log('PASS verify:staff-stripe-payment-link-api production-owner gate');
