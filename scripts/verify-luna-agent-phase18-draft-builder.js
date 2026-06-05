/**
 * Phase 18b — Verifier for Luna guest reply draft builder (draft-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase18-draft-builder
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const API    = path.join(__dirname, 'staff-query-api.js');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-reply-draft.js');
const ELIGIBILITY = path.join(__dirname, 'lib', 'luna-guest-reply-send-eligibility.js');
const PKG    = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';

const DOWNSTREAM = [
  'verify:luna-agent-phase18-live-gates-plan',
];

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
  buildLunaGuestReplyDraft,
  DRAFT_SAFETY_FLAGS,
} = require('./lib/luna-guest-reply-draft');
const { ELIGIBILITY_SAFETY_FLAGS } = require('./lib/luna-guest-reply-send-eligibility');

console.log('\nverify-luna-agent-phase18-draft-builder.js  (Phase 18b)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);
const eligibilitySrc = readOrEmpty(ELIGIBILITY);
const apiSrc    = readOrEmpty(API);

const routeIdx   = apiSrc.indexOf("'/staff/bot/guest-reply-draft'");
const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 700) : '';

const handlerStart = apiSrc.indexOf('async function handleBotGuestReplyDraft(');
const handlerEnd   = handlerStart > -1
  ? apiSrc.indexOf('\n// Route: POST /staff/bot/message-intake-preview', handlerStart)
  : -1;
const handler = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

// ─────────────────────────────────────────────────────────────────────────────
section('A. Helper presence and exports');

if (fs.existsSync(HELPER)) pass('A1', 'luna-guest-reply-draft.js exists');
else fail('A1', 'helper file missing');

if (/function\s+buildLunaGuestReplyDraft\s*\(/.test(helperSrc)
  && /module\.exports[^}]*buildLunaGuestReplyDraft/.test(helperSrc)) {
  pass('A2', 'buildLunaGuestReplyDraft exported');
} else {
  fail('A2', 'buildLunaGuestReplyDraft missing or not exported');
}

for (const fn of ['extractLunaGuestMessageIntake', 'validateLunaGuestMessageIntake', 'buildDryRunInputFromIntake', 'runLunaGuestBookingDryRun', 'evaluateLunaGuestReplySendEligibility']) {
  if (helperSrc.includes(fn)) pass('A.dep.' + fn, `helper uses ${fn}`);
  else fail('A.dep.' + fn, `${fn} missing from helper`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Route and handler');

if (routeIdx > -1) pass('B1', 'POST /staff/bot/guest-reply-draft registered');
else fail('B1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('B2', 'POST-only guard');
else fail('B2', 'POST-only guard missing');

if (routeBlock.includes('requireBotAuth')) pass('B3', 'route uses requireBotAuth');
else fail('B3', 'requireBotAuth missing on route');

if (handlerStart > -1) pass('B4', 'handleBotGuestReplyDraft defined');
else fail('B4', 'handler missing');

if (handler.includes('buildLunaGuestReplyDraft')) pass('B5', 'handler calls buildLunaGuestReplyDraft');
else fail('B5', 'handler missing draft builder call');

if (handler.includes('appendAuditLog') && !handler.includes('INSERT INTO')) {
  pass('B6', 'handler uses file audit log only');
} else {
  fail('B6', 'audit pattern unclear');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Draft behavior fixtures');

async function assertDraft(id, input, expect) {
  const draft = await buildLunaGuestReplyDraft(input, { reference_date: REF_DATE });
  const errs = [];

  for (const [flag, val] of Object.entries(DRAFT_SAFETY_FLAGS)) {
    if (draft[flag] !== val) errs.push(`${flag}: expected ${val} got ${draft[flag]}`);
  }

  if (expect.next_action && draft.next_action !== expect.next_action) {
    errs.push(`next_action: expected ${expect.next_action} got ${draft.next_action}`);
  }
  if (expect.suggested_contains && !String(draft.suggested_reply || '').includes(expect.suggested_contains)) {
    errs.push(`suggested_reply missing "${expect.suggested_contains}"`);
  }
  if (expect.suggested_equals && draft.suggested_reply !== expect.suggested_equals) {
    errs.push(`suggested_reply: expected "${expect.suggested_equals}" got "${draft.suggested_reply}"`);
  }
  if (expect.has_dry_run === true && !draft.dry_run_plan) errs.push('dry_run_plan expected');
  if (expect.has_dry_run === false && draft.dry_run_plan) errs.push('dry_run_plan should be null');
  if (expect.handoff && draft.extraction.handoff_required !== true) errs.push('handoff_required expected');

  if (expect.send_eligibility) {
    const se = draft.send_eligibility;
    if (!se || typeof se !== 'object') errs.push('send_eligibility missing');
    else {
      for (const [key, val] of Object.entries(expect.send_eligibility)) {
        if (key === 'blocked_includes') {
          for (const r of val) {
            if (!se.blocked_reasons.includes(r)) errs.push(`send_eligibility.blocked_reasons missing "${r}"`);
          }
        } else if (se[key] !== val) {
          errs.push(`send_eligibility.${key}: expected ${val} got ${se[key]}`);
        }
      }
      for (const [flag, val] of Object.entries(ELIGIBILITY_SAFETY_FLAGS)) {
        if (se[flag] !== val) errs.push(`send_eligibility.${flag}: expected ${val} got ${se[flag]}`);
      }
    }
  }

  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

(async () => {
  await assertDraft('C.en.complete', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550180',
    guest_name: 'Draft Proof Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  }, {
    label: 'EN complete → reply_draft from dry-run',
    next_action: 'show_quote',
    suggested_contains: '€270.00',
    has_dry_run: true,
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: false,
      allowed_send_kind: 'show_quote',
      blocked_includes: ['whatsapp_dry_run_active'],
    },
  });

  await assertDraft('C.it.partial', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550181',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, {
    label: 'IT partial → localized ask_next as suggested_reply',
    next_action: 'ask_missing_field',
    suggested_equals: 'Quali date di check-in e check-out avete in mente?',
    has_dry_run: false,
    send_eligibility: {
      send_allowed_later: true,
      requires_staff: false,
      auto_send_ready: false,
      allowed_send_kind: 'ask_missing_field',
      blocked_includes: ['whatsapp_dry_run_active'],
    },
  });

  await assertDraft('C.handoff', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550182',
    language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  }, {
    label: 'refund/handoff → staff-review acknowledgement',
    next_action: 'handoff_to_staff',
    handoff: true,
    has_dry_run: false,
    suggested_contains: 'team member will review',
    send_eligibility: {
      send_allowed_later: false,
      requires_staff: true,
      auto_send_ready: false,
      allowed_send_kind: null,
      blocked_includes: ['handoff_required'],
    },
  });

  await assertDraft('C.unsupported', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550183',
    language: 'en',
    message_text: '???',
  }, {
    label: 'unsupported → safe fallback draft',
    next_action: 'unsupported',
    has_dry_run: false,
    suggested_contains: 'team will review',
    send_eligibility: {
      send_allowed_later: false,
      requires_staff: true,
      auto_send_ready: false,
      allowed_send_kind: null,
      blocked_includes: ['unsupported_or_low_confidence'],
    },
  });

  // ─────────────────────────────────────────────────────────────────────────
  section('C2. send_eligibility on draft response');

  const withEligibility = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550180',
    guest_name: 'Draft Proof Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  }, { reference_date: REF_DATE });

  if (withEligibility.send_eligibility && typeof withEligibility.send_eligibility === 'object') {
    pass('C2.1', 'draft response includes send_eligibility object');
  } else {
    fail('C2.1', 'send_eligibility missing from draft response');
  }

  if (eligibilitySrc.includes('evaluateLunaGuestReplySendEligibility')) {
    pass('C2.2', 'eligibility helper exists');
  } else {
    fail('C2.2', 'eligibility helper missing');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('D. Safety flags pinned');

  const sample = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    from: '+15555550180',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  }, { reference_date: REF_DATE });

  for (const [flag, val] of Object.entries(DRAFT_SAFETY_FLAGS)) {
    if (sample[flag] === val) pass('D.flag.' + flag, `${flag}=${val}`);
    else fail('D.flag.' + flag, `expected ${flag}=${val} got ${sample[flag]}`);
  }

  if (Array.isArray(sample.blocked_live_actions)
    && sample.blocked_live_actions.includes('whatsapp_send')
    && sample.blocked_live_actions.includes('booking_create')) {
    pass('D.blocked', 'blocked_live_actions includes send/write/stripe/confirmation');
  } else {
    fail('D.blocked', 'blocked_live_actions incomplete');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('E. Forbidden paths (helper + handler)');

  const combined = helperSrc + eligibilitySrc + handler;
  const helperOnly = helperSrc.split('\n').filter((l) => !/^\s*\[['"]/.test(l)).join('\n');

  for (const [id, re, label] of [
    ['E.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
    ['E.create', /booking-create-from-plan|handleBotBookingCreate|runLunaGuestBookingWriteBridge/i, 'booking create/write bridge'],
    ['E.stripe', /createStripe|generate-payment-link|api\.stripe\.com/i, 'Stripe/payment-link'],
    ['E.webhook', /\/staff\/stripe\/webhook/i, 'Stripe webhook'],
    ['E.wa', /sendWhatsApp|whatsapp\.send|graph\.facebook\.com/i, 'WhatsApp send'],
    ['E.n8n', /fetchN8n|activateN8n|triggerN8n/i, 'n8n activation'],
    ['E.confirm', /confirmation_sent_at\s*=/i, 'confirmation_sent_at write'],
  ]) {
    const src = id === 'E.sql' ? combined : helperOnly + handler;
    if (!re.test(src)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  if (!handler.includes('runLunaGuestBookingWriteBridge')
    && !handler.includes('handleBotBookingCreateFromPlan')) {
    pass('E.handler.write', 'handler does not call write bridge');
  } else {
    fail('E.handler.write', 'handler calls write bridge');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('F. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts
    && pkg.scripts['verify:luna-agent-phase18-draft-builder']
      === 'node scripts/verify-luna-agent-phase18-draft-builder.js') {
    pass('F1', 'verify:luna-agent-phase18-draft-builder registered');
  } else {
    fail('F1', 'npm script missing or wrong path');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('G. Downstream (fast plan verifier only)');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      pass('G.' + script, `${script} passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-6).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
