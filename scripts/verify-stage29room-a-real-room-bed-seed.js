/**
 * Stage 29room-a — Real Wolfhouse room/bed seed + assignment assertion verifier.
 *
 * Usage:
 *   npm run verify:stage29room-a-real-room-bed-seed
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SEED = path.join(__dirname, 'seed-wolfhouse-real-rooms-beds.js');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const EXAMPLE = path.join(ROOT, 'fixtures', 'wolfhouse-real-rooms-beds.example.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage29room-a-real-room-bed-seed';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage29room-a-real-room-bed-seed.js  (Stage 29room-a)\n');

section('A. Seed script + package');

check('A1', fs.existsSync(SEED), 'seed script exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A2', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const seedSrc = fs.readFileSync(SEED, 'utf8');
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

section('B. Seed safety + idempotency');

check('B1', seedSrc.includes('assertNotProductionDb'), 'production DB guard');
check('B2', seedSrc.includes('ON CONFLICT') && seedSrc.includes('DO UPDATE'), 'idempotent upsert');
check('B3', !seedSrc.includes('DELETE FROM bookings') && !seedSrc.includes('DELETE FROM payments'),
  'does not delete bookings or payments');
check('B4', seedSrc.includes('wolfhouse-somo'), 'default client wolfhouse-somo');

section('C. Seed field mapping');

check('C1', seedSrc.includes('fill_priority') && seedSrc.includes('private_priority'),
  'room priority/order mapped');
check('C2', seedSrc.includes('gender_strategy'), 'gender strategy mapped');
check('C3', seedSrc.includes('often_used_by_operator'), 'operator-blocked/often-used flag mapped');
check('C4', seedSrc.includes('active') && seedSrc.includes('sellable'), 'active/inactive beds mapped');
check('C5', seedSrc.includes('airtable_record_id'), 'stable Airtable id upsert key');

section('D. Fallback template');

check('D1', fs.existsSync(EXAMPLE), 'example mapping fixture exists');

section('E. Conversation runner assignment assertions');

check('E1', runnerSrc.includes('loadAssignedBedsWithMeta'), 'loads assigned beds after write');
check('E2', runnerSrc.includes('runOpenDemoBookingBedAssignApproved'), 'reuses bed assign helper');
check('E3', runnerSrc.includes('assigned_beds_count'), 'assigned_beds_count assertion');
check('E4', runnerSrc.includes('no_operator_blocked_beds'), 'no_operator_blocked_beds assertion');
check('E5', runnerSrc.includes('no_inactive_beds'), 'no_inactive_beds assertion');
check('E6', runnerSrc.includes('fill_priority') && runnerSrc.includes('printBedAssignmentDiagnostics'),
  'prints room/bed labels and priority');
check('E7', runnerSrc.includes('assigned_priority_order'), 'priority order validation');

section('F. No payment/Stripe/WhatsApp/n8n mutation in seed');

check('F1', !seedSrc.includes('runGuestConfirmation') && !seedSrc.includes('calls_n8n'),
  'seed does not send confirmations or activate n8n');
check('F2', !seedSrc.includes('STRIPE_SECRET_KEY') && !seedSrc.includes('sends_whatsapp'),
  'seed does not touch Stripe or WhatsApp');

section('G. Syntax');

for (const f of [SEED, RUNNER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('G', `${path.basename(f)} passes node --check`);
  } catch {
    fail('G', `${path.basename(f)} syntax error`);
  }
}

section('Summary');
console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
