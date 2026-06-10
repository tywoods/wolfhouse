/**
 * Stage 28j — Verifier: smart LLM understanding in the live Luna message path.
 *
 * All LLM calls are stubbed — no paid API calls are made.
 *
 * Checks:
 *   - LLM path is called when enabled in staging/local, never in production.
 *   - LLM timeout/error falls back safely to the deterministic brain.
 *   - Unsafe LLM fields are stripped (handoff, dates, counts, packages, add-ons, writes).
 *   - Critical conversation examples A–J pass.
 *   - Short-stay accommodation-only does not return to package choice.
 *   - Guest correction does not handoff; side questions preserve context.
 *   - Booking writes / Stripe / payment links / confirmation flags remain false.
 *
 * Usage:
 *   npm run verify:stage28j-smart-llm-hot-path
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRAIN = path.join(__dirname, 'lib', 'luna-conversation-brain.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28j-smart-llm-hot-path';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const STAGING_ENV = {
  NODE_ENV: 'staging',
  LUNA_CONVERSATION_BRAIN_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_MODEL: 'gpt-5.5',
  LUNA_CONVERSATION_BRAIN_REASONING_EFFORT: 'low',
  LUNA_CONVERSATION_BRAIN_TIMEOUT_MS: '4000',
};

const PROD_ENV = {
  NODE_ENV: 'production',
  LUNA_CONVERSATION_BRAIN_ENABLED: 'true',
  LUNA_CONVERSATION_BRAIN_LLM_ENABLED: 'true',
};

async function runTurns(turns, ctxExtra) {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  let ctx = {};
  const out = [];
  for (const message_text of turns) {
    const o = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { dry_run: true, reference_date: '2026-06-10', ...(ctxExtra || {}) });
    out.push({ message_text, orchestrator: o, result: o.result || {} });
    ctx = o.result ? { ...ctx, ...o.result, result: o.result } : ctx;
  }
  return out;
}

function isHandoffReply(reply) {
  return /follow up soon|passing this to our team|hand(?:ing)? this over/i.test(reply || '');
}

function asksPackageChoice(reply) {
  return /which package are you interested in|interested in one of our packages/i.test(reply || '');
}

console.log(`\nverify-stage28j-smart-llm-hot-path.js  (Stage 28j)\n`);

for (const f of [BRAIN, ROUTER, ORCH, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const brainSrc = fs.readFileSync(BRAIN, 'utf8');
const routerSrc = fs.readFileSync(ROUTER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

const brain = require('./lib/luna-conversation-brain');
const {
  decideConversationAction,
  decideConversationActionAsync,
  sanitizeLlmDecision,
  isConversationBrainLlmEnabled,
  conversationBrainModel,
  conversationBrainTimeoutMs,
  BRAIN_SAFETY_FLAGS,
} = brain;

(async () => {
  section('A. Wiring + gating');

  check('A1', !!pkg.scripts[SCRIPT], 'verifier npm script registered');

  check('A2',
    orchSrc.includes('decideConversationActionAsync') && orchSrc.includes('brain_decision'),
    'orchestrator (live hot path) calls async brain and passes decision to router');

  check('A3',
    routerSrc.includes('src.brain_decision'),
    'router accepts precomputed (LLM-backed) brain decision');

  check('A4',
    brainSrc.includes('callLunaAiJsonChat'),
    'brain uses the shared Luna AI provider for the real LLM call');

  check('A5', isConversationBrainLlmEnabled(STAGING_ENV) === true,
    'LLM gate ON in staging with both flags');
  check('A6', isConversationBrainLlmEnabled(PROD_ENV) === false,
    'LLM gate OFF in production even with flags set');
  check('A7',
    isConversationBrainLlmEnabled({ NODE_ENV: 'staging', LUNA_CONVERSATION_BRAIN_ENABLED: 'true' }) === false,
    'LLM gate OFF when LUNA_CONVERSATION_BRAIN_LLM_ENABLED not set');
  check('A8', conversationBrainModel(STAGING_ENV) === 'gpt-5.5'
    && conversationBrainModel({}) === 'gpt-5.5',
    'model env honored with gpt-5.5 default');
  check('A9', conversationBrainTimeoutMs(STAGING_ENV) === 4000
    && conversationBrainTimeoutMs({}) === 4000,
    'timeout env honored with 4000ms default');
  check('A10',
    brainSrc.includes('defaultConversationBrainLlmClient')
    && brainSrc.match(/catch[\s\S]{0,200}callLunaAiJsonChat/),
    'graceful model fallback: retry with repo default model on model error');

  section('B. LLM call behavior (stubbed)');

  const baseInput = {
    message_text: 'I want something for next month maybe',
    prior_extracted_fields: {},
    active_missing_field: 'dates',
    in_active_booking: true,
    env: STAGING_ENV,
  };

  // B1: LLM called when enabled.
  let llmCalls = 0;
  let promptSeen = null;
  const d1 = await decideConversationActionAsync(baseInput, {
    llmClient: async (prompt) => {
      llmCalls++;
      promptSeen = prompt;
      return {
        intent: 'clarify',
        confidence: 'medium',
        should_handoff: false,
        reply_type: 'clarify',
        preserve_context: true,
        clarifying_question: 'Which dates are you thinking of?',
        extracted_fields_patch: {},
      };
    },
  });
  check('B1', llmCalls === 1 && d1.source === 'llm',
    `LLM path called when enabled in staging (calls=${llmCalls}, source=${d1.source})`);
  check('B2', promptSeen && promptSeen.model === 'gpt-5.5' && typeof promptSeen.system === 'string'
    && promptSeen.system.includes('MUST NOT'),
    'prompt carries model + safety instructions');

  // B3: LLM not called in production.
  let prodCalls = 0;
  const d3 = await decideConversationActionAsync(
    { ...baseInput, env: PROD_ENV },
    { llmClient: async () => { prodCalls++; return {}; } },
  );
  check('B3', prodCalls === 0 && d3.source === 'deterministic',
    `LLM path NOT called in production (calls=${prodCalls})`);

  // B4: timeout falls back to deterministic.
  const d4 = await decideConversationActionAsync(
    { ...baseInput, env: { ...STAGING_ENV, LUNA_CONVERSATION_BRAIN_TIMEOUT_MS: '50' } },
    { llmClient: () => new Promise(() => {}) }, // never resolves
  );
  check('B4', d4.source === 'timeout' && d4.intent != null,
    'LLM timeout falls back to deterministic brain (source=timeout)');

  // B5: LLM error falls back to deterministic.
  const d5 = await decideConversationActionAsync(baseInput, {
    llmClient: async () => { throw new Error('boom'); },
  });
  check('B5', d5.source === 'error' && d5.intent != null,
    'LLM error falls back to deterministic brain (source=error)');

  // B6: LLM punting to passthrough defers to a confident deterministic decision.
  const d6 = await decideConversationActionAsync(
    { message_text: 'actually start over', in_active_booking: true, env: STAGING_ENV },
    { llmClient: async () => ({ intent: 'nonsense_value' }) },
  );
  check('B6', d6.intent === 'reset_new_booking' && d6.source === 'deterministic',
    'low-signal LLM output defers to confident deterministic decision');

  section('C. Sanitization of unsafe LLM output');

  const hostile = sanitizeLlmDecision({
    intent: 'booking_intake',
    confidence: 'high',
    should_handoff: true,
    handoff_reason: 'guest_seems_unsure', // not an allowed category
    reply_type: 'continue_booking',
    preserve_context: true,
    create_booking: true,
    create_payment: true,
    send_confirmation: true,
    stripe_link: 'https://evil.example/pay',
    price_total: 9999,
    availability_confirmed: true,
    extracted_fields_patch: {
      check_in: 'July 1', // invalid format
      check_out: '2026-13-45', // invalid date
      guest_count: -3,
      package_interest: 'penthouse_supreme',
      payment_choice: 'crypto',
      add_ons: ['jetski', 'yoga'],
      total_price: 1,
      booking_code: 'HACK',
    },
    safety_flags: { creates_booking: true, creates_stripe_link: true },
  }, 'dates');

  check('C1', hostile.should_handoff === null,
    'should_handoff=true with disallowed reason is stripped (deferred)');
  check('C2', !('create_booking' in hostile) && !('stripe_link' in hostile)
    && !('price_total' in hostile) && !('availability_confirmed' in hostile),
    'booking/payment/Stripe/price/availability assertions are stripped');
  check('C3', hostile.extracted_fields_patch.check_in === undefined
    && hostile.extracted_fields_patch.check_out === undefined,
    'invalid dates rejected');
  check('C4', hostile.extracted_fields_patch.guest_count === undefined,
    'invalid guest_count rejected');
  check('C5', hostile.extracted_fields_patch.package_interest === undefined,
    'unknown package rejected');
  check('C6', hostile.extracted_fields_patch.payment_choice === undefined,
    'non deposit/full payment_choice rejected');
  check('C7', JSON.stringify(hostile.extracted_fields_patch.add_ons) === JSON.stringify(['yoga']),
    'add-ons filtered to known services list');
  check('C8', hostile.extracted_fields_patch.total_price === undefined
    && hostile.extracted_fields_patch.booking_code === undefined,
    'unknown patch fields stripped');
  check('C9', Object.entries(hostile.safety_flags).every(([, v]) => v === false)
    && JSON.stringify(hostile.safety_flags) === JSON.stringify(BRAIN_SAFETY_FLAGS),
    'LLM-supplied safety flags ignored; hard-coded safe flags enforced');

  const allowedHandoff = sanitizeLlmDecision({
    intent: 'urgent_handoff',
    should_handoff: true,
    handoff_reason: 'urgent_safety',
  }, null);
  check('C10', allowedHandoff.should_handoff === true && allowedHandoff.handoff_reason === 'urgent_safety',
    'allowed handoff category is honored');

  const reversed = sanitizeLlmDecision({
    intent: 'booking_intake',
    extracted_fields_patch: { check_in: '2026-07-10', check_out: '2026-07-05' },
  }, null);
  check('C11', reversed.extracted_fields_patch.check_in === undefined,
    'reversed date range rejected');

  const goodPatch = sanitizeLlmDecision({
    intent: 'accommodation_only_choice',
    confidence: 'high',
    should_handoff: false,
    reply_type: 'accommodation_only_ack',
    preserve_context: true,
    extracted_fields_patch: { accommodation_only: true, guest_count: 2, payment_choice: 'deposit' },
  }, null);
  check('C12', goodPatch.extracted_fields_patch.accommodation_only === true
    && goodPatch.extracted_fields_patch.package_interest === 'accommodation_only'
    && goodPatch.extracted_fields_patch.guest_count === 2
    && goodPatch.extracted_fields_patch.payment_choice === 'deposit'
    && goodPatch.confidence === 0.9,
    'valid patch fields + high/medium/low confidence accepted');

  section('D. Orchestrator hot-path wiring (stubbed LLM)');

  // D1: orchestrator invokes the injected LLM client when env-gated on.
  let hotPathCalls = 0;
  const hotOut = await runTurns(['I want to book a stay'], {
    env: { ...process.env, ...STAGING_ENV },
    brain_llm_client: async () => {
      hotPathCalls++;
      return {
        intent: 'booking_intake',
        confidence: 'high',
        should_handoff: false,
        reply_type: 'ask_dates',
        preserve_context: true,
        extracted_fields_patch: {},
      };
    },
  });
  check('D1', hotPathCalls === 1,
    `orchestrator hot path calls the LLM brain when enabled (calls=${hotPathCalls})`);
  check('D2', (hotOut[0].result.conversation_brain || {}).source === 'llm',
    'router consumed the LLM-backed decision');

  // D3: orchestrator does NOT call LLM client when env says production.
  let prodHotCalls = 0;
  await runTurns(['I want to book a stay'], {
    env: { ...process.env, ...PROD_ENV },
    brain_llm_client: async () => { prodHotCalls++; return {}; },
  });
  check('D3', prodHotCalls === 0, 'orchestrator never calls LLM in production env');

  // D4: LLM-supplied accommodation-only decision flows through the router safely.
  let llmAccomOut = null;
  {
    const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
    const seeded = await runTurns(['book a stay', 'July 1-5', '1']);
    const lastCtx = { ...seeded[2].result, result: seeded[2].result };
    llmAccomOut = await runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text: 'no add nothing',
      guest_context: lastCtx,
      reference_date: '2026-06-10',
    }, {
      dry_run: true,
      reference_date: '2026-06-10',
      env: { ...process.env, ...STAGING_ENV },
      brain_llm_client: async () => ({
        intent: 'accommodation_only_choice',
        confidence: 'high',
        should_handoff: false,
        reply_type: 'accommodation_only_ack',
        preserve_context: true,
        active_flow: 'short_stay_accommodation',
        next_best_action: 'continue_intake',
        extracted_fields_patch: { accommodation_only: true },
      }),
    });
  }
  check('D4', llmAccomOut.result.extracted_fields.package_interest === 'accommodation_only'
    && llmAccomOut.result.conversation_brain.source === 'llm'
    && llmAccomOut.result.safe_handoff_required === false,
    'LLM accommodation-only decision applied safely (no handoff, package set)');

  section('E. Critical examples A–J (deterministic fallback path)');

  // A: short stay → "no add nothing" → accommodation only, no package prompt, no handoff
  const exA = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'no add nothing']);
  const a5 = exA[4];
  check('E-A1', a5.result.extracted_fields.package_interest === 'accommodation_only',
    'A: accommodation_only=true after "no add nothing"');
  check('E-A2', !asksPackageChoice(a5.orchestrator.proposed_luna_reply),
    'A: no package prompt after accommodation-only choice');
  check('E-A3', a5.result.safe_handoff_required === false,
    'A: router does not handoff');
  check('E-A4', /accommodation only/i.test(a5.orchestrator.proposed_luna_reply)
    && /team needs to confirm|accommodation only it is/i.test(a5.orchestrator.proposed_luna_reply),
    'A: reply acknowledges accommodation only (short-stay confirm)');
  check('E-A5', !/deposit|full amount/i.test(a5.orchestrator.proposed_luna_reply),
    'A: no deposit/full prompt for short-stay accommodation-only');

  // B: guest corrects Luna → acknowledge, continue short-stay flow, no handoff
  const exB = await runTurns([
    'hi', 'book a stay', 'July 1-5', '1', 'no add nothing',
    "you told me they are not available. i'm only staying 5 days",
  ]);
  const b6 = exB[5];
  check('E-B1', b6.result.conversation_brain.guest_is_correcting_luna === true,
    'B: guest_is_correcting_luna=true');
  check('E-B2', /you'?re right|sorry about the mix-up/i.test(b6.orchestrator.proposed_luna_reply),
    'B: reply apologizes/acknowledges the correction');
  check('E-B3', b6.result.safe_handoff_required === false
    && b6.orchestrator.proposed_next_action !== 'staff_handoff_required',
    'B: no handoff on correction');
  check('E-B4', !asksPackageChoice(b6.orchestrator.proposed_luna_reply),
    'B: stays in short-stay accommodation flow (no package prompt)');

  // C: 7 nights → package explainer + choice
  const exC = await runTurns(['hi', 'book a stay', 'July 10-17', '1']);
  const c4 = exC[3];
  check('E-C1', c4.result.package_night_rule === 'weekly_explain_before_choice'
    && /malibu/i.test(c4.orchestrator.proposed_luna_reply)
    && /waimea/i.test(c4.orchestrator.proposed_luna_reply),
    'C: 7-night stay gets package explainer before choice');

  // D: "explain the packages" during package choice → explain + preserve + re-ask
  const exD = await runTurns(['hi', 'book a stay', 'July 10-17', '1', 'explain the packages']);
  const d5x = exD[4];
  check('E-D1', /€249|from .249/i.test(d5x.orchestrator.proposed_luna_reply)
    && /uluwatu/i.test(d5x.orchestrator.proposed_luna_reply),
    'D: packages explained');
  check('E-D2', d5x.result.extracted_fields.check_in === '2026-07-10'
    && d5x.result.extracted_fields.guest_count === 1,
    'D: dates/guests preserved through side question');
  check('E-D3', /which one sounds closest/i.test(d5x.orchestrator.proposed_luna_reply),
    'D: asks which package after explaining');
  check('E-D4', d5x.result.safe_handoff_required === false, 'D: no handoff');

  // E: "Malibu" after explainer → quote/availability path
  const exE = await runTurns(['hi', 'book a stay', 'July 10-17', '1', 'explain the packages', 'Malibu']);
  const e6 = exE[5];
  check('E-E1', e6.result.extracted_fields.package_interest === 'malibu',
    'E: Malibu accepted as package choice');
  check('E-E2', e6.orchestrator.availability && e6.orchestrator.availability.availability_check_attempted === true,
    'E: availability/quote path attempted');
  check('E-E3', e6.result.safe_handoff_required === false, 'E: router does not handoff');

  // F: "I don't know which package" → explain differences + recommend
  const exF = await runTurns(['book a stay', 'July 10-17', '1', "I don't know which package"]);
  const f4 = exF[3];
  check('E-F1', f4.result.conversation_brain.intent === 'package_undecided',
    'F: undecided intent recognized');
  check('E-F2', /waimea/i.test(f4.orchestrator.proposed_luna_reply)
    && /beginner|lesson/i.test(f4.orchestrator.proposed_luna_reply)
    && /uluwatu/i.test(f4.orchestrator.proposed_luna_reply),
    'F: explains differences with beginner→Waimea / experienced→Uluwatu guidance');
  check('E-F3', f4.result.safe_handoff_required === false, 'F: no handoff');

  // G: "actually start over" → reset, ask basics
  const exG = await runTurns(['book a stay', 'July 10-17', '1', 'actually start over']);
  const g4 = exG[3];
  check('E-G1', /start a new booking|start fresh|what dates/i.test(g4.orchestrator.proposed_luna_reply),
    'G: reset prompt asks new booking basics');
  check('E-G2', g4.orchestrator.proposed_next_action === 'ask_missing_details'
    && !isHandoffReply(g4.orchestrator.proposed_luna_reply),
    'G: reset does not handoff');
  check('E-G3', !g4.result.extracted_fields.check_in,
    'G: prior dates cleared after reset');

  // H: "July 1st to 5th. just me" → dates + guest_count, no checkout question
  const exH = await runTurns(['I want to book a stay', 'July 1st to 5th. just me']);
  const h2 = exH[1];
  check('E-H1', h2.result.extracted_fields.check_in === '2026-07-01'
    && h2.result.extracted_fields.check_out === '2026-07-05'
    && h2.result.extracted_fields.guest_count === 1,
    'H: dates + guest_count extracted from compact message');
  check('E-H2', !/check-?out date are you thinking/i.test(h2.orchestrator.proposed_luna_reply),
    'H: no checkout question');

  // I: "1" after guest-count question → guest_count=1, no handoff
  const exI = await runTurns(['book a stay', 'July 10-17', '1']);
  const i3 = exI[2];
  check('E-I1', i3.result.extracted_fields.guest_count === 1
    && i3.result.safe_handoff_required === false,
    'I: bare "1" answers guest count without handoff');

  // J: "what is Uluwatu?" during active booking → answer + preserve + re-ask
  const exJ = await runTurns(['book a stay', 'July 10-17', 'what is Uluwatu?']);
  const j3 = exJ[2];
  check('E-J1', /uluwatu/i.test(j3.orchestrator.proposed_luna_reply)
    && /€349|from .349/i.test(j3.orchestrator.proposed_luna_reply),
    'J: Uluwatu explained');
  check('E-J2', j3.result.extracted_fields.check_in === '2026-07-10',
    'J: booking context preserved');
  check('E-J3', /which one sounds closest|uluwatu/i.test(j3.orchestrator.proposed_luna_reply)
    && j3.result.safe_handoff_required === false,
    'J: flow continues, no handoff');

  section('F. Safety boundaries');

  const allOutputs = [...exA, ...exB, ...exC, ...exD, ...exE, ...exF, ...exG, ...exH, ...exI, ...exJ,
    ...hotOut, { orchestrator: llmAccomOut, result: llmAccomOut.result }];
  const unsafe = allOutputs.filter(({ orchestrator: o }) => !o
    || o.creates_booking !== false
    || o.creates_payment !== false
    || o.creates_stripe_link !== false
    || o.payment_link_sent !== false
    || o.whatsapp_sent !== false
    || o.confirmation_send_allowed !== false
    || o.no_write_performed !== true);
  check('F1', unsafe.length === 0,
    `no booking/payment/Stripe/confirmation writes across ${allOutputs.length} turns`);

  // The LLM decision can never flip write flags even if it tries.
  const writeAttempt = sanitizeLlmDecision({
    intent: 'booking_intake',
    safety_flags: {
      creates_booking: true, creates_payment_draft: true,
      creates_stripe_link: true, sends_confirmation: true,
    },
  }, null);
  check('F2', Object.values(writeAttempt.safety_flags).every((v) => v === false),
    'booking write never authorized from LLM decision');

  check('F3',
    !brainSrc.includes("require('stripe')") && !brainSrc.includes('createBooking')
    && !brainSrc.includes('.query(') && !brainSrc.match(/INSERT INTO|UPDATE\s+\w+\s+SET/i)
    && !brainSrc.includes('api.stripe.com'),
    'brain module contains no write/Stripe code paths');

  // Deterministic brain still intact for stage 28i behaviors.
  const det = decideConversationAction({
    message_text: 'explain the packages',
    in_active_booking: true,
    active_missing_field: 'package_interest',
  });
  check('F4', det.intent === 'side_question' && det.preserve_context === true,
    'deterministic 28i side-question behavior intact');

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Stage 28j verifier: ${passes} passed, ${failures} failed`);
  if (failures > 0) {
    console.error('RESULT: FAIL');
    process.exit(1);
  }
  console.log('RESULT: PASS');
})().catch((e) => {
  console.error('Verifier crashed:', e);
  process.exit(1);
});
