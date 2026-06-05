/**
 * Phase 19c.1 — Verifier for Luna check-in day preview route (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-checkin-day-preview
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API  = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-checkin-day-message.js');
const PKG  = path.join(ROOT, 'package.json');

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

const { planLunaCheckinDayMessage } = require('./lib/luna-guest-checkin-day-message');

console.log('\nverify-luna-agent-phase19-checkin-day-preview.js  (Phase 19c.1)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const apiSrc = readOrEmpty(API);
const routeIdx = apiSrc.indexOf("'/staff/bot/checkin-day-preview'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';
const handlerStart = apiSrc.indexOf('async function handleBotCheckinDayPreview(');
const handlerEnd = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/guest-reply-draft', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

section('A. Route + handler');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/checkin-day-preview registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('A3', 'route uses requireBotAuth');
else fail('A3', 'requireBotAuth missing');

if (handler.includes('planLunaCheckinDayMessage')) pass('A4', 'handler calls planLunaCheckinDayMessage');
else fail('A4', 'planLunaCheckinDayMessage missing from handler');

if (handler.includes('buildBotCheckinDayPreviewInput')) pass('A5', 'preview input builder present');
else fail('A5', 'buildBotCheckinDayPreviewInput missing');

if (handler.includes('message_preview') && handler.includes('checkin_day_plan')) {
  pass('A6', 'response includes message_preview + checkin_day_plan');
} else {
  fail('A6', 'response shape incomplete');
}

section('B. Preview fixtures (preview_context-only)');

function buildPreviewInput(body) {
  const src = body || {};
  const preview = src.preview_context || {};
  const history = preview.conversation_history || preview.conversation_messages || [];
  return {
    client_slug: src.client_slug || preview.client_slug || 'wolfhouse-somo',
    booking_status: preview.booking_status || 'confirmed',
    check_in: preview.check_in,
    guest_name: preview.guest_name,
    language: preview.language || 'en',
    payment_status: preview.payment_status,
    balance_due_cents: preview.balance_due_cents,
    balance_payment_link: preview.balance_payment_link,
    address: preview.address,
    gate_code: preview.gate_code,
    room_number: preview.room_number,
    room_assigned: preview.room_assigned ?? (preview.room_number ? true : undefined),
    conversation_messages: history,
    payment_preference_history: preview.payment_preference_history || history,
  };
}

function wrapRouteResponse(plan) {
  return {
    success: plan.success === true,
    ...SAFETY,
    checkin_day_plan: plan,
    message_preview: plan.message_text || null,
    payment_link_log: plan.payment_link_log || null,
    messaging_playbook: plan.messaging_playbook || null,
  };
}

const enBody = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Preview Guest',
    language: 'en',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    room_number: 'DEMO-R1',
    conversation_history: [],
  },
};

const enPlan = planLunaCheckinDayMessage(buildPreviewInput(enBody));
const enOut = wrapRouteResponse(enPlan);

if (enOut.success && enOut.message_preview.includes('https://example.test/pay-balance')) {
  pass('B.en.link', 'EN with balance due includes payment link');
} else {
  fail('B.en.link', 'EN payment link missing');
}

for (const phrase of ['Wolfhouse family', 'surf', 'beach', 'arrival']) {
  if (enOut.message_preview.includes(phrase) || /arrival time|flight info/i.test(enOut.message_preview)) {
    pass('B.en.' + phrase, `EN includes ${phrase} or arrival logistics`);
  } else {
    fail('B.en.' + phrase, `EN missing ${phrase}/arrival logistics`);
  }
}

if (enOut.messaging_playbook && enOut.messaging_playbook.playbook_loaded === true) {
  pass('B.en.playbook', 'EN messaging_playbook.playbook_loaded true');
} else {
  fail('B.en.playbook', 'messaging_playbook missing');
}

if (enOut.checkin_day_plan.templates_source === 'messaging_playbook') {
  pass('B.en.tpl', 'templates_source messaging_playbook');
} else {
  fail('B.en.tpl', 'templates_source should be messaging_playbook');
}

const itBody = {
  client_slug: 'wolfhouse-somo',
  preview_context: {
    guest_name: 'Ospite Preview',
    language: 'it',
    check_in: '2026-09-24',
    payment_status: 'deposit_paid',
    balance_due_cents: 17000,
    balance_payment_link: 'https://example.test/pay-balance-it',
    address: 'C. Mies de La Ran, 41, 39140 Somo, Cantabria',
    gate_code: '2684#',
    conversation_history: [
      { text: 'Posso pagare il saldo con bonifico all\'arrivo?' },
    ],
  },
};

const itPlan = planLunaCheckinDayMessage(buildPreviewInput(itBody));
const itOut = wrapRouteResponse(itPlan);

if (!itOut.checkin_day_plan.payment_link_included
  && !/pay-balance|carta|card/i.test(itOut.message_preview || '')) {
  pass('B.it.suppress', 'IT suppresses payment after cash/bank ask');
} else {
  fail('B.it.suppress', 'IT should suppress payment text/link');
}

if (/famiglia Wolfhouse|Wolfhouse/i.test(itOut.message_preview || '')) {
  pass('B.it.welcome', 'IT still includes Wolfhouse welcome');
} else {
  fail('B.it.welcome', 'IT welcome missing');
}

if (!/\bbed\s*(?:number|#)/i.test(enOut.message_preview || '')) {
  pass('B.no_bed', 'message excludes bed number');
} else {
  fail('B.no_bed', 'bed number leaked');
}

section('C. Safety');

for (const [flag, val] of Object.entries(SAFETY)) {
  if (enOut[flag] === val) pass('C.' + flag, `${flag}=${val}`);
  else fail('C.' + flag, `expected ${flag}=${val}`);
}

const handlerOnly = handler.split('\n').filter((l) => !/^\s*\[['"]/.test(l)).join('\n');
for (const [id, re, label] of [
  ['C.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
  ['C.stripe', /createStripe\s*\(|api\.stripe\.com/i, 'Stripe API calls'],
  ['C.wa', /sendWhatsApp\s*\(|graph\.facebook\.com/i, 'WhatsApp send'],
  ['C.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation'],
]) {
  if (!re.test(handlerOnly)) pass(id, `handler has no ${label}`);
  else fail(id, `${label} in handler`);
}

section('D. npm script');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-checkin-day-preview']) {
  pass('D1', 'npm script registered');
} else {
  fail('D1', 'npm script missing');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
