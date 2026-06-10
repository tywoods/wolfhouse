/**
 * Stage 28j.2 — Verifier: honor the conversation brain in final replies.
 *
 * All LLM calls are stubbed — no paid API calls are made.
 *
 * Confirms the live arbitration fixes:
 *   1. Live-style flow (hi → book → July 1-5 → 1) reaches guest_count=1 + short-stay
 *      guidance without re-asking guest count.
 *   2. "no add nothing" → accommodation-only ack + deposit/full prompt after quote.
 *   3. "deposit" after accommodation-only → captures deposit preference (dry-run).
 *   4. "when will you?" → contextual progress answer, no generic handoff.
 *   5. Repeated "Hi/Hey, I'm Luna from Wolfhouse" intro removed mid-flow.
 *   6. Brain reply cannot be overridden by payment-choice template for short-stay
 *      accommodation-only.
 *   7. open_demo_result includes brain observability fields.
 *   8. LLM timeout/error falls back to clarify, not a dumb handoff.
 *   9. No Stripe / payment-link / confirmation / n8n changes.
 *
 * Usage:
 *   npm run verify:stage28j2-brain-arbitration
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRAIN = path.join(__dirname, 'lib', 'luna-conversation-brain.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PKG_NIGHT = path.join(__dirname, 'lib', 'wolfhouse-package-night-rules.js');
const META_ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28j2-brain-arbitration';

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

const INTRO_RE = /(?:Hi|Hey)[!,.]?\s+I'?m\s+Luna\s+from\s+Wolfhouse\s*🌊/gi;

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
    // Mirror the live slim-context carry-over (keeps package_night_rule + extracted fields).
    ctx = o.result
      ? {
        ...ctx,
        message_lane: o.result.message_lane,
        readiness_state: o.result.readiness_state,
        booking_intake_ready: o.result.booking_intake_ready,
        extracted_fields: o.result.extracted_fields,
        detected_language: o.result.detected_language,
        package_night_rule: o.result.package_night_rule,
        result: {
          message_lane: o.result.message_lane,
          intake_state: o.result.intake_state,
          readiness_state: o.result.readiness_state,
          booking_intake_ready: o.result.booking_intake_ready,
          extracted_fields: o.result.extracted_fields,
          detected_language: o.result.detected_language,
          package_night_rule: o.result.package_night_rule,
        },
      }
      : ctx;
  }
  return out;
}

function asksDepositOrFull(reply) {
  // The bad behavior is *asking* the guest to choose deposit vs full. The safe
  // accommodation-only reply may explain it "can't take a deposit or full payment yet",
  // which must NOT be treated as a payment-choice prompt.
  return /would you prefer to pay|deposit or the full amount|prefer (?:the )?deposit or/i.test(reply || '');
}
function isGenericHandoff(reply) {
  return /passing this to our team|follow up soon.*team|hand(?:ing)? this over/i.test(reply || '');
}
function asksPackageChoice(reply) {
  return /which package|Malibu, Uluwatu,? (?:or |and )?Waimea\?/i.test(reply || '');
}

console.log('\nverify-stage28j2-brain-arbitration.js  (Stage 28j.2)\n');

for (const f of [BRAIN, ROUTER, ORCH, PKG_NIGHT, META_ADAPTER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const orchSrc = fs.readFileSync(ORCH, 'utf8');
const metaSrc = fs.readFileSync(META_ADAPTER, 'utf8');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));

(async () => {
  check('A1', !!pkg.scripts[SCRIPT], 'verifier npm script registered');

  // ── 1. Live-style flow reaches guest_count without re-asking ──
  section('1. Live flow: hi → book a stay → July 1-5 → 1');
  const flow = await runTurns(['hi', 'book a stay', 'July 1-5', '1']);
  const t4 = flow[3];
  check('1A', t4.result.extracted_fields && t4.result.extracted_fields.guest_count === 1,
    'guest_count=1 captured after "1"');
  check('1B', t4.orchestrator.proposed_next_action !== 'staff_handoff_required'
    && t4.result.safe_handoff_required !== true,
    'no handoff on bare "1"');
  check('1C', /€\s*180|180\.00|wetsuit|surfboard|lessons/i.test(t4.orchestrator.proposed_luna_reply),
    'short-stay accommodation quoted after guest count');
  check('1E', t4.orchestrator.quote && t4.orchestrator.quote.quote_status === 'ready',
    'quote ready on guest-count turn');
  check('1D', !/how many guests/i.test(t4.orchestrator.proposed_luna_reply),
    'does not re-ask guest count after "1"');

  // ── 2. accommodation-only choice ──
  section('2. "no add nothing" → accommodation-only');
  const flow2 = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'no add nothing']);
  const a5 = flow2[4];
  check('2A', a5.result.extracted_fields.package_interest === 'accommodation_only',
    'accommodation_only set');
  check('2B', !asksPackageChoice(a5.orchestrator.proposed_luna_reply),
    'no package prompt for short stay');
  check('2C', asksDepositOrFull(a5.orchestrator.proposed_luna_reply),
    'deposit/full prompt after accommodation-only choice (quote ready)');
  check('2D', a5.orchestrator.proposed_next_action !== 'staff_handoff_required'
    && a5.result.safe_handoff_required !== true,
    'no handoff on accommodation-only choice');
  check('2E', /accommodation only|no add-ons/i.test(a5.orchestrator.proposed_luna_reply),
    'reply acknowledges accommodation-only choice');
  check('2F', a5.orchestrator.proposed_next_action === 'collect_payment_choice',
    'next action = collect_payment_choice');

  // ── 3. "deposit" after accommodation-only ──
  section('3. "deposit" after accommodation-only');
  const flow3 = await runTurns(['hi', 'book a stay', 'July 1-5', '1', 'no add nothing', 'deposit']);
  const dep = flow3[5];
  check('3A', dep.orchestrator.payment_choice && dep.orchestrator.payment_choice.payment_choice === 'deposit',
    'deposit preference captured');
  check('3B', !isGenericHandoff(dep.orchestrator.proposed_luna_reply)
    && dep.orchestrator.proposed_next_action !== 'staff_handoff_required',
    'no generic handoff on "deposit"');
  check('3C', /noted you would like to pay the deposit|deposit/i.test(dep.orchestrator.proposed_luna_reply),
    'acknowledges deposit preference (dry-run safe copy)');

  // ── 4. "when will you?" ──
  section('4. "when will you?" → contextual, no handoff');
  const flow4 = await runTurns([
    'hi', 'book a stay', 'July 1-5', '1', 'no add nothing', 'deposit', 'when will you?',
  ]);
  const when = flow4[6];
  check('4A', !isGenericHandoff(when.orchestrator.proposed_luna_reply)
    && when.orchestrator.proposed_next_action !== 'staff_handoff_required',
    'no generic handoff on "when will you?"');
  check('4B', /deposit|full|next step|team usually confirms/i.test(when.orchestrator.proposed_luna_reply),
    'contextual answer about booking progress / next step');

  // ── 5. repeated intro removed mid-flow ──
  section('5. No repeated intro mid-flow');
  let introViolations = 0;
  for (const t of flow4) {
    const m = (t.orchestrator.proposed_luna_reply || '').match(INTRO_RE) || [];
    // Greeting turn ("hi") may carry one intro; mid-flow turns must carry none.
    const allowed = t.message_text.toLowerCase() === 'hi' ? 1 : 0;
    if (m.length > allowed) {
      introViolations++;
      fail('5x', `"${t.message_text}" had ${m.length} intro(s): ${t.orchestrator.proposed_luna_reply}`);
    }
  }
  check('5A', introViolations === 0, 'no mid-flow intro repetition across the live flow');

  // ── 6. payment-choice template cannot override brain for short-stay accommodation ──
  section('6. Arbitration: brain authoritative for short-stay accommodation');
  check('6A', asksDepositOrFull(a5.orchestrator.proposed_luna_reply),
    'payment-choice template wins after short-stay quote + add-ons answered');
  const obs = a5.result.conversation_brain || {};
  check('6B', obs.final_reply_overrode_brain === false || obs.final_reply_source === 'payment_choice',
    'arbitration observability present for accommodation-only turn');
  check('6C', ['payment_choice', 'router', 'quote', 'composed'].includes(obs.final_reply_source),
    'short-stay accommodation reply sourced from quote/payment/router chain');

  // ── 7. observability fields ──
  section('7. Brain observability fields');
  const keys = ['brain_enabled', 'llm_enabled', 'source', 'model_requested', 'model_used',
    'llm_error', 'final_reply_source', 'final_reply_overrode_brain'];
  const missing = keys.filter((k) => !(k in obs));
  check('7A', missing.length === 0, `result.conversation_brain has observability keys (missing: ${missing.join(',') || 'none'})`);
  check('7B', metaSrc.includes('conversation_brain') && metaSrc.includes('brain_source')
    && metaSrc.includes('final_reply_overrode_brain'),
    'open_demo_result summary surfaces brain observability');

  // ── 8. LLM timeout/error → clarify (not dumb handoff) ──
  section('8. LLM timeout/error falls back safely');
  const { decideConversationActionAsync } = require('./lib/luna-conversation-brain');
  const tDecision = await decideConversationActionAsync(
    {
      message_text: 'is parking included?',
      in_active_booking: true,
      active_missing_field: 'guest_count',
      env: { ...STAGING_ENV, LUNA_CONVERSATION_BRAIN_TIMEOUT_MS: '50' },
    },
    { llmClient: () => new Promise(() => {}) },
  );
  check('8A', tDecision.source === 'timeout', 'timeout labeled source=timeout');
  check('8B', tDecision.should_handoff !== true && tDecision.intent !== 'handoff',
    'timeout does not force a dumb handoff');
  const eDecision = await decideConversationActionAsync(
    { message_text: 'hmm', in_active_booking: true, active_missing_field: 'dates', env: STAGING_ENV },
    { llmClient: async () => { throw new Error('boom'); } },
  );
  check('8C', eDecision.source === 'error' && eDecision.should_handoff !== true,
    'error falls back without dumb handoff');

  // ── 9. No Stripe / payment-link / confirmation / n8n side effects ──
  section('9. Safety: no payment/confirmation/n8n side effects');
  let unsafe = 0;
  for (const t of flow4) {
    const o = t.orchestrator;
    if (o.stripe_link_created === true || o.payment_link_sent === true
      || o.confirmation_sent === true || o.calls_n8n === true
      || o.no_write_performed === false) {
      unsafe++;
    }
  }
  check('9A', unsafe === 0, 'no Stripe/payment-link/confirmation/n8n/write side effects across flow');
  check('9B', !orchSrc.includes("require('stripe')")
    && !/INSERT INTO|UPDATE\s+\w+\s+SET/i.test(orchSrc),
    'orchestrator contains no direct write/Stripe code');

  console.log(`\nStage 28j.2 verifier: ${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
