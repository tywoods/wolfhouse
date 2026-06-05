/**
 * Phase 18c — Verifier for Luna guest reply send eligibility (read-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase18-send-eligibility
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-reply-send-eligibility.js');
const PKG    = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';

const DOWNSTREAM = [
  'verify:luna-agent-phase18-draft-builder',
  'verify:luna-agent-phase18-live-gates-plan',
  'verify:luna-agent-phase17-closeout',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
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

const { evaluateLunaGuestReplySendEligibility, ELIGIBILITY_SAFETY_FLAGS } = require('./lib/luna-guest-reply-send-eligibility');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');

console.log('\nverify-luna-agent-phase18-send-eligibility.js  (Phase 18c)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);

section('A. Helper presence and exports');

if (fs.existsSync(HELPER)) pass('A1', 'luna-guest-reply-send-eligibility.js exists');
else fail('A1', 'helper file missing');

if (/function\s+evaluateLunaGuestReplySendEligibility\s*\(/.test(helperSrc)
  && /module\.exports[^}]*evaluateLunaGuestReplySendEligibility/.test(helperSrc)) {
  pass('A2', 'evaluateLunaGuestReplySendEligibility exported');
} else {
  fail('A2', 'evaluateLunaGuestReplySendEligibility missing or not exported');
}

section('B. Eligible future auto-reply cases (no send now)');

function assertEligibility(id, draft, input, env, expect) {
  const result = evaluateLunaGuestReplySendEligibility(draft, input, env);
  const errs = [];

  for (const [flag, val] of Object.entries(ELIGIBILITY_SAFETY_FLAGS)) {
    if (result[flag] !== val) errs.push(`${flag}: expected ${val} got ${result[flag]}`);
  }

  for (const [key, val] of Object.entries(expect)) {
    if (key === 'label' || key === 'blocked_includes' || key === 'blocked_excludes') continue;
    if (result[key] !== val) errs.push(`${key}: expected ${val} got ${result[key]}`);
  }

  if (expect.blocked_includes) {
    for (const r of expect.blocked_includes) {
      if (!result.blocked_reasons.includes(r)) errs.push(`blocked_reasons missing "${r}"`);
    }
  }
  if (expect.blocked_excludes) {
    for (const r of expect.blocked_excludes) {
      if (result.blocked_reasons.includes(r)) errs.push(`blocked_reasons should not include "${r}"`);
    }
  }

  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

(async () => {
  const itDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550181',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, { reference_date: REF_DATE });

  assertEligibility('B.it.missing_field', itDraft, itDraft, { WHATSAPP_DRY_RUN: 'true' }, {
    label: 'IT missing-field draft eligible later, not now',
    send_allowed_later: true,
    auto_send_ready: false,
    requires_staff: false,
    allowed_send_kind: 'ask_missing_field',
    blocked_includes: ['whatsapp_dry_run_active'],
  });

  const enDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550180',
    guest_name: 'Draft Proof EN Complete',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu? We can pay the deposit.',
  }, { reference_date: REF_DATE });

  assertEligibility('B.en.show_quote', enDraft, enDraft, { WHATSAPP_DRY_RUN: 'true' }, {
    label: 'EN complete quote eligible later, not now',
    send_allowed_later: true,
    auto_send_ready: false,
    requires_staff: false,
    allowed_send_kind: 'show_quote',
    blocked_includes: ['whatsapp_dry_run_active'],
  });

  section('C. Blocked / staff-required cases');

  const handoffDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550182',
    language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  }, { reference_date: REF_DATE });

  assertEligibility('C.handoff', handoffDraft, handoffDraft, {}, {
    label: 'refund/handoff blocked, requires staff',
    send_allowed_later: false,
    auto_send_ready: false,
    requires_staff: true,
    allowed_send_kind: null,
    blocked_includes: ['handoff_required', 'risky_message_keywords'],
  });

  const unsupportedDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550183',
    language: 'en',
    message_text: '???',
  }, { reference_date: REF_DATE });

  assertEligibility('C.unsupported', unsupportedDraft, unsupportedDraft, {}, {
    label: 'low-confidence unsupported blocked',
    send_allowed_later: false,
    requires_staff: true,
    blocked_includes: ['unsupported_or_low_confidence'],
  });

  assertEligibility('C.missing_reply', {
    next_action: 'ask_missing_field',
    suggested_reply: '',
    extraction: { handoff_required: false },
    dry_run_plan: null,
  }, {}, {}, {
    label: 'missing suggested_reply blocked',
    send_allowed_later: false,
    requires_staff: true,
    blocked_includes: ['missing_suggested_reply'],
  });

  assertEligibility('C.dry_run_handoff', {
    next_action: 'show_quote',
    suggested_reply: 'Checking with the team.',
    extraction: { handoff_required: false },
    dry_run_plan: {
      next_action: 'handoff_to_staff',
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      reply_draft: 'Checking with the team.',
      availability: { skipped: false, has_enough_beds: false },
    },
  }, {}, {}, {
    label: 'dry_run handoff / insufficient beds blocked',
    send_allowed_later: false,
    requires_staff: true,
    blocked_includes: ['dry_run_handoff_or_insufficient_availability'],
  });

  assertEligibility('C.creates_booking_flag', {
    next_action: 'show_quote',
    suggested_reply: 'Quote reply',
    extraction: { handoff_required: false },
    creates_booking: true,
    dry_run_plan: {
      next_action: 'show_quote',
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      reply_draft: 'Quote reply',
    },
  }, {}, {}, {
    label: 'creates_booking flag blocks',
    send_allowed_later: false,
    requires_staff: true,
    blocked_includes: ['draft_creates_booking'],
  });

  assertEligibility('C.creates_payment_flag', {
    next_action: 'show_quote',
    suggested_reply: 'Quote reply',
    extraction: { handoff_required: false },
    dry_run_plan: { creates_payment: true, creates_booking: false, creates_stripe_link: false, reply_draft: 'x' },
  }, {}, {}, {
    label: 'dry_run creates_payment blocks',
    send_allowed_later: false,
    blocked_includes: ['dry_run_creates_payment'],
  });

  assertEligibility('C.creates_stripe_flag', {
    next_action: 'show_quote',
    suggested_reply: 'Quote reply',
    extraction: { handoff_required: false },
    dry_run_plan: { creates_stripe_link: true, creates_booking: false, creates_payment: false, reply_draft: 'x' },
  }, {}, {}, {
    label: 'dry_run creates_stripe_link blocks',
    send_allowed_later: false,
    blocked_includes: ['dry_run_creates_stripe_link'],
  });

  assertEligibility('C.payment_link_keyword', {
    next_action: 'ask_missing_field',
    suggested_reply: 'When would you like to stay?',
    extraction: { handoff_required: false },
    message_text: 'Please send me a payment link for my booking',
  }, { message_text: 'Please send me a payment link for my booking' }, {}, {
    label: 'payment link keyword blocks',
    send_allowed_later: false,
    blocked_includes: ['payment_link_request'],
  });

  assertEligibility('C.confirmation_keyword', {
    next_action: 'ask_missing_field',
    suggested_reply: 'Sure.',
    extraction: { handoff_required: false },
    message_text: 'Can you send confirmation check-in instructions?',
  }, { message_text: 'Can you send confirmation check-in instructions?' }, {}, {
    label: 'confirmation send keyword blocks',
    send_allowed_later: false,
    blocked_includes: ['confirmation_send_request'],
  });

  section('D. WHATSAPP_DRY_RUN keeps actual send false');

  const dryRunResult = evaluateLunaGuestReplySendEligibility(enDraft, enDraft, { WHATSAPP_DRY_RUN: 'true' });
  if (dryRunResult.would_send_whatsapp === false && dryRunResult.sends_whatsapp === false && dryRunResult.auto_send_ready === false) {
    pass('D1', 'WHATSAPP_DRY_RUN prevents auto_send_ready and actual send flags stay false');
  } else {
    fail('D1', 'dry-run gate or send flags wrong');
  }

  section('E. Forbidden paths (helper only)');

  for (const [id, re, label] of [
    ['E.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
    ['E.create', /booking-create-from-plan|handleBotBookingCreate|runLunaGuestBookingWriteBridge/i, 'booking create/write bridge'],
    ['E.stripe', /createStripe|api\.stripe\.com/i, 'Stripe API'],
    ['E.wa', /sendWhatsApp|graph\.facebook\.com/i, 'WhatsApp send'],
    ['E.n8n', /fetchN8n|activateN8n|triggerN8n/i, 'n8n activation'],
    ['E.confirm', /confirmation_sent_at\s*=/i, 'confirmation_sent_at write'],
  ]) {
    if (!re.test(helperSrc)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  section('F. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts
    && pkg.scripts['verify:luna-agent-phase18-send-eligibility']
      === 'node scripts/verify-luna-agent-phase18-send-eligibility.js') {
    pass('F1', 'verify:luna-agent-phase18-send-eligibility registered');
  } else {
    fail('F1', 'npm script missing or wrong path');
  }

  section('G. Downstream verifiers');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
      pass('G.' + script, `${script} passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
      const out = (e.stdout || '') + (e.stderr || '');
      console.error(out.split('\n').slice(-8).join('\n'));
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
