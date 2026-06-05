/**
 * Phase 19b — Verifier for Luna guest automation action planner (compute-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-automation-planner
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT   = path.join(__dirname, '..');
const HELPER = path.join(__dirname, 'lib', 'luna-guest-automation-planner.js');
const PKG    = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';

const DOWNSTREAM = [
  'verify:luna-agent-phase19-autosend-gates-plan',
  'verify:luna-agent-phase18-closeout',
  'verify:luna-agent-phase17-closeout',
  'verify:luna-agent-phase15-closeout',
  'verify:luna-agent-phase14-closeout',
  'verify:luna-agent-phase13-closeout',
  'verify:luna-agent-phase12-closeout',
  'verify:staff-ask-luna-phase11-closeout',
];

const SAFETY_FLAGS = {
  automation_planner:         true,
  no_write_performed:         true,
  sends_whatsapp:             false,
  creates_booking:            false,
  creates_payment:            false,
  creates_stripe_link:        false,
  calls_n8n:                  false,
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

const { planLunaGuestAutomationAction, FORBIDDEN_ACTIONS } = require('./lib/luna-guest-automation-planner');

console.log('\nverify-luna-agent-phase19-automation-planner.js  (Phase 19b)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

const helperSrc = readOrEmpty(HELPER);

section('A. Helper presence and exports');

if (fs.existsSync(HELPER)) pass('A1', 'luna-guest-automation-planner.js exists');
else fail('A1', 'helper file missing');

if (/function\s+planLunaGuestAutomationAction\s*\(/.test(helperSrc)
  && /module\.exports[^}]*planLunaGuestAutomationAction/.test(helperSrc)) {
  pass('A2', 'planLunaGuestAutomationAction exported');
} else {
  fail('A2', 'planLunaGuestAutomationAction missing or not exported');
}

for (const dep of ['buildLunaGuestReplyDraft', 'evaluateLunaGuestReplySendEligibility', 'evaluateLunaBookingWriteEligibility']) {
  if (helperSrc.includes(dep)) pass('A.dep.' + dep, `uses ${dep}`);
  else fail('A.dep.' + dep, `${dep} missing from helper`);
}

async function assertPlan(id, input, context, env, expect) {
  const plan = await planLunaGuestAutomationAction(input, context || {}, env || process.env);
  const errs = [];

  for (const [flag, val] of Object.entries(SAFETY_FLAGS)) {
    if (plan[flag] !== val) errs.push(`${flag}: expected ${val} got ${plan[flag]}`);
  }

  for (const [key, val] of Object.entries(expect)) {
    if (key === 'label' || key === 'blocked_includes' || key === 'blocked_excludes'
      || key === 'planned_includes' || key === 'forbidden_excludes'
      || key === 'suggested_contains' || key === 'has_draft' || key === 'has_send_eligibility') continue;
    if (plan[key] !== val) errs.push(`${key}: expected ${JSON.stringify(val)} got ${JSON.stringify(plan[key])}`);
  }

  if (expect.blocked_includes) {
    for (const r of expect.blocked_includes) {
      if (!plan.blocked_gates.includes(r)) errs.push(`blocked_gates missing "${r}"`);
    }
  }
  if (expect.blocked_excludes) {
    for (const r of expect.blocked_excludes) {
      if (plan.blocked_gates.includes(r)) errs.push(`blocked_gates should not include "${r}"`);
    }
  }
  if (expect.planned_includes) {
    for (const a of expect.planned_includes) {
      if (!plan.planned_actions.includes(a)) errs.push(`planned_actions missing "${a}"`);
    }
  }
  if (expect.forbidden_excludes) {
    for (const a of expect.forbidden_excludes) {
      if (plan.planned_actions.includes(a)) errs.push(`planned_actions should not include "${a}"`);
    }
  }
  if (expect.suggested_contains && !String(plan.suggested_reply || '').includes(expect.suggested_contains)) {
    errs.push(`suggested_reply missing "${expect.suggested_contains}"`);
  }
  if (expect.has_draft && !plan.draft) errs.push('draft missing');
  if (expect.has_send_eligibility && !plan.send_eligibility) errs.push('send_eligibility missing');

  if (errs.length) fail(id, errs.join('; '));
  else pass(id, expect.label || id);
}

(async () => {
  section('B. Normal booking path plans');

  await assertPlan('B.complete', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550200',
    guest_name: 'Automation Planner Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people September 24 to September 27. We want Malibu and can pay the deposit.',
  }, { reference_date: REF_DATE }, { BOT_BOOKING_ENABLED: 'false' }, {
    label: 'complete booking → create_booking_and_payment_draft, no writes',
    next_action: 'create_booking_and_payment_draft',
    requires_staff: false,
    action_ready_later: true,
    action_ready_now: false,
    blocked_includes: ['BOT_BOOKING_ENABLED'],
    planned_includes: ['create_booking_draft', 'create_payment_draft'],
    has_draft: true,
    has_send_eligibility: true,
  });

  await assertPlan('B.quote_only', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550210',
    guest_name: 'Quote Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people and want to come September 24 to September 27. Do you have Malibu?',
  }, {
    reference_date: REF_DATE,
    runDryRun: async () => ({
      dry_run: true,
      preview_only: true,
      no_write_performed: true,
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
      calls_n8n: false,
      planned_actions: ['show_quote'],
      next_action: 'show_quote',
      reply_draft: 'For those dates, the estimated total is €270.00. You can pay a €100.00 deposit now or the full amount.',
      gate: { can_continue_guest_automation: true, bot_paused: false, live_send_blocked: true },
      booking_preview: { has_missing_fields: false, quote: { success: true, package_code: 'malibu' } },
      availability: { skipped: true },
    }),
  }, {}, {
    label: 'complete quote without payment choice → send_quote',
    next_action: 'send_quote',
    requires_staff: false,
    action_ready_later: true,
    suggested_contains: '€',
    planned_includes: ['send_reply', 'show_quote'],
  });

  section('C. Missing field / ask_next');

  await assertPlan('C.partial', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550201',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, { reference_date: REF_DATE }, {}, {
    label: 'missing dates → ask_missing_field, requires_staff false',
    next_action: 'ask_missing_field',
    requires_staff: false,
    action_ready_later: true,
    suggested_reply: 'Quali date di check-in e check-out avete in mente?',
  });

  section('D. Handoff / staff-required');

  await assertPlan('D.refund', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550202',
    language: 'en',
    message_text: 'I want a refund and need to talk to someone.',
  }, { reference_date: REF_DATE }, {}, {
    label: 'refund → handoff_to_staff, requires_staff true',
    next_action: 'handoff_to_staff',
    requires_staff: true,
    action_ready_later: false,
    blocked_includes: ['handoff_required'],
  });

  await assertPlan('D.cancel', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550204',
    language: 'en',
    message_text: 'Please cancel my paid booking immediately.',
  }, { reference_date: REF_DATE }, {}, {
    label: 'cancel → handoff_to_staff',
    next_action: 'handoff_to_staff',
    requires_staff: true,
    action_ready_later: false,
  });

  await assertPlan('D.unsupported', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550203',
    language: 'en',
    message_text: '???',
  }, { reference_date: REF_DATE }, {}, {
    label: 'unsupported/low confidence → handoff, requires_staff true',
    next_action: 'unsupported',
    requires_staff: true,
    action_ready_later: false,
    blocked_includes: ['low_confidence'],
  });

  section('E. Insufficient availability');

  await assertPlan('E.no_beds', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550205',
    guest_name: 'No Beds Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people September 24 to September 27. We want Malibu and can pay the deposit.',
  }, {
    reference_date: REF_DATE,
    runDryRun: async () => ({
      dry_run: true,
      preview_only: true,
      no_write_performed: true,
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
      calls_n8n: false,
      planned_actions: ['show_quote', 'handoff_to_staff'],
      next_action: 'handoff_to_staff',
      reply_draft: 'Checking availability with the team.',
      gate: { can_continue_guest_automation: true, bot_paused: false, live_send_blocked: true },
      booking_preview: {
        has_missing_fields: false,
        quote: { success: true, package_code: 'malibu' },
      },
      availability: { skipped: false, has_enough_beds: false, selected_bed_codes: [] },
    }),
  }, {}, {
    label: 'insufficient availability → handoff_to_staff',
    next_action: 'handoff_to_staff',
    requires_staff: true,
    action_ready_later: false,
  });

  section('F. Payment link guard');

  await assertPlan('F.no_ids', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550206',
    language: 'en',
    message_text: 'Please send me the payment link.',
    payment_link_requested: true,
  }, { reference_date: REF_DATE }, {}, {
    label: 'payment link not planned without booking_id/payment_id',
    forbidden_excludes: ['create_stripe_link'],
    blocked_excludes: ['booking_payment_context_missing'],
  });

  await assertPlan('F.with_ids', {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550207',
    guest_name: 'Pay Link Guest',
    language: 'en',
    message_text: 'Ready for the deposit link please.',
    payment_link_requested: true,
    booking_id: 'bk-test-001',
    payment_id: 'pay-test-001',
  }, {
    reference_date: REF_DATE,
    runDryRun: async () => ({
      dry_run: true,
      preview_only: true,
      no_write_performed: true,
      creates_booking: false,
      creates_payment: false,
      creates_stripe_link: false,
      sends_whatsapp: false,
      calls_n8n: false,
      planned_actions: ['would_create_payment_link_after_approval'],
      next_action: 'show_quote',
      reply_draft: 'Here is your deposit link when ready.',
      gate: { can_continue_guest_automation: true, bot_paused: false, live_send_blocked: true },
      booking_preview: { has_missing_fields: false, quote: { success: true } },
      availability: { skipped: true },
    }),
  }, { STRIPE_LINKS_ENABLED: 'false' }, {
    label: 'payment link only when booking/payment ids present',
    next_action: 'create_payment_link',
    requires_staff: false,
    action_ready_later: true,
    planned_includes: ['create_stripe_link'],
    blocked_includes: ['STRIPE_LINKS_ENABLED'],
  });

  section('G. Safety flags + forbidden paths');

  const sample = await planLunaGuestAutomationAction({
    client_slug: 'wolfhouse-somo',
    from: '+15555550200',
    language: 'en',
    message_text: 'Hi, we are 2 people September 24 to September 27. We want Malibu and can pay the deposit.',
  }, { reference_date: REF_DATE });

  for (const [flag, val] of Object.entries(SAFETY_FLAGS)) {
    if (sample[flag] === val) pass('G.flag.' + flag, `${flag}=${val}`);
    else fail('G.flag.' + flag, `expected ${flag}=${val} got ${sample[flag]}`);
  }

  if (Array.isArray(sample.forbidden_actions) && FORBIDDEN_ACTIONS.every((a) => sample.forbidden_actions.includes(a))) {
    pass('G.forbidden', 'forbidden_actions lists all blocked side effects');
  } else {
    fail('G.forbidden', 'forbidden_actions incomplete');
  }

  const helperOnly = helperSrc.split('\n').filter((l) => !/^\s*\[['"]/.test(l)).join('\n');
  for (const [id, re, label] of [
    ['G.sql', /\bINSERT\s+INTO|\bUPDATE\s+\w|\bDELETE\s+FROM/i, 'SQL writes'],
    ['G.write', /runLunaGuestBookingWriteBridge|handleBotBookingCreateFromPlan|booking-create-from-plan/i, 'booking-create/write bridge'],
    ['G.pay', /createStripe\s*\(|generate-payment-link/i, 'payment create / Stripe'],
    ['G.webhook', /\/staff\/stripe\/webhook/i, 'Stripe webhook'],
    ['G.wa', /sendWhatsApp\s*\(|graph\.facebook\.com/i, 'WhatsApp send'],
    ['G.n8n', /activateN8n|triggerN8n|fetchN8n\s*\(/i, 'n8n activation'],
  ]) {
    if (!re.test(helperOnly)) pass(id, `no ${label}`);
    else fail(id, `${label} detected`);
  }

  section('H. npm script registration');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts
    && pkg.scripts['verify:luna-agent-phase19-automation-planner']
      === 'node scripts/verify-luna-agent-phase19-automation-planner.js') {
    pass('H1', 'verify:luna-agent-phase19-automation-planner registered');
  } else {
    fail('H1', 'npm script missing or wrong path');
  }

  section('I. Downstream closeout regression');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      pass('I.' + script, `${script} passes`);
    } catch (e) {
      fail('I.' + script, `${script} failed`);
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
