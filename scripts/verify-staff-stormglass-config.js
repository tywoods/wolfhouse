/**
 * Phase 11b.0 — Verifier for Stormglass API key config detection (no live API).
 *
 * Usage:
 *   npm run verify:staff-stormglass-config
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_FILE = path.join(__dirname, 'staff-query-api.js');
const SG_FILE = path.join(__dirname, 'lib', 'staff-stormglass-config.js');
const PKG_FILE = path.join(__dirname, '..', 'package.json');

let passes = 0;
let failures = 0;

function ok(msg)   { console.log(`  PASS  ${msg}`); passes++; }
function fail(msg) { console.error(`  FAIL  ${msg}`); failures++; }
function check(cond, pass, failMsg) { if (cond) ok(pass); else fail(failMsg || pass); }

console.log('\nverify-staff-stormglass-config.js  (Phase 11b.0)\n');

for (const f of [API_FILE, SG_FILE, PKG_FILE]) {
  check(fs.existsSync(f), `${path.basename(f)} exists`);
}
if (failures) process.exit(1);

const apiSrc = fs.readFileSync(API_FILE, 'utf8');
const sgSrc = fs.readFileSync(SG_FILE, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

try {
  execSync(`node --check "${SG_FILE}"`, { stdio: 'ignore' });
  ok('staff-stormglass-config.js passes node --check');
} catch (_) {
  fail('staff-stormglass-config.js passes node --check');
}

check(
  pkg.scripts && pkg.scripts['verify:staff-stormglass-config']
    === 'node scripts/verify-staff-stormglass-config.js',
  'package.json verify script',
);

check(sgSrc.includes('process.env.STORMGLASS_API_KEY'), 'helper reads STORMGLASS_API_KEY from env');
check(sgSrc.includes('function hasStormglassConfig'), 'hasStormglassConfig defined');
check(sgSrc.includes('configured: hasStormglassConfig()'), 'status returns configured boolean only');
check(
  !sgSrc.match(/return\s*\{[^}]*\bkey\b/i),
  'status object does not expose key field',
);

check(apiSrc.includes('getStormglassConfigStatus'), 'API uses stormglass config status');
check(apiSrc.includes('stormglass:   getStormglassConfigStatus()'), 'healthz includes stormglass status');
check(!apiSrc.match(/stormglass[\s\S]{0,120}STORMGLASS_API_KEY/i),
  'healthz path does not echo STORMGLASS_API_KEY');

const uiStart = apiSrc.indexOf('function buildUiHtml');
const uiEnd = uiStart > -1 ? apiSrc.indexOf('\nfunction ', uiStart + 1) : -1;
const uiBlock = uiStart > -1 && uiEnd > uiStart ? apiSrc.slice(uiStart, uiEnd) : '';
check(uiBlock.length > 0, 'buildUiHtml block found');
check(!/STORMGLASS/i.test(uiBlock), 'STORMGLASS not in /staff/ui HTML bundle');
check(!/process\.env\.STORMGLASS/i.test(uiBlock), 'env var not exposed in UI JS');

const { hasStormglassConfig, getStormglassConfigStatus } = require('./lib/staff-stormglass-config');

const prev = process.env.STORMGLASS_API_KEY;
delete process.env.STORMGLASS_API_KEY;
check(!hasStormglassConfig(), 'false when env unset');
check(getStormglassConfigStatus().configured === false, 'status configured false when unset');

process.env.STORMGLASS_API_KEY = '  test-key-stormglass  ';
check(hasStormglassConfig(), 'true when env set');
const status = getStormglassConfigStatus();
check(status.configured === true, 'status configured true when set');
check(!('api_key' in status) && !('key' in status), 'status never includes key fields');
check(JSON.stringify(status).indexOf('test-key') === -1, 'status JSON does not leak key value');

if (prev === undefined) delete process.env.STORMGLASS_API_KEY;
else process.env.STORMGLASS_API_KEY = prev;

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
