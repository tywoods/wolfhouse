/**
 * Phase 20 — Closeout verifier for Luna booking / payment / confirmation chain.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase20-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-20-LUNA-BOOKING-PAYMENT-CONFIRMATION-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase20-closeout';

const DOWNSTREAM = [
  'verify:luna-agent-phase20-send-confirmation-route',
  'verify:luna-agent-phase20-confirmation-preview-playbook',
  'verify:staff-stripe-webhook-api',
  'verify:staff-generate-payment-link',
  'verify:luna-agent-phase13-booking-write-bridge',
];

const ANCHORS = {
  booking_id: '828538c7-c6cb-4c6f-b45a-57a641af37cc',
  booking_code: 'MB-WOLFHO-20260924-e90132',
  deposit_payment_id: '7659e304-64d4-47cf-82b9-4be1e37ac913',
  balance_payment_id: 'cec96e1f-2d07-4b26-9cdd-0273d763bb96',
  guest_message_send_id: 'a3676eb7-09e7-41c3-b5ba-3fcdbc05c2e6',
  provider_message_id: 'wamid.HBgMNDkxNzI2NDIyMzA3FQIAERgSNTU2QUMyQTczRUNBQkNFNUU5AA==',
  confirmation_sent_at: '2026-06-06T13:01:07.422Z',
  safe_revision: 'stage20j-backfill-safe',
};

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function docIncludes(text, needle, id, label) {
  if (text.includes(needle)) pass(id, label);
  else fail(id, `${label} — missing: ${String(needle).slice(0, 72)}`);
}

console.log('\nverify-luna-agent-phase20-closeout.js  (Phase 20 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-20-LUNA-BOOKING-PAYMENT-CONFIRMATION-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Proof anchors');

docIncludes(doc, ANCHORS.booking_id, 'B1', 'includes booking_id');
docIncludes(doc, ANCHORS.booking_code, 'B2', 'includes booking_code');
docIncludes(doc, ANCHORS.deposit_payment_id, 'B3', 'includes deposit payment_id');
docIncludes(doc, ANCHORS.balance_payment_id, 'B4', 'includes balance payment_id');
docIncludes(doc, ANCHORS.guest_message_send_id, 'B5', 'includes confirmation guest_message_send_id');
docIncludes(doc, ANCHORS.provider_message_id, 'B6', 'includes provider_message_id');
docIncludes(doc, ANCHORS.confirmation_sent_at, 'B7', 'includes confirmation_sent_at');
docIncludes(doc, ANCHORS.safe_revision, 'B8', 'includes safe staging revision');

section('C. Chain coverage');

docIncludes(doc, 'booking write', 'C1', 'mentions booking write');
docIncludes(doc, 'Stripe Checkout', 'C2', 'mentions Stripe Checkout link');
docIncludes(doc, 'webhook payment truth', 'C3', 'mentions Stripe webhook payment truth');
docIncludes(doc, 'confirmation preview', 'C4', 'mentions Cami confirmation preview');
docIncludes(doc, 'WhatsApp confirmation send', 'C5', 'mentions WhatsApp confirmation send');
docIncludes(doc, 'confirmation_sent_at', 'C6', 'mentions confirmation_sent_at backfill');
docIncludes(doc, 'idempotent_replay_backfill', 'C7', 'mentions idempotent replay backfill');
docIncludes(doc, 'idempotency', 'C8', 'mentions idempotency replay');

section('D. Safety + env baseline');

docIncludes(doc, 'WHATSAPP_DRY_RUN', 'D1', 'mentions safe env baseline WHATSAPP_DRY_RUN');
docIncludes(doc, 'STRIPE_LINKS_ENABLED', 'D2', 'mentions STRIPE_LINKS_ENABLED');
docIncludes(doc, 'no n8n', 'D3', 'mentions no n8n');
docIncludes(doc, 'Meta webhook', 'D4', 'mentions Meta webhook');
docIncludes(doc, 'live-send gates reverted', 'D5', 'mentions live gates reverted');
docIncludes(doc, 'checkout_created', 'D6', 'mentions balance payment still checkout_created');

section('E. Phase 21 recommendations');

if (/Phase 21|balance payment webhook|check-in day/i.test(doc)) {
  pass('E1', 'documents recommended Phase 21 options');
} else {
  fail('E1', 'Phase 21 recommendations missing');
}

section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase20-closeout.js';
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) {
  pass('F1', `${SCRIPT} registered`);
} else {
  fail('F1', `${SCRIPT} missing or wrong path`);
}

if (fs.existsSync(path.join(ROOT, rel))) pass('F2', 'closeout script file exists');
else fail('F2', 'closeout script file missing');

section('G. Downstream verifiers (limited)');

for (const script of DOWNSTREAM) {
  try {
    execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    pass('G.' + script, `${script} still passes`);
  } catch (e) {
    fail('G.' + script, `${script} failed`);
    const out = (e.stdout || '') + (e.stderr || '');
    console.error(out.split('\n').slice(-10).join('\n'));
  }
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
