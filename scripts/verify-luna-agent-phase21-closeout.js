/**
 * Phase 21 — Closeout verifier for Luna remaining balance payment truth.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase21-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-21-LUNA-BALANCE-PAYMENT-TRUTH-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase21-closeout';

const DOWNSTREAM = [
  'verify:staff-stripe-webhook-api',
  'verify:luna-agent-phase20-closeout',
  'verify:luna-agent-phase20-send-confirmation-route',
];

const ANCHORS = {
  booking_id: '828538c7-c6cb-4c6f-b45a-57a641af37cc',
  booking_code: 'MB-WOLFHO-20260924-e90132',
  deposit_payment_id: '7659e304-64d4-47cf-82b9-4be1e37ac913',
  balance_payment_id: 'cec96e1f-2d07-4b26-9cdd-0273d763bb96',
  stripe_session_id: 'cs_test_a15ktjXydVOC9XDlskWqSQKJ2AiJqvrevC2hz2PBMK2qKyAgmTHDRrt0g6',
  webhook_event_id: 'evt_phase21a_1780751146736',
  confirmation_sent_at: '2026-06-06T13:01:07.422Z',
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

function docMatches(text, pattern, id, label) {
  if (pattern.test(text)) pass(id, label);
  else fail(id, `${label} — pattern not found`);
}

console.log('\nverify-luna-agent-phase21-closeout.js  (Phase 21 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-21-LUNA-BALANCE-PAYMENT-TRUTH-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Proof anchors');

docIncludes(doc, ANCHORS.booking_id, 'B1', 'includes booking_id');
docIncludes(doc, ANCHORS.booking_code, 'B2', 'includes booking_code');
docIncludes(doc, ANCHORS.deposit_payment_id, 'B3', 'includes deposit payment_id');
docIncludes(doc, ANCHORS.balance_payment_id, 'B4', 'includes balance payment_id');
docIncludes(doc, ANCHORS.stripe_session_id, 'B5', 'includes Stripe checkout session id');
docIncludes(doc, ANCHORS.webhook_event_id, 'B6', 'includes webhook fixture event id');
docIncludes(doc, ANCHORS.confirmation_sent_at, 'B7', 'includes confirmation_sent_at');

section('C. Before / after transitions');

docMatches(doc, /checkout_created.*paid|checkout_created → paid/i, 'C1', 'mentions checkout_created → paid');
docMatches(doc, /deposit_paid.*paid|deposit_paid → paid/i, 'C2', 'mentions deposit_paid → paid');
docIncludes(doc, '17000', 'C3', 'mentions balance_due_cents 17000');
docIncludes(doc, '27000', 'C4', 'mentions amount_paid_cents 27000');
docMatches(doc, /balance_due_cents.*0|17000 → 0|17000.*\*\*0\*\*/i, 'C5', 'mentions balance_due_cents 17000 → 0');
docMatches(doc, /confirmation_sent_at.*unchanged|unchanged.*confirmation_sent_at/i, 'C6', 'mentions confirmation_sent_at unchanged');

section('D. Safety');

docMatches(doc, /no WhatsApp send|No WhatsApp send/i, 'D1', 'mentions no WhatsApp send');
docMatches(doc, /no confirmation resend|No confirmation resend/i, 'D2', 'mentions no confirmation resend');
docIncludes(doc, 'no n8n', 'D3', 'mentions no n8n');
docMatches(doc, /Meta webhook|no Meta webhook change/i, 'D4', 'mentions Meta webhook safety');
docMatches(doc, /no env changes|No env changes|env unchanged/i, 'D5', 'mentions no env changes');
docMatches(doc, /double-count|no double-count|idempotent/i, 'D6', 'mentions no double-count');

section('E. Caveats + Phase 22');

docMatches(doc, /signed fixture|Signed fixture/i, 'E1', 'mentions signed fixture caveat');
docMatches(doc, /Phase 22|inbound Meta.*booking write|Meta → gated booking write/i, 'E2', 'recommends Phase 22 inbound Meta → booking write bridge');

section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase21-closeout.js';
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
