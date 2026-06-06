/**
 * Phase 22 — Closeout verifier for inbound Meta → booking write bridge.
 *
 * Static doc + anchor checks; runs a limited downstream set only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase22-closeout
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'PHASE-22-INBOUND-BOOKING-WRITE-BRIDGE-CLOSEOUT.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase22-closeout';

const DOWNSTREAM = [
  'verify:luna-agent-phase22-booking-write-result-persistence',
  'verify:luna-agent-phase22-inbound-booking-write-preview',
  'verify:luna-agent-phase13-booking-write-bridge',
  'verify:staff-bot-booking-create-api',
];

const ANCHORS = {
  wa_message_id: 'wamid.phase22b.complete.oct.001',
  booking_id: '946cc3ba-70e9-4f9f-a6b8-140ca3d22a79',
  booking_code: 'MB-WOLFHO-20261006-5dbf98',
  payment_id: 'd0bb5fa9-7ecc-43b2-b0d9-181b5687ae0a',
  idempotency_key: 'luna-booking:wolfhouse-somo:wamid.phase22b.complete.oct.001:v1',
  bed_b1: 'DEMO-R1-B1',
  bed_b2: 'DEMO-R1-B2',
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

console.log('\nverify-luna-agent-phase22-closeout.js  (Phase 22 closeout)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'closeout verifier passes node --check');
} catch {
  fail('0', 'closeout verifier syntax error');
}

section('A. Closeout doc exists');

if (fs.existsSync(DOC)) pass('A1', 'PHASE-22-INBOUND-BOOKING-WRITE-BRIDGE-CLOSEOUT.md exists');
else fail('A1', 'closeout doc missing');

const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

section('B. Proof anchors');

docIncludes(doc, ANCHORS.wa_message_id, 'B1', 'includes wa_message_id');
docIncludes(doc, ANCHORS.booking_id, 'B2', 'includes booking_id');
docIncludes(doc, ANCHORS.booking_code, 'B3', 'includes booking_code');
docIncludes(doc, ANCHORS.payment_id, 'B4', 'includes payment_id');
docIncludes(doc, ANCHORS.idempotency_key, 'B5', 'includes idempotency_key');
docIncludes(doc, ANCHORS.bed_b1, 'B6', 'includes DEMO-R1-B1');
docIncludes(doc, ANCHORS.bed_b2, 'B7', 'includes DEMO-R1-B2');

section('C. Proof chain + paths');

docMatches(doc, /22a|Phase 22a/i, 'C1', 'mentions Phase 22a local preview');
docMatches(doc, /22b|Phase 22b/i, 'C2', 'mentions Phase 22b hosted preview');
docMatches(doc, /22c|Phase 22c/i, 'C3', 'mentions Phase 22c hosted gated write');
docMatches(doc, /22d|Phase 22d/i, 'C4', 'mentions Phase 22d result persistence');
docMatches(doc, /Sep 24.*27|2026-09-24|Sep.*blocked|not enough beds/i, 'C5', 'mentions Sep 24–27 blocked / not enough beds');
docMatches(doc, /Oct 6.*9|2026-10-06|Oct.*eligible/i, 'C6', 'mentions Oct 6–9 eligible path');
docIncludes(doc, 'booking_write_preview', 'C7', 'mentions booking_write_preview');
docIncludes(doc, 'booking_write_result', 'C8', 'mentions booking_write_result');
docMatches(doc, /booking-create-from-plan/i, 'C9', 'mentions booking-create-from-plan');
docMatches(doc, /draft deposit|draft.*deposit payment|deposit payment.*draft/i, 'C10', 'mentions draft deposit payment');

section('D. Safety');

docMatches(doc, /no Stripe link|No Stripe link/i, 'D1', 'mentions no Stripe link');
docMatches(doc, /no Stripe API|No Stripe API/i, 'D2', 'mentions no Stripe API');
docMatches(doc, /no WhatsApp send|No WhatsApp send/i, 'D3', 'mentions no WhatsApp send');
docMatches(doc, /no Meta webhook change|No Meta webhook change/i, 'D4', 'mentions no Meta webhook change');
docIncludes(doc, 'no n8n', 'D5', 'mentions no n8n');
docMatches(doc, /env reverted|Env reverted/i, 'D6', 'mentions env reverted');
docMatches(doc, /idempotency replay|idempotent replay/i, 'D7', 'mentions idempotency replay');

section('E. Caveats + recommended next');

docMatches(doc, /created_at.*refresh|refreshes on replay/i, 'E1', 'mentions created_at replay caveat');
docMatches(doc, /Phase 22f|Phase 23|deposit Stripe link|handoff/i, 'E2', 'recommends Phase 22f/23 or handoff');

section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
const rel = 'scripts/verify-luna-agent-phase22-closeout.js';
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
