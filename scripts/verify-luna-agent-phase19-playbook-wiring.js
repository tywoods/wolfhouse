/**
 * Phase 19b.1 — Verifier for Luna Cami messaging playbook wiring (compute-only).
 *
 * Usage:
 *   npm run verify:luna-agent-phase19-playbook-wiring
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT     = path.join(__dirname, '..');
const LOADER   = path.join(__dirname, 'lib', 'luna-client-messaging-playbook.js');
const DRAFT    = path.join(__dirname, 'lib', 'luna-guest-reply-draft.js');
const PLANNER  = path.join(__dirname, 'lib', 'luna-guest-automation-planner.js');
const CONFIG   = path.join(ROOT, 'config', 'clients', 'wolfhouse-somo.messaging.json');
const PKG      = path.join(ROOT, 'package.json');

const REF_DATE = '2026-06-05';

const DOWNSTREAM = [
  'verify:luna-agent-phase19-messaging-playbook',
  'verify:luna-agent-phase19-checkin-day-message',
  'verify:luna-agent-phase19-automation-planner',
  'verify:luna-agent-phase19-autosend-gates-plan',
  'verify:luna-agent-phase18-closeout',
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
function key(label)    { return label.replace(/[^a-z0-9]/gi, '_').slice(0, 36); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

const {
  loadLunaMessagingPlaybook,
  buildPlaybookMetadata,
  buildPlaybookPromptContext,
  getLunaMessagingPlaybookValue,
  clearLunaMessagingPlaybookCache,
} = require('./lib/luna-client-messaging-playbook');
const { buildLunaGuestReplyDraft } = require('./lib/luna-guest-reply-draft');
const { planLunaGuestAutomationAction } = require('./lib/luna-guest-automation-planner');

console.log('\nverify-luna-agent-phase19-playbook-wiring.js  (Phase 19b.1)\n');

const startedMs = Date.now();

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Loader module');

if (fs.existsSync(LOADER)) pass('A1', 'luna-client-messaging-playbook.js exists');
else fail('A1', 'loader missing');

const loaderSrc = readOrEmpty(LOADER);
for (const fn of [
  'loadLunaMessagingPlaybook',
  'getLunaMessagingPlaybookValue',
  'buildPlaybookPromptContext',
  'buildPlaybookMetadata',
]) {
  if (loaderSrc.includes(`function ${fn}`) || loaderSrc.includes(`${fn}(`)) {
    pass('A2.' + fn, `${fn} exported`);
  } else {
    fail('A2.' + fn, `${fn} missing`);
  }
}

if (!/require\s*\([^)]*pg|INSERT\s+INTO|UPDATE\s+\w+\s+SET/i.test(loaderSrc)) {
  pass('A3', 'loader has no DB calls');
} else {
  fail('A3', 'loader must not use DB');
}

section('B. Playbook load — wolfhouse-somo');

clearLunaMessagingPlaybookCache();
const loaded = loadLunaMessagingPlaybook('wolfhouse-somo');
if (loaded.playbook_loaded === true) pass('B1', 'wolfhouse-somo playbook loads');
else fail('B1', 'playbook_loaded must be true for wolfhouse-somo');

const meta = buildPlaybookMetadata('wolfhouse-somo');
if (meta.personality_key === 'cami') pass('B2', 'personality_key cami');
else fail('B2', 'personality_key must be cami');
if (meta.assistant_name === 'Luna') pass('B3', 'assistant_name Luna');
else fail('B3', 'assistant_name must be Luna');
if (meta.brand_name === 'Wolfhouse') pass('B4', 'brand_name Wolfhouse');
else fail('B4', 'brand_name must be Wolfhouse');

const missing = loadLunaMessagingPlaybook('unknown-client-xyz');
if (missing.playbook_loaded === false) pass('B5', 'unknown client fails safely');
else fail('B5', 'unknown client should return playbook_loaded false');

section('C. Playbook content accessible');

const ctx = buildPlaybookPromptContext('wolfhouse-somo');
if (ctx.package_explanations && ctx.package_explanations.malibu) {
  pass('C1', 'package facts accessible');
} else {
  fail('C1', 'package_explanations.malibu missing from context');
}

if (ctx.hold_and_payment_rules && ctx.hold_and_payment_rules.booking_hold_hours === 6) {
  pass('C2', 'hold/payment rules accessible (6h)');
} else {
  fail('C2', 'hold_and_payment_rules.booking_hold_hours must be 6');
}

if (ctx.transfer_templates && ctx.checkin_day_templates) {
  pass('C3', 'transfer + check-in templates accessible');
} else {
  fail('C3', 'transfer/checkin templates missing from context');
}

if (getLunaMessagingPlaybookValue('wolfhouse-somo', 'quote_reply_templates.en', null)) {
  pass('C4', 'quote templates accessible');
} else {
  fail('C4', 'quote_reply_templates.en missing');
}

section('D. Draft + planner wiring (static)');

const draftSrc = readOrEmpty(DRAFT);
const plannerSrc = readOrEmpty(PLANNER);

if (/luna-client-messaging-playbook/.test(draftSrc)) pass('D1', 'draft builder imports playbook loader');
else fail('D1', 'draft builder must import playbook loader');

if (/messaging_playbook/.test(draftSrc)) pass('D2', 'draft builder sets messaging_playbook');
else fail('D2', 'messaging_playbook missing from draft builder');

if (/luna-client-messaging-playbook/.test(plannerSrc)) pass('D3', 'automation planner imports playbook loader');
else fail('D3', 'automation planner must import playbook loader');

if (/playbook_action_guidance/.test(plannerSrc)) pass('D4', 'planner sets playbook_action_guidance');
else fail('D4', 'playbook_action_guidance missing from planner');

section('E. Draft runtime — playbook metadata + templates');

(async () => {
  clearLunaMessagingPlaybookCache();

  const partialDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550901',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, { reference_date: REF_DATE });

  if (partialDraft.messaging_playbook && partialDraft.messaging_playbook.playbook_loaded === true) {
    pass('E1', 'guest-reply-draft includes messaging_playbook.playbook_loaded true');
  } else {
    fail('E1', 'messaging_playbook.playbook_loaded must be true in draft');
  }

  if (partialDraft.messaging_playbook.personality_key === 'cami') {
    pass('E2', 'draft messaging_playbook personality_key cami');
  } else {
    fail('E2', 'draft personality_key must be cami');
  }

  if (partialDraft.playbook_prompt_context && partialDraft.playbook_prompt_context.playbook_loaded) {
    pass('E3', 'draft includes playbook_prompt_context');
  } else {
    fail('E3', 'playbook_prompt_context missing from draft');
  }

  if (partialDraft.next_action === 'ask_missing_field'
    && String(partialDraft.suggested_reply || '').includes('date')) {
    pass('E4', 'missing-field path uses playbook-style dates prompt');
  } else {
    fail('E4', 'ask_missing_field should use playbook dates wording');
  }

  const handoffDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550902',
    language: 'en',
    message_text: 'I need a refund for my booking please',
  }, { reference_date: REF_DATE });

  if (handoffDraft.next_action === 'handoff_to_staff'
    && /team|refund/i.test(String(handoffDraft.suggested_reply || ''))) {
    pass('E5', 'handoff path uses playbook or safe fallback wording');
  } else {
    fail('E5', 'handoff suggested_reply should reference team/refund');
  }

  const quoteDraft = await buildLunaGuestReplyDraft({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550903',
    guest_name: 'Quote Wiring Guest',
    language: 'en',
    message_text: 'Hi, we are 2 people September 24 to September 27. We want Malibu.',
  }, {
    reference_date: REF_DATE,
    runDryRun: async () => ({
      dry_run: true,
      preview_only: true,
      no_write_performed: true,
      planned_actions: ['show_quote'],
      next_action: 'show_quote',
      reply_draft: 'For those dates, the estimated total is €270.00. You can pay a €100.00 deposit now or the full amount.',
      gate: { can_continue_guest_automation: true, bot_paused: false },
      booking_preview: {
        has_missing_fields: false,
        fields: {
          check_in: '2026-09-24',
          check_out: '2026-09-27',
          guest_count: 2,
          package_code: 'malibu',
        },
        quote: {
          success: true,
          package_code: 'malibu',
          total_cents: 27000,
          deposit_required_cents: 10000,
        },
      },
      availability: { skipped: true },
    }),
  });

  if (quoteDraft.dry_run_plan && quoteDraft.next_action === 'show_quote') {
    if (/deposit|full|€|Great news/i.test(String(quoteDraft.suggested_reply || ''))) {
      pass('E6', 'quote path uses playbook template or amount wording');
    } else {
      fail('E6', 'quote suggested_reply missing amount/deposit/full');
    }
    if (quoteDraft.playbook_prompt_context && quoteDraft.playbook_prompt_context.quote_reply_templates) {
      pass('E7', 'quote path has access to quote templates via context');
    } else {
      fail('E7', 'quote_reply_templates not in playbook_prompt_context');
    }
  } else {
    fail('E6', 'expected show_quote dry-run for quote wiring test');
    fail('E7', 'skipped — no quote dry-run');
  }

  if (!quoteDraft.config_alignment_warnings
    || !quoteDraft.config_alignment_warnings.some(w => w.code === 'hold_expiry_mismatch')) {
    pass('E8', 'hold expiry aligned — no hold_expiry_mismatch warning');
  } else {
    fail('E8', 'hold_expiry_mismatch should be resolved when baseline and playbook both use 6h');
  }

  section('F. Automation planner — playbook metadata + guidance');

  const plan = await planLunaGuestAutomationAction({
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    from: '+15555550904',
    language: 'it',
    message_text: 'Ciao, siamo due persone e vorremmo venire a settembre. Avete posto?',
  }, { reference_date: REF_DATE });

  if (plan.messaging_playbook && plan.messaging_playbook.playbook_loaded === true) {
    pass('F1', 'planner includes messaging_playbook');
  } else {
    fail('F1', 'planner messaging_playbook missing');
  }

  if (plan.playbook_action_guidance
    && plan.playbook_action_guidance.template_source === 'missing_field_prompts') {
    pass('F2', 'ask_missing_field playbook_action_guidance');
  } else {
    fail('F2', 'playbook_action_guidance.template_source should be missing_field_prompts');
  }

  if (plan.draft && plan.draft.messaging_playbook) pass('F3', 'nested draft carries messaging_playbook');
  else fail('F3', 'plan.draft.messaging_playbook missing');

  section('G. Safety — no runtime send/write/Stripe/n8n');

  const safetyBlob = loaderSrc + draftSrc + plannerSrc;
  const forbidden = [
    ['WhatsApp send', /sendWhatsApp|whatsapp\.send/i],
    ['SQL writes', /INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM/i],
    ['Stripe calls', /stripe\.checkout|stripe\.paymentIntents/i],
    ['n8n activation', /activateWorkflow|n8n.*activate/i],
    ['booking write bridge', /createBooking|writeBooking|bot-booking-write/i],
  ];
  for (const [label, re] of forbidden) {
    if (!re.test(safetyBlob)) pass('G.' + key(label), `no ${label} in wiring helpers`);
    else fail('G.' + key(label), `forbidden ${label} in wiring helpers`);
  }

  if (partialDraft.sends_whatsapp === false && partialDraft.no_write_performed === true) {
    pass('G.safe_flags', 'draft safety flags unchanged');
  } else {
    fail('G.safe_flags', 'draft safety flags violated');
  }

  if (plan.sends_whatsapp === false && plan.creates_stripe_link === false) {
    pass('G.planner_flags', 'planner safety flags unchanged');
  } else {
    fail('G.planner_flags', 'planner safety flags violated');
  }

  section('H. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  if (pkg.scripts && pkg.scripts['verify:luna-agent-phase19-playbook-wiring']) {
    pass('H1', 'npm script verify:luna-agent-phase19-playbook-wiring registered');
  } else {
    fail('H1', 'npm script missing');
  }

  if (fs.existsSync(CONFIG)) pass('H2', 'wolfhouse-somo.messaging.json on disk');
  else fail('H2', 'messaging config missing');

  section('I. Downstream verifiers');

  for (const scriptName of DOWNSTREAM) {
    const timeoutMs = scriptName === 'verify:luna-agent-phase19-messaging-playbook'
      ? 900000
      : 600000;
    try {
      execSync(`npm run ${scriptName}`, {
        cwd: ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: timeoutMs,
      });
      pass('I.' + key(scriptName), `${scriptName} passed`);
    } catch (err) {
      const out = (err.stdout || '') + (err.stderr || '');
      const timedOut = err.killed || /ETIMEDOUT|timed out/i.test(String(err.message || ''));
      fail('I.' + key(scriptName), `${scriptName} failed${timedOut ? ' (timeout)' : ''}\n${out.slice(-800)}`);
    }
  }

  const elapsed = ((Date.now() - startedMs) / 1000).toFixed(1);
  console.log(`\n--- ${passes} passed, ${failures} failed (${elapsed}s) ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
