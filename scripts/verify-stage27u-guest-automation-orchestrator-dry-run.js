/**
 * Stage 27u — Guest automation orchestrator dry-run verifier.
 *
 * Usage:
 *   npm run verify:stage27u-guest-automation-orchestrator-dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27U-GUEST-AUTOMATION-ORCHESTRATOR-DRY-RUN.md');
const SCRIPT = 'verify:stage27u-guest-automation-orchestrator-dry-run';
const REF_DATE = '2026-06-08';

const {
  runGuestAutomationOrchestratorDryRun,
  evaluateAutomationGate,
  VALID_PROPOSED_NEXT_ACTIONS,
  ORCHESTRATOR_SAFETY,
  REUSED_CHAIN_HELPERS,
} = require('./lib/luna-guest-automation-orchestrator-dry-run');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_REPLY_RE = /\b(?:payment link is ready|link is ready|sent you (?:a )?link|checkout link|booking is confirmed|confirmed your booking|pay here|booking is held|payment has been received)\b/i;

const READY_MSG = "Hi, we're 2 people looking to stay from June 15 to June 22, interested in the Malibu package";
const SERVICE_MSG = 'Can I rent a wetsuit?';

function baseInput(overrides) {
  return {
    client_slug: 'wolfhouse-somo',
    channel: 'whatsapp',
    message_text: READY_MSG,
    dry_run: true,
    reference_date: REF_DATE,
    automation_gate_context: { public_guest_automation_enabled: false },
    ...overrides,
  };
}

console.log('\nverify-stage27u-guest-automation-orchestrator-dry-run.js  (Stage 27u)\n');

try {
  execSync(`node --check "${ORCH}"`, { stdio: 'pipe' });
  pass('0a', 'orchestrator module passes node --check');
} catch {
  fail('0a', 'orchestrator syntax error');
}

const orchSrc = fs.readFileSync(ORCH, 'utf8');

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Export and helpers');

if (typeof runGuestAutomationOrchestratorDryRun === 'function') {
  pass('B1', 'exports runGuestAutomationOrchestratorDryRun');
} else {
  fail('B1', 'runGuestAutomationOrchestratorDryRun missing');
}

if (REUSED_CHAIN_HELPERS.length >= 5) pass('B2', 'documents reused chain helpers');
else fail('B2', 'reused chain helpers incomplete');

section('C. Gate blocks');

(async () => {
  const paused = evaluateAutomationGate(baseInput({
    automation_gate_context: { bot_paused: true, public_guest_automation_enabled: false },
  }), {});
  if (paused.gate_status === 'staff_handoff_required' && paused.gate_reasons.includes('bot_paused')) {
    pass('C1', 'bot_paused → staff_handoff_required');
  } else fail('C1', 'bot_paused gate');

  const takeover = evaluateAutomationGate(baseInput({
    automation_gate_context: { human_takeover: true },
  }), {});
  if (takeover.gate_status === 'staff_handoff_required') pass('C2', 'human_takeover blocked');
  else fail('C2', 'human_takeover gate');

  const staffRoute = evaluateAutomationGate(baseInput({
    automation_gate_context: { is_owner_or_staff: true },
  }), {});
  if (staffRoute.gate_status === 'blocked' && staffRoute.gate_reasons.includes('owner_or_staff_route')) {
    pass('C3', 'owner/staff route blocked');
  } else fail('C3', 'owner/staff gate');

  const badChannel = evaluateAutomationGate(baseInput({ channel: 'telegram' }), {});
  if (badChannel.gate_status === 'blocked' && badChannel.gate_reasons.includes('unsupported_channel')) {
    pass('C4', 'unsupported channel blocked');
  } else fail('C4', 'unsupported channel gate');

  section('D. Dry-run while public automation disabled');

  const dryPublicOff = await runGuestAutomationOrchestratorDryRun(baseInput({
    automation_gate_context: { public_guest_automation_enabled: false },
    dry_run: true,
  }), {});

  if (dryPublicOff.automation_gate.gate_status === 'allowed_dry_run') {
    pass('D1', 'dry-run allowed when public_guest_automation_enabled false');
  } else fail('D1', 'dry-run should be allowed');

  if (dryPublicOff.public_guest_automation_enabled === false) pass('D2', 'output public flag false');
  else fail('D2', 'public_guest_automation_enabled should be false');

  if (dryPublicOff.dry_run === true) pass('D3', 'output dry_run true');
  else fail('D3', 'dry_run must be true');

  section('E. Output shape and safety flags');

  const out = dryPublicOff;
  const shapeKeys = [
    'success',
    'dry_run',
    'automation_gate',
    'result',
    'proposed_next_action',
    'proposed_luna_reply',
    'sends_whatsapp',
    'live_send_blocked',
  ];
  for (let i = 0; i < shapeKeys.length; i++) {
    const k = shapeKeys[i];
    if (Object.prototype.hasOwnProperty.call(out, k)) pass(`E.${k}`, `output has ${k}`);
    else fail(`E.${k}`, `missing ${k}`);
  }

  if (out.sends_whatsapp === false && out.live_send_blocked === true) {
    pass('E.safety', 'safety flags on orchestrator output');
  } else fail('E.safety', 'safety flags wrong');

  if (ORCHESTRATOR_SAFETY.confirmation_send_allowed === false) {
    pass('E.no_confirm_send', 'confirmation_send_allowed false in constants');
  } else fail('E.no_confirm_send', 'confirmation send must stay false');

  if (VALID_PROPOSED_NEXT_ACTIONS.includes(out.proposed_next_action)) {
    pass('E.next_action', 'proposed_next_action is valid enum');
  } else fail('E.next_action', `invalid proposed_next_action: ${out.proposed_next_action}`);

  section('F. Reuses existing chain helpers');

  const requiredRequires = [
    'luna-guest-message-router',
    'luna-guest-availability-dry-run',
    'luna-guest-quote-proposal-dry-run',
    'luna-guest-payment-choice-dry-run',
    'luna-guest-hold-payment-draft-planner',
  ];
  for (let i = 0; i < requiredRequires.length; i++) {
    const mod = requiredRequires[i];
    if (orchSrc.includes(mod)) pass(`F.req.${i}`, `requires ${mod}`);
    else fail(`F.req.${i}`, `missing require ${mod}`);
  }

  const callPatterns = [
    'runLunaGuestMessageRouterDryRun',
    'runGuestAvailabilityDryRun',
    'runGuestQuoteProposalDryRun',
    'runGuestPaymentChoiceDryRun',
    'runGuestHoldPaymentDraftPlannerDryRun',
  ];
  for (let i = 0; i < callPatterns.length; i++) {
    if (orchSrc.includes(callPatterns[i])) pass(`F.call.${i}`, `calls ${callPatterns[i]}`);
    else fail(`F.call.${i}`, `missing call ${callPatterns[i]}`);
  }

  section('G. Does not call forbidden write/send slices');

  const forbiddenModules = [
    'luna-guest-hold-payment-draft-write',
    'luna-guest-stripe-test-link-create',
    'luna-guest-stripe-payment-truth-apply',
    'luna-guest-confirmation-preview-dry-run',
    'luna-guest-confirmation-send-go-no-go',
    'luna-guest-confirmation-live-send-allowlist',
    'luna-guest-reply-send-route',
  ];
  for (let i = 0; i < forbiddenModules.length; i++) {
    if (!orchSrc.includes(forbiddenModules[i])) {
      pass(`G.${i}`, `does not require ${forbiddenModules[i]}`);
    } else {
      fail(`G.${i}`, `forbidden require ${forbiddenModules[i]}`);
    }
  }

  const forbiddenCalls = [
    'runGuestHoldPaymentDraftWriteDryRunApproved',
    'runGuestStripeTestLinkCreateApproved',
    'runGuestStripePaymentTruthApplyApproved',
    'runGuestConfirmationPreviewDryRun',
    'runGuestConfirmationSendGoNoGo',
    'runGuestConfirmationLiveSendAllowlisted',
  ];
  for (let i = 0; i < forbiddenCalls.length; i++) {
    if (!orchSrc.includes(forbiddenCalls[i])) pass(`G.call.${i}`, `no ${forbiddenCalls[i]}`);
    else fail(`G.call.${i}`, `forbidden call ${forbiddenCalls[i]}`);
  }

  section('H. Source hygiene');

  const hygieneChecks = [
    ['H.whatsapp_send', /\bsendWhatsApp\b|\bsends_whatsapp:\s*true/],
    ['H.n8n', /\bactivateN8n\b|\bcalls_n8n:\s*true/],
    ['H.stripe_link', /\bgenerateStripeLink\b|\bcreates_stripe_link:\s*true/],
    ['H.payment_link', /\bpayment_link_sent:\s*true/],
  ];
  for (const [id, re] of hygieneChecks) {
    if (!re.test(orchSrc)) pass(id, 'source clean');
    else fail(id, 'unsafe pattern in orchestrator source');
  }

  if (/creates_booking:\s*false/.test(orchSrc) && /no_write_performed:\s*true/.test(orchSrc)) {
    pass('H.write_flags', 'write safety flags in source');
  } else fail('H.write_flags', 'write safety flags missing');

  section('I. Booking chain smoke');

  if (out.result && out.result.message_lane === 'new_booking_inquiry') {
    pass('I1', 'booking message routes to new_booking_inquiry');
  } else fail('I1', 'expected new_booking_inquiry lane');

  if (out.availability != null) pass('I2', 'availability object present');
  else fail('I2', 'availability missing');

  if (out.quote != null) pass('I3', 'quote object present');
  else fail('I3', 'quote missing');

  if (out.payment_choice != null) pass('I4', 'payment_choice object present');
  else fail('I4', 'payment_choice missing');

  section('J. Payment choice continuation via guest_context');

  const payTurn = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: 'Deposit is fine',
    guest_context: {
      message_lane: 'new_booking_inquiry',
      quote: {
        quote_status: 'ready',
        payment_choice_needed: true,
        quote_total_cents: 123456,
        deposit_options: { deposit_required_cents: 20000 },
      },
      payment_choice_needed: true,
    },
  }), {});

  if (payTurn.payment_choice && payTurn.payment_choice.payment_choice_ready === true) {
    pass('J1', 'guest_context quote → payment_choice_ready');
  } else fail('J1', 'payment choice continuation failed');

  if (payTurn.payment_choice.payment_choice === 'deposit') pass('J2', 'deposit detected');
  else fail('J2', 'expected deposit payment_choice');

  if (payTurn.proposed_next_action === 'prepare_hold_payment_draft_plan') {
    pass('J3', 'next action prepare_hold_payment_draft_plan');
  } else fail('J3', `unexpected next action: ${payTurn.proposed_next_action}`);

  section('K. Non-booking lane');

  const svc = await runGuestAutomationOrchestratorDryRun(baseInput({
    message_text: SERVICE_MSG,
  }), {});

  if (svc.result && svc.result.message_lane === 'add_service_request') {
    pass('K1', 'service request classified');
  } else fail('K1', `expected add_service_request got ${svc.result && svc.result.message_lane}`);

  if (svc.availability == null && svc.quote == null) pass('K2', 'non-booking skips availability/quote');
  else fail('K2', 'non-booking should not run full chain');

  if (svc.sends_whatsapp === false && svc.live_send_blocked === true) pass('K3', 'non-booking safety flags');
  else fail('K3', 'non-booking safety');

  if (!FORBIDDEN_REPLY_RE.test(svc.proposed_luna_reply || '')) pass('K4', 'non-booking reply safe');
  else fail('K4', 'non-booking reply unsafe');

  section('L. Gate-blocked orchestrator');

  const blocked = await runGuestAutomationOrchestratorDryRun(baseInput({
    automation_gate_context: { bot_paused: true },
  }), {});

  if (blocked.proposed_next_action === 'staff_handoff_required') pass('L1', 'paused → staff_handoff_required action');
  else fail('L1', 'paused next action');

  if (blocked.result == null) pass('L2', 'paused does not run chain');
  else fail('L2', 'chain should not run when gate blocked');

  section('M. Doc files');

  if (fs.existsSync(DOC)) pass('M1', 'STAGE-27U doc exists');
  else fail('M1', 'STAGE-27U doc missing');

  const docText = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  if (docText.includes('runGuestAutomationOrchestratorDryRun')) pass('M2', 'doc names function');
  if (docText.includes('27t')) pass('M3', 'doc references 27t gate');
  if (/no public|No public/i.test(docText)) pass('M4', 'doc states no public wiring');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
