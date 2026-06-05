/**
 * Phase 19 — Verifier for Luna check-in day message builder (compute-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-checkin-day-message
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const HELPER   = path.join(__dirname, 'lib', 'luna-guest-checkin-day-message.js');
const BASELINE = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json');
const PKG      = path.join(ROOT, 'package.json');

const SAFETY = {
  preview_only: true,
  no_write_performed: true,
  sends_whatsapp: false,
  creates_booking: false,
  creates_payment: false,
  creates_stripe_link: false,
  calls_n8n: false,
  updates_confirmation_sent_at: false,
};

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const {
  planLunaCheckinDayMessage,
  buildCheckinDayMessageBody,
  shouldIncludeBalancePaymentLink,
  guestAskedCashOrBankTransfer,
  resolveCheckinDayTemplates,
  CHECKIN_DAY_TEMPLATES,
  CHECKIN_DAY_MESSAGE_RULES,
} = require('./lib/luna-guest-checkin-day-message');
const { buildConfigAlignmentWarnings } = require('./lib/luna-client-messaging-playbook');

console.log('\nverify-luna-agent-phase19-checkin-day-message.js  (Phase 19 check-in day)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);

section('A. Helper exports + templates/rules');

if (fs.existsSync(HELPER)) pass('A1', 'helper exists');
else fail('A1', 'helper missing');

if (/function\s+planLunaCheckinDayMessage\s*\(/.test(helperSrc)) pass('A2', 'planLunaCheckinDayMessage exported');
else fail('A2', 'planLunaCheckinDayMessage missing');

if (CHECKIN_DAY_TEMPLATES.en && CHECKIN_DAY_TEMPLATES.it) pass('A3', 'EN + IT templates present');
else fail('A3', 'templates missing');

for (const key of ['with_payment', 'without_payment']) {
  if (CHECKIN_DAY_TEMPLATES.en[key] && CHECKIN_DAY_TEMPLATES.it[key]) {
    pass('A.tpl.' + key, `${key} template EN+IT`);
  } else {
    fail('A.tpl.' + key, `${key} template missing`);
  }
}

if (CHECKIN_DAY_MESSAGE_RULES.scheduled_local_time === '10:00') {
  pass('A.rules.time', 'scheduled 10:00 local');
} else {
  fail('A.rules.time', 'scheduled time missing');
}

if (CHECKIN_DAY_MESSAGE_RULES.suppress_payment_if_cash_bank_preference) {
  pass('A.rules.payment', 'cash/bank suppress rule present');
} else {
  fail('A.rules.payment', 'payment suppress rule missing');
}

if (/luna-client-messaging-playbook/.test(helperSrc)) {
  pass('A4', 'check-in helper imports playbook loader');
} else {
  fail('A4', 'playbook loader import missing');
}

section('A2. Hold config alignment');

let baseline;
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  pass('A2.h1', 'baseline config parses');
} catch (e) {
  fail('A2.h1', 'baseline parse error: ' + e.message);
  baseline = {};
}

if (baseline.payment && baseline.payment.hold_expiry_minutes === 360) {
  pass('A2.h2', 'baseline hold_expiry_minutes is 360');
} else {
  fail('A2.h2', 'baseline hold_expiry_minutes must be 360');
}

if (baseline.payment && baseline.payment.hold_expiry_hours === 6) {
  pass('A2.h3', 'baseline hold_expiry_hours is 6');
} else {
  fail('A2.h3', 'baseline hold_expiry_hours must be 6');
}

const alignWarnings = buildConfigAlignmentWarnings('wolfhouse-somo');
if (!alignWarnings.some(w => w.code === 'hold_expiry_mismatch')) {
  pass('A2.h4', 'no hold_expiry_mismatch for wolfhouse-somo');
} else {
  fail('A2.h4', 'hold_expiry_mismatch still present after baseline alignment');
}

section('A3. Playbook template wiring');

const tplBundle = resolveCheckinDayTemplates('wolfhouse-somo');
if (tplBundle.playbook_loaded && tplBundle.source === 'messaging_playbook') {
  pass('A3.1', 'check-in templates loaded from messaging playbook');
} else {
  fail('A3.1', 'expected messaging_playbook template source');
}

section('B. Welcome + logistics content');

const enBase = buildCheckinDayMessageBody({
  language: 'en',
  address: 'Calle Test 1, Somo',
  gate_code: '1234#',
  balance_due_cents: 0,
}, {});

for (const phrase of ['Wolfhouse family', 'check-in day', 'surf', 'Somo', 'Address:', 'Gate code:', 'beach']) {
  if (enBase.message_text.includes(phrase)) pass('B.en.' + phrase.replace(/\W+/g, '_'), `EN includes "${phrase}"`);
  else fail('B.en.' + phrase.replace(/\W+/g, '_'), `EN missing "${phrase}"`);
}

const itBase = buildCheckinDayMessageBody({
  language: 'it',
  address: 'Via Test 1, Somo',
  gate_code: '5678#',
  balance_due_cents: 0,
}, {});

if (/famiglia Wolfhouse|check-in|surf|Somo|Indirizzo|Codice cancello/i.test(itBase.message_text)) {
  pass('B.it.content', 'IT welcome + logistics present');
} else {
  fail('B.it.content', 'IT content missing');
}

section('C. Payment link rules');

const withLink = buildCheckinDayMessageBody({
  language: 'en',
  address: 'Calle Test 1',
  gate_code: '1234#',
  balance_due_cents: 5000,
  balance_payment_link: 'https://pay.example/balance',
}, {});

if (withLink.payment_link_included && withLink.message_text.includes('https://pay.example/balance')) {
  pass('C.with_link', 'includes balance link when balance_due > 0');
} else {
  fail('C.with_link', 'payment link not included when expected');
}

const noLinkCash = buildCheckinDayMessageBody({
  language: 'en',
  address: 'Calle Test 1',
  gate_code: '1234#',
  balance_due_cents: 5000,
  balance_payment_link: 'https://pay.example/balance',
  payment_preference_history: [{ message_text: 'Can I pay the balance by bank transfer on arrival?' }],
}, {});

if (!noLinkCash.payment_link_included && !/balance by card|pay\.example/i.test(noLinkCash.message_text)) {
  pass('C.cash_suppress', 'suppresses payment when guest asked bank transfer');
} else {
  fail('C.cash_suppress', 'payment not suppressed after cash/bank ask');
}

if (shouldIncludeBalancePaymentLink({ balance_due_cents: 0 }, {}).include === false) {
  pass('C.zero_balance', 'no link when balance_due zero');
} else {
  fail('C.zero_balance', 'link included with zero balance');
}

if (guestAskedCashOrBankTransfer({ conversation_messages: [{ text: 'I will pay cash on arrival' }] }, {})) {
  pass('C.detect_cash', 'detects cash preference in history');
} else {
  fail('C.detect_cash', 'cash preference not detected');
}

section('D. Message rules / send gates');

const confirmedPlan = planLunaCheckinDayMessage({
  client_slug: 'wolfhouse-somo',
  booking_status: 'confirmed',
  check_in: '2026-09-24',
  language: 'en',
  address: 'Calle Test 1',
  gate_code: '1234#',
  balance_due_cents: 0,
}, {});

if (confirmedPlan.success && confirmedPlan.message_text) pass('D.confirmed', 'builds for confirmed booking');
else fail('D.confirmed', 'confirmed booking plan failed');

if (confirmedPlan.messaging_playbook && confirmedPlan.messaging_playbook.playbook_loaded === true) {
  pass('D.playbook', 'plan includes messaging_playbook.playbook_loaded true');
} else {
  fail('D.playbook', 'messaging_playbook missing from check-in plan');
}

if (confirmedPlan.templates_source === 'messaging_playbook') {
  pass('D.tpl_source', 'templates_source is messaging_playbook');
} else {
  fail('D.tpl_source', 'templates_source should be messaging_playbook');
}

const unconfirmed = planLunaCheckinDayMessage({
  booking_status: 'payment_pending',
  check_in: '2026-09-24',
  language: 'en',
}, {});

if (unconfirmed.blocked_reasons.includes('booking_not_confirmed')) {
  pass('D.unconfirmed', 'blocks non-confirmed booking');
} else {
  fail('D.unconfirmed', 'non-confirmed not blocked');
}

const duplicate = planLunaCheckinDayMessage({
  booking_status: 'confirmed',
  check_in: '2026-09-24',
  checkin_day_sent_at: '2026-09-24T10:00:00Z',
  language: 'en',
}, {});

if (duplicate.blocked_reasons.includes('checkin_day_already_sent')) {
  pass('D.duplicate', 'blocks duplicate send');
} else {
  fail('D.duplicate', 'duplicate not blocked');
}

if (confirmedPlan.blocked_gates.includes('whatsapp_dry_run_active')) {
  pass('D.gates', 'respects live-send gates (dry run active by default)');
} else {
  fail('D.gates', 'gate collection missing');
}

if (confirmedPlan.payment_link_log && confirmedPlan.payment_link_log.reason) {
  pass('D.payment_log', 'logs payment link decision reason');
} else {
  fail('D.payment_log', 'payment link log missing');
}

if (!/\bbed\s*(?:number|#)/i.test(confirmedPlan.message_text || '')) {
  pass('D.no_bed', 'message excludes bed number');
} else {
  fail('D.no_bed', 'bed number leaked');
}

const withRoom = buildCheckinDayMessageBody({
  language: 'en',
  address: 'Calle Test 1',
  gate_code: '1234#',
  room_number: 'R2',
  room_assigned: true,
  balance_due_cents: 0,
}, {});

if (withRoom.message_text.includes('Room: R2')) pass('D.room', 'includes room when assigned');
else fail('D.room', 'room number missing when assigned');

section('E. Safety flags + forbidden paths');

for (const [flag, val] of Object.entries(SAFETY)) {
  if (confirmedPlan[flag] === val) pass('E.flag.' + flag, `${flag}=${val}`);
  else fail('E.flag.' + flag, `expected ${flag}=${val}`);
}

const helperOnly = helperSrc.split('\n').filter((l) => !/^\s*\[['"]/.test(l)).join('\n');
for (const [id, re, label] of [
  ['E.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
  ['E.write', /runLunaGuestBookingWriteBridge|booking-create-from-plan/i, 'booking write bridge'],
  ['E.stripe', /createStripe\s*\(|api\.stripe\.com/i, 'Stripe API calls'],
  ['E.webhook', /\/staff\/stripe\/webhook/i, 'Stripe webhook'],
  ['E.wa', /sendWhatsApp\s*\(|graph\.facebook\.com/i, 'WhatsApp send'],
  ['E.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation'],
  ['E.confirm', /confirmation_sent_at\s*=/i, 'confirmation_sent_at update'],
]) {
  if (!re.test(helperOnly)) pass(id, `no ${label}`);
  else fail(id, `${label} detected`);
}

section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase19-checkin-day-message']
    === 'node scripts/verify-luna-agent-phase19-checkin-day-message.js') {
  pass('F1', 'npm script registered');
} else {
  fail('F1', 'npm script missing');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
