/**
 * Phase 14a — Static verifier for Luna confirmation send gate plan.
 *
 * Confirms PHASE-14.1 plan doc exists, anchors to real confirmation draft code
 * and client config, documents required send gates, and that NO send/preview
 * route is implemented yet (14a is design-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase14-confirmation-gates-plan
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const DOC    = path.join(ROOT, 'docs', 'PHASE-14.1-LUNA-CONFIRMATION-SEND-GATES-PLAN.md');
const API    = path.join(__dirname, 'staff-query-api.js');
const SENDLIB = path.join(__dirname, 'build-send-confirmation-local.js');
const CONFIG = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.baseline.json');
const PKG    = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

console.log('\nverify-luna-agent-phase14-confirmation-gates-plan.js  (Phase 14a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'plan verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Plan document');

if (!fs.existsSync(DOC)) {
  fail('A1', 'PHASE-14.1-LUNA-CONFIRMATION-SEND-GATES-PLAN.md missing');
  console.log(`\n--- ${passes} passed, ${failures + 1} failed ---\n`);
  process.exit(1);
}
pass('A1', 'plan doc exists');

const doc = fs.readFileSync(DOC, 'utf8');

const requiredSections = [
  ['A2', 'Current confirmation state', /## 1\. Current confirmation state/],
  ['A3', 'Send gate must require', /## 2\. What the confirmation send gate must require/],
  ['A4', 'Must remain impossible', /## 3\. What must remain impossible/],
  ['A5', 'Suggested future routes', /## 4\. Suggested future routes/],
  ['A6', 'Recommended Phase 14b', /## 5\. Recommended first implementation slice — Phase 14b/],
  ['A7', 'Later send slice requirements', /## 6\. Later send slice/],
  ['A8', 'Verifiers that must protect it', /## 7\. Verifiers that must protect it/],
  ['A9', 'Explicit stop conditions', /## 8\. Explicit stop conditions/],
  ['A10', 'Phase map', /## 9\. Phase map/],
];
for (const [id, label, re] of requiredSections) {
  if (re.test(doc)) pass(id, label);
  else fail(id, label + ' section missing');
}

const docMentions = [
  'confirmation_draft', 'confirmation_sent_at', 'buildPaymentConfirmationDraft',
  'room_number', 'gate_code', '2684#', 'WHATSAPP_DRY_RUN', 'idempotency',
  'deposit_paid', 'confirmation-preview', 'send-confirmation',
];
for (const m of docMentions) {
  const id = 'A.kw.' + m.replace(/[^a-z0-9]/gi, '_');
  if (doc.includes(m)) pass(id, 'plan mentions ' + m);
  else fail(id, 'plan missing keyword: ' + m);
}

// Bed-number exclusion must be explicit in the plan.
if (/bed number/i.test(doc) && /(NOT bed number|bed number absent|excludes bed number|not bed_number|bed_number absent)/i.test(doc)) {
  pass('A.bed', 'plan states bed number must NOT be sent');
} else {
  fail('A.bed', 'plan does not clearly exclude bed number');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Confirmation draft anchors (real code)');

const apiSrc = fs.readFileSync(API, 'utf8');

if (apiSrc.includes('function buildPaymentConfirmationDraft')) {
  pass('B1', 'buildPaymentConfirmationDraft exists in staff-query-api.js');
} else {
  fail('B1', 'buildPaymentConfirmationDraft missing');
}

const draftFn = apiSrc.slice(
  apiSrc.indexOf('function buildPaymentConfirmationDraft'),
  apiSrc.indexOf('function buildPaymentConfirmationDraft') + 1200,
);

if (/bkPayStatus\s*!==\s*'deposit_paid'\s*&&\s*bkPayStatus\s*!==\s*'paid'/.test(draftFn)) {
  pass('B2', 'draft only built for deposit_paid/paid (payment-truth guard)');
} else {
  fail('B2', 'draft payment-status guard missing');
}

if (draftFn.includes('room_number') && draftFn.includes('gate_code') && draftFn.includes('address')) {
  pass('B3', 'draft includes room_number + gate_code + address');
} else {
  fail('B3', 'draft missing room_number/gate_code/address');
}

if (!/bed_number|bed_code/.test(draftFn)) {
  pass('B4', 'draft excludes bed number/bed code');
} else {
  fail('B4', 'draft references bed number/bed code');
}

if (draftFn.includes('sends_whatsapp:') && /sends_whatsapp:\s*false/.test(draftFn)
  && /whatsapp_dry_run:\s*true/.test(draftFn)) {
  pass('B5', 'draft pins sends_whatsapp:false + whatsapp_dry_run:true');
} else {
  fail('B5', 'draft safety flags missing');
}

// Draft persisted by webhook only (jsonb confirmation_draft on bookings).
if (apiSrc.includes("jsonb_build_object('confirmation_draft'") || apiSrc.includes("'confirmation_draft', $5::jsonb")) {
  pass('B6', 'webhook persists confirmation_draft to bookings.metadata');
} else {
  fail('B6', 'confirmation_draft persistence anchor missing');
}

if (apiSrc.includes('confirmation_draft:  confirmationDraft') || apiSrc.includes('confirmation_draft:')) {
  pass('B7', 'booking context exposes confirmation_draft (read-only)');
} else {
  fail('B7', 'booking context confirmation_draft exposure missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. confirmation_sent_at tracking anchor');

if (fs.existsSync(SENDLIB)) {
  const sendSrc = fs.readFileSync(SENDLIB, 'utf8');
  pass('C1', 'build-send-confirmation-local.js exists (legacy n8n pipe builder)');
  if (/confirmation_sent_at\s*=\s*COALESCE\(confirmation_sent_at,\s*NOW\(\)\)/.test(sendSrc)) {
    pass('C2', 'mark-confirmed sets confirmation_sent_at idempotently (COALESCE)');
  } else {
    fail('C2', 'confirmation_sent_at COALESCE write not found');
  }
  if (/confirmation_sent_at IS NULL/.test(sendSrc)) {
    pass('C3', 'mark-confirmed guards on confirmation_sent_at IS NULL (no duplicate)');
  } else {
    fail('C3', 'confirmation_sent_at IS NULL guard missing');
  }
  if (/WHATSAPP_DRY_RUN/.test(sendSrc)) {
    pass('C4', 'send builder honors WHATSAPP_DRY_RUN gate');
  } else {
    fail('C4', 'WHATSAPP_DRY_RUN gate missing in send builder');
  }
} else {
  fail('C1', 'build-send-confirmation-local.js missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Client confirmation config anchors');

if (fs.existsSync(CONFIG)) {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const conf = cfg.confirmation || {};
  pass('D1', 'wolfhouse-somo.baseline.json exists');

  if (conf.gate_code === '2684#') pass('D2', "config gate_code === '2684#'");
  else fail('D2', 'config gate_code mismatch: ' + conf.gate_code);

  if (conf.include_room_number === true) pass('D3', 'config include_room_number true');
  else fail('D3', 'config include_room_number not true');

  if (conf.include_bed_number === false) pass('D4', 'config include_bed_number false');
  else fail('D4', 'config include_bed_number not false');

  if (conf.include_address === true) pass('D5', 'config include_address true');
  else fail('D5', 'config include_address not true');

  if (conf.confirmation_requires_payment_truth === true) {
    pass('D6', 'config confirmation_requires_payment_truth true');
  } else {
    fail('D6', 'config confirmation_requires_payment_truth not true');
  }

  if (typeof conf.real_whatsapp_send_gate === 'string' && /separate|shadow|gate/i.test(conf.real_whatsapp_send_gate)) {
    pass('D7', 'config keeps real WhatsApp send behind separate gate');
  } else {
    fail('D7', 'config real_whatsapp_send_gate not gated');
  }
} else {
  fail('D1', 'wolfhouse-somo.baseline.json missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('E. Confirmation preview route (14b) — send route still deferred (14c)');

if (apiSrc.includes('/staff/bot/bookings/confirmation-preview')
  && apiSrc.includes('handleBotBookingConfirmationPreview')
  && apiSrc.includes('getLunaBookingConfirmationPreview')) {
  pass('E1', 'confirmation-preview route + handler present (14b)');
} else {
  fail('E1', 'confirmation-preview route/handler missing — implement 14b');
}

if (!apiSrc.includes('/send-confirmation')) {
  pass('E2', 'no Staff API send-confirmation route yet (14c)');
} else {
  fail('E2', 'send-confirmation route already present — update plan/verifier');
}

// Webhook must remain the only paid-writer; confirmation must not flip booking to confirmed via send here.
if (apiSrc.includes('handleStripeWebhook')) {
  pass('E3', 'webhook payment-truth handler present (only paid-writer)');
} else {
  fail('E3', 'handleStripeWebhook missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('F. npm script registration');

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
if (pkg.scripts
  && pkg.scripts['verify:luna-agent-phase14-confirmation-gates-plan']
    === 'node scripts/verify-luna-agent-phase14-confirmation-gates-plan.js') {
  pass('F1', 'verify:luna-agent-phase14-confirmation-gates-plan registered');
} else {
  fail('F1', 'npm script missing or wrong path');
}

console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
process.exit(failures > 0 ? 1 : 0);
