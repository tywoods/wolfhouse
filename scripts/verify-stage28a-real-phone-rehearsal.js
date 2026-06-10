/**
 * Stage 28a — Static verifier for real-phone staging rehearsal readiness doc.
 *
 * Docs-only — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage28a-real-phone-rehearsal
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md');
const CLOSEOUT = path.join(ROOT, 'docs', 'STAGE-27DEMO-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28a-real-phone-rehearsal';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-stage28a-real-phone-rehearsal.js  (Stage 28a readiness)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-28A-REAL-PHONE-STAGING-REHEARSAL.md exists');
else fail('A1', 'readiness doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Demo goal');

docMatches(doc, /Ale.*Cami|real phone/i, 'B1', 'Ale/Cami real-phone goal');
docMatches(doc, /Staff Portal.*Calendar|Bed Calendar/i, 'B2', 'Staff Portal + calendar');
docMatches(doc, /no production|production not live|staging only/i, 'B3', 'no production traffic');
docMatches(doc, /no uncontrolled|explicit.*GO|owner GO/i, 'B4', 'controlled automation');

section('C. Demo scenario');

docMatches(doc, /2 guests|two guests/i, 'C1', '2 guests scenario');
docMatches(doc, /Malibu/i, 'C2', 'Malibu package');
docMatches(doc, /deposit/i, 'C3', 'deposit payment choice');
docMatches(doc, /Stripe TEST|sk_test_/i, 'C4', 'Stripe TEST only');

section('D. Rehearsal modes');

docMatches(doc, /Mode A|Review-only/i, 'D1', 'Mode A review-only');
docMatches(doc, /Mode B|Booking-write/i, 'D2', 'Mode B booking-write');
docMatches(doc, /Mode C|Payment-link/i, 'D3', 'Mode C payment-link');
docMatches(doc, /Mode D|Confirmation/i, 'D4', 'Mode D confirmation');
docIncludes(doc, 'OPEN_DEMO_BOOKING_WRITES_ENABLED', 'D5', 'booking write gate named');
docIncludes(doc, 'LUNA_CONFIRMATION_LIVE_SEND_ALLOWLIST', 'D6', 'confirmation allowlist named');

section('E. Test phone policy');

docMatches(doc, /allowlisted.*test phone|test phones only/i, 'E1', 'allowlisted test phones');
docMatches(doc, /no public guest|not.*anyone with the demo/i, 'E2', 'no public open demo');
docMatches(doc, /no Main|production n8n/i, 'E3', 'no production n8n');

section('F. Runbook');

docMatches(doc, /Before rehearsal|5\.1 Before/i, 'F1', 'before checklist');
docMatches(doc, /During rehearsal|5\.2 During/i, 'F2', 'during checklist');
docMatches(doc, /After rehearsal|5\.3 After/i, 'F3', 'after checklist');
docIncludes(doc, 'booking_code', 'F4', 'capture booking_code');
docMatches(doc, /restore gates|Rollback/i, 'F5', 'rollback section');

section('G. Non-goals');

docMatches(doc, /no Inbox redesign|Inbox redesign/i, 'G1', 'no inbox redesign');
docMatches(doc, /services.*add-ons|add-ons/i, 'G2', 'services/add-ons deferred');
docMatches(doc, /no live Stripe|sk_live_/i, 'G3', 'no live Stripe');
docMatches(doc, /UI polish/i, 'G4', 'UI polish de-emphasized');

section('H. Exit + next stage');

docMatches(doc, /Exit criteria|28a.*complete/i, 'H1', 'exit criteria');
docMatches(doc, /Stage 28b|28b/i, 'H2', 'next stage 28b');
docMatches(doc, /review-only/i, 'H3', 'recommends review-only 28b');

section('I. Closeout link');

if (fs.existsSync(CLOSEOUT)) pass('I1', 'STAGE-27DEMO-CLOSEOUT.md exists');
else fail('I1', 'closeout doc missing');

docIncludes(doc, 'STAGE-27DEMO-CLOSEOUT', 'I2', 'references 27demo closeout');
docIncludes(doc, '4f76aae', 'I3', 'references closeout commit');

section('J. Package script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('J1', `${SCRIPT} registered`);
else fail('J1', `${SCRIPT} missing from package.json`);

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
