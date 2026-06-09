/**
 * Stage 27demo-a — Static verifier for open WhatsApp + Stripe TEST demo design lock.
 *
 * Docs-only checks — no runtime, no DB, no API calls.
 *
 * Usage:
 *   npm run verify:stage27demo-a-open-whatsapp-stripe-design
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage27demo-a-open-whatsapp-stripe-design';

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

console.log('\nverify-stage27demo-a-open-whatsapp-stripe-design.js  (Stage 27demo-a design lock)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'design verifier passes node --check');
} catch {
  fail('0', 'design verifier syntax error');
}

section('A. Doc exists');

if (fs.existsSync(DOC)) pass('A1', 'STAGE-27DEMO-A-OPEN-WHATSAPP-BOOKING-STRIPE-DEMO-DESIGN.md exists');
else fail('A1', 'design doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Open demo gate');

docMatches(doc, /no phone allowlist|not allowlist|No Ty\/Ale\/Cami allowlist/i, 'B1', 'states no phone allowlist for demo');
docMatches(doc, /anyone.*demo|Anyone.*demo|Anyone who has the demo/i, 'B2', 'states anyone with demo number can message');
docMatches(doc, /production.*automation.*off|production guest automation|Production automation.*OFF/i, 'B3', 'states production automation remains off');
docIncludes(doc, '51977c6', 'B4', 'references stability baseline 51977c6-stage27test-t1-pg-pool');
docMatches(doc, /DESIGN LOCK|docs only/i, 'B5', 'design lock / docs-only status');

section('C. Architecture');

docMatches(doc, /Staff API.*brain|Staff API.*Brain/i, 'C1', 'Staff API is brain');
docMatches(doc, /n8n.*pipe|n8n.*Pipe/i, 'C2', 'n8n is pipe only');
docIncludes(doc, 'guest-inbound-review-dry-run', 'C3', 'covers inbound Staff API route');
docIncludes(doc, 'wolfhouse-somo', 'C4', 'client_slug wolfhouse-somo');
docIncludes(doc, 'inbound_message_id', 'C5', 'inbound_message_id / wamid idempotency');
docIncludes(doc, 'idempotency_key', 'C6', 'idempotency_key');

section('D. Booking + calendar');

docMatches(doc, /hold.*draft|hold \+ draft/i, 'D1', 'covers booking hold + draft write');
docMatches(doc, /Booking Calendar|booking calendar/i, 'D2', 'covers Staff Portal booking calendar proof');
docMatches(doc, /checkout_created|deposit_paid|payment_status/i, 'D3', 'covers before/after payment status');

section('E. Outbound WhatsApp');

docMatches(doc, /WHATSAPP_DRY_RUN/i, 'E1', 'covers WHATSAPP_DRY_RUN gate');
docMatches(doc, /live WhatsApp|live reply|outbound WhatsApp/i, 'E2', 'covers outbound WhatsApp policy');
docMatches(doc, /kill switch|Kill switch/i, 'E3', 'covers live-send kill switch');

section('F. Stripe TEST');

docMatches(doc, /sk_test_/i, 'F1', 'states sk_test_ required');
docMatches(doc, /live Stripe.*forbidden|No live Stripe|sk_live/i, 'F2', 'states live Stripe is forbidden');
docIncludes(doc, 'STRIPE_LINKS_ENABLED', 'F3', 'covers STRIPE_LINKS_ENABLED');
docMatches(doc, /webhook.*payment truth|payment truth.*webhook|Stripe webhook/i, 'F4', 'Stripe webhook/payment truth is source of truth');
docMatches(doc, /must not.*payment received|payment received.*chat|no payment-received claims/i, 'F5', 'Luna must not claim payment from chat');

section('G. Safety + abuse');

docMatches(doc, /rollback|Disable demo|kill switch/i, 'G1', 'covers safety/rollback');
docMatches(doc, /abuse|spam/i, 'G2', 'covers abuse/spam considerations');
docMatches(doc, /production DB|No production DB|never.*production/i, 'G3', 'must not touch production DB');

section('H. Implementation sequence');

docIncludes(doc, '27demo-b', 'H1', '27demo-b n8n inbound pipe');
docIncludes(doc, '27demo-c', 'H2', '27demo-c live reply proof');
docIncludes(doc, '27demo-d', 'H3', '27demo-d booking write + calendar');
docIncludes(doc, '27demo-e', 'H4', '27demo-e Stripe TEST link + payment truth');
docIncludes(doc, '27demo-f', 'H5', '27demo-f optional confirmation');

section('I. No runtime changes (design lock)');

const FORBIDDEN_DEMO_RUNTIME = [
  'scripts/lib/luna-open-demo-whatsapp-inbound.js',
  'scripts/lib/luna-open-demo-live-send.js',
];
let forbiddenFound = false;
for (const rel of FORBIDDEN_DEMO_RUNTIME) {
  if (fs.existsSync(path.join(ROOT, rel))) {
    fail('I1', `demo runtime file exists before implementation slice: ${rel}`);
    forbiddenFound = true;
  }
}
if (!forbiddenFound) pass('I1', 'no 27demo runtime modules shipped in design lock');
docMatches(doc, /No runtime code|docs only/i, 'I2', 'doc states no runtime code in 27demo-a');

section('J. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('J1', `${SCRIPT} registered`);
else fail('J1', `${SCRIPT} npm script missing`);

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
