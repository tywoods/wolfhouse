/**
 * Phase 26h.5 — Verifier for nullable booking_service_records.service_date migration.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-services-nullable-service-date
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '018_booking_service_records_nullable_service_date.sql');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-services-routes.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-services-nullable-service-date';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const UPSTREAM = [
  'verify:luna-agent-phase26-services-schedule-writes',
  'verify:luna-agent-phase26-services-tab-schedule',
  'verify:luna-agent-phase26-services-unschedule-drawer-cleanup',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-services-nullable-service-date.js  (Phase 26h.5)\n');

const sql = readOrEmpty(MIGRATION);
const routesSrc = readOrEmpty(ROUTES);
const patchSlice = (routesSrc.match(/async function handlePatchBookingServiceDate[\s\S]{0,2200}/) || [''])[0];
const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');

section('A. Migration file');

if (sql.length > 0) pass('A1', 'migration 018 file exists');
else fail('A1', 'migration 018 missing');

if (/ALTER TABLE booking_service_records[\s\S]{0,120}ALTER COLUMN service_date DROP NOT NULL/i.test(sql)) {
  pass('A2', 'drops NOT NULL on booking_service_records.service_date');
} else fail('A2', 'DROP NOT NULL missing');

if (!/DROP TABLE booking_service_records/i.test(sql)) {
  pass('A3', 'does not drop table');
} else fail('A3', 'drops table');

if (!/\bDELETE\b|\bUPDATE\b booking_service_records/i.test(sql)) {
  pass('A4', 'does not delete/update rows');
} else fail('A4', 'mutates rows');

if (/service_date null|NULL = paid\/requested|not scheduled/i.test(sql)) {
  pass('A5', 'comment documents null = unscheduled');
} else fail('A5', 'missing null semantics comment');

if (/^\s*BEGIN\s*;/m.test(sql) && /COMMIT\s*;/m.test(sql)) {
  pass('A6', 'transaction wrapped');
} else fail('A6', 'BEGIN/COMMIT missing');

section('B. Migration safety');

if (!/\bpayments\b/i.test(sql.replace(/booking_service_records/gi, ''))) {
  pass('B1', 'does not touch payments table');
} else fail('B1', 'touches payments');

if (!/stripe|whatsapp|meta|n8n/i.test(sql)) {
  pass('B2', 'does not touch Stripe/WhatsApp/Meta/n8n');
} else fail('B2', 'external integration in migration');

if (!/amount_due|price|payment_status|status\s/i.test(sql.replace(/COMMENT ON COLUMN booking_service_records\.service_date[\s\S]*?;/gi, ''))) {
  pass('B3', 'does not alter prices/status fields');
} else fail('B3', 'alters price/status fields');

section('C. Unschedule route');

if (/clearing = body\.service_date === null/.test(patchSlice) || /service_date === null/.test(patchSlice)) {
  pass('C1', 'PATCH route accepts service_date null');
} else fail('C1', 'null acceptance missing');

if (/clearing \? null : serviceDate/.test(patchSlice)) {
  pass('C2', 'null clears service_date only');
} else fail('C2', 'null SQL update missing');

if (!/DELETE FROM booking_service_records/.test(routesSrc)) {
  pass('C3', 'no service delete route');
} else fail('C3', 'delete route present');

section('D. Docs + npm');

if (pkg.scripts && pkg.scripts[SCRIPT]) {
  pass('D1', 'npm script registered');
} else fail('D1', 'npm script missing');

section('E. Safety — guest AI untouched');

GUEST_UNTOUCHED.forEach((p) => {
  const base = path.basename(p);
  if (fs.existsSync(p)) pass(`E.${base}`, `${base} unchanged`);
  else fail(`E.${base}`, `${base} missing`);
});

section('F. Upstream verifiers');

UPSTREAM.forEach((name) => {
  try {
    execSync(`npm run ${name}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    pass(`F.${name}`, `${name} still passes`);
  } catch (err) {
    const tail = (err.stdout || err.stderr || '').split('\n').slice(-3).join(' ');
    fail(`F.${name}`, `${name} failed${tail ? ': ' + tail : ''}`);
  }
});

console.log(`\n${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
