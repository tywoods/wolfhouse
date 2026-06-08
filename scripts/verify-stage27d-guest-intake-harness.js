/**
 * Stage 27d — Verifier for guest intake dry-run manual harness.
 *
 * Usage:
 *   npm run verify:stage27d-guest-intake-harness
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'run-guest-intake-dry-run.js');
const DOC = path.join(ROOT, 'docs', 'STAGE-27D-GUEST-INTAKE-HARNESS.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT_RUN = 'guest:intake:dry-run';
const SCRIPT_VERIFY = 'verify:stage27d-guest-intake-harness';
const REL_HARNESS = 'scripts/run-guest-intake-dry-run.js';
const REL_VERIFY = 'scripts/verify-stage27d-guest-intake-harness.js';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27d-guest-intake-harness.js  (Stage 27d)\n');

try {
  execSync(`node --check "${HARNESS}"`, { stdio: 'pipe' });
  pass('0a', 'harness passes node --check');
} catch {
  fail('0a', 'harness syntax error');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0b', 'verifier passes node --check');
} catch {
  fail('0b', 'verifier syntax error');
}

if (!fs.existsSync(HARNESS)) {
  fail('init', 'run-guest-intake-dry-run.js missing');
  process.exit(1);
}

const src = fs.readFileSync(HARNESS, 'utf8');

section('A. Harness presence and route');

pass('A1', 'run-guest-intake-dry-run.js exists');

if (src.includes('/staff/bot/guest-intake-dry-run')) pass('A2', 'targets /staff/bot/guest-intake-dry-run');
else fail('A2', 'route path missing');

section('B. CLI options');

const cliFlags = [
  ['B1', '--base-url', 'base URL option'],
  ['B2', '--message', 'message option'],
  ['B3', '--language-hint', 'language hint option'],
  ['B4', '--reference-date', 'reference date option'],
  ['B5', '--guest-phone', 'guest phone option'],
  ['B6', '--fixture', 'fixture option'],
  ['B7', '--json', 'json output option'],
];
for (const [id, flag, label] of cliFlags) {
  if (src.includes(flag)) pass(id, label);
  else fail(id, `${label} missing`);
}

section('C. Built-in fixtures');

const fixtureNames = [
  'en-booking',
  'it-booking',
  'es-transfer',
  'de-wetsuit',
  'fr-unclear',
  'cancel-refund',
  'payment-balance',
  'checkin-info',
  'general-random',
];
for (const name of fixtureNames) {
  if (src.includes(`'${name}'`) || src.includes(`"${name}"`)) {
    pass(`C.${name}`, `fixture ${name}`);
  } else {
    fail(`C.${name}`, `fixture ${name} missing`);
  }
}

section('D. Summary output fields');

const summaryFields = [
  'message_lane',
  'intake_state',
  'detected_language',
  'confidence',
  'extracted_fields',
  'missing_required_fields',
  'safe_handoff_required',
  'handoff_reasons',
  'allowed_next_actions',
  'proposed_luna_reply',
];
for (const field of summaryFields) {
  if (src.includes(field)) pass(`D.${field}`, `prints ${field}`);
  else fail(`D.${field}`, `summary missing ${field}`);
}

section('E. Safety flag output');

for (const flag of ['dry_run', 'sends_whatsapp', 'live_send_blocked']) {
  if (src.includes(flag)) pass(`E.${flag}`, `prints ${flag}`);
  else fail(`E.${flag}`, `safety flag ${flag} missing from output`);
}

section('F. Auth pattern');

if (src.includes('LUNA_BOT_INTERNAL_TOKEN') && src.includes('X-Luna-Bot-Token')) {
  pass('F1', 'uses LUNA_BOT_INTERNAL_TOKEN → X-Luna-Bot-Token header');
} else {
  fail('F1', 'bot auth header pattern missing');
}

if (/LUNA_BOT_INTERNAL_TOKEN not set|bot auth env not set|open local auth/i.test(src)) {
  pass('F2', 'documents auth fallback when token unset');
} else {
  fail('F2', 'auth hint missing');
}

section('G. No forbidden live actions');

const forbidden = [
  ['G1', /api\.stripe\.com|createStripe|checkout\.sessions/i, 'Stripe'],
  ['G2', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i, 'WhatsApp'],
  ['G3', /fetch\s*\([^)]*n8n|n8n\.io/i, 'n8n'],
  ['G4', /create-stripe-link|createPaymentLink|payment.link/i, 'payment link create'],
  ['G5', /\bINSERT\s+INTO\b/i, 'SQL INSERT'],
];
for (const [id, re, label] of forbidden) {
  if (!re.test(src)) pass(id, `harness does not reference ${label}`);
  else fail(id, `forbidden ${label} pattern in harness`);
}

section('H. npm scripts and docs');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT_RUN] === `node ${REL_HARNESS}`) {
  pass('H1', `${SCRIPT_RUN} registered`);
} else {
  fail('H1', `${SCRIPT_RUN} missing or wrong path`);
}

if (pkg.scripts && pkg.scripts[SCRIPT_VERIFY] === `node ${REL_VERIFY}`) {
  pass('H2', `${SCRIPT_VERIFY} registered`);
} else {
  fail('H2', `${SCRIPT_VERIFY} missing or wrong path`);
}

if (fs.existsSync(DOC)) {
  pass('H3', 'STAGE-27D-GUEST-INTAKE-HARNESS.md exists');
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('guest:intake:dry-run')) pass('H4', 'doc mentions npm script');
  else fail('H4', 'doc missing npm script');
  if (doc.includes('LUNA_BOT_INTERNAL_TOKEN')) pass('H5', 'doc mentions auth env');
  else fail('H5', 'doc missing auth env');
} else {
  fail('H3', 'harness doc missing');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
