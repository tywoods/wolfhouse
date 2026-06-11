/**
 * Stage 49b — Luna Agent Brain v1 front-of-house verifier.
 *
 * Proves the layering contract:
 *   GPT-level planner in front + existing deterministic booking rules/tools
 *   underneath + Cami voice on output.
 *
 * - Existing router/intake/composer rules still own booking field requirements,
 *   sequencing, quoting, payment choice, and handoff safety.
 * - Agent Brain owns messy-message understanding, next-best-action, dumb-reply
 *   repair, and final Cami-style copy where it has a confident plan.
 * - Agent Brain never skips required fields, never quotes/holds without them,
 *   never invents availability/prices/payment state.
 *
 * Usage:
 *   node scripts/verify-stage49b-luna-agent-brain-frontdesk.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { withPgClient } = require('./lib/pg-connect');

const REF = '2026-06-11';
const AGENT_ENV = { ...process.env, LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true' };
const OFF_ENV = { ...process.env };
delete OFF_ENV.LUNA_GUEST_AGENT_BRAIN_ENABLED;

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up|team will check and follow up/i;
const EXPLAIN_ASK_RE = /want me to explain them quickly|do you already know which one you prefer/i;
const WELCOME_MENU_RE = /i can help you book a stay|checking some info/i;
const INTERNAL_WORDS_RE = /\b(?:router|composer|orchestrator|dry.?run|state machine|backend|database|automation gate|LLM|AI agent|tool|intake|payload|webhook)\b/i;
const CORPORATE_RE = /\b(?:dear (?:customer|guest)|we regret|kindly note|as per our policy|valued customer)\b/i;

const allReplies = [];

async function runTurn(message, prior, opts) {
  const o = opts || {};
  const input = {
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: message,
    guest_phone: o.phone || '+34600490049',
    guest_context: prior || {},
    reference_date: REF,
  };
  if (o.contactName) input.contact_name = o.contactName;
  const ctx = { env: o.env || AGENT_ENV };
  if (o.pg) ctx.pg = o.pg;
  const out = await runGuestAutomationOrchestratorDryRun(input, ctx);
  const reply = out.proposed_luna_reply || '';
  if (reply) allReplies.push(reply);
  return {
    out,
    reply,
    agent: (out.result && out.result.guest_agent_brain) || {},
    ctx: normalizeGuestContextForChain({
      result: out.result,
      availability: out.availability,
      quote: out.quote,
      payment_choice: out.payment_choice,
      extracted_fields: out.result && out.result.extracted_fields,
    }),
  };
}

async function runFlow(messages, opts) {
  let prior = {};
  const turns = [];
  for (const message of messages) {
    const t = await runTurn(message, prior, opts);
    turns.push({ message, ...t });
    prior = t.ctx;
  }
  return { turns, last: turns[turns.length - 1] };
}

function isHandoff(out) {
  const r = out && out.result;
  return !!(r && (r.safe_handoff_required || r.intake_state === 'staff_handoff_required'
    || (r.handoff_reasons && r.handoff_reasons.length)));
}

function fieldsOf(turn) {
  const r = turn.out && turn.out.result;
  return (r && r.extracted_fields) || {};
}

(async () => {
  console.log('\nverify-stage49b-luna-agent-brain-frontdesk.js  (Stage 49b)\n');

  section('A. Live package-info whiff — hello → book → dates → guests → package info');
  {
    const { turns, last } = await runFlow([
      'Oh hello',
      'lets book a stay',
      'June 12-22',
      '3',
      'tell me more about the packages',
    ]);
    check('A1', !isHandoff(last.out), 'no handoff on package-info turn');
    check('A2', fieldsOf(last).check_in === '2026-06-12' && fieldsOf(last).check_out === '2026-06-22',
      'dates June 12-22 preserved (agent uses preserved state)');
    check('A3', fieldsOf(last).guest_count === 3, 'guest_count=3 preserved');
    check('A4', /malibu/i.test(last.reply) && /uluwatu/i.test(last.reply) && /waimea/i.test(last.reply),
      'direct explanation includes Malibu/Uluwatu/Waimea from config');
    check('A5', !EXPLAIN_ASK_RE.test(last.reply), 'no "want me to explain?" after guest asked');
    check('A6', /\?/.test(last.reply), 'asks a useful next step');
    check('A7', last.agent.agent_brain_enabled === true && last.agent.agent_intent === 'package_info',
      'agent brain classified package_info');
    check('A8', last.agent.agent_final_reply_source === 'agent_brain',
      'agent brain owned the final reply');
    check('A9', Array.isArray(last.agent.agent_tool_calls)
      && last.agent.agent_tool_calls.includes('explain_packages')
      && last.agent.agent_tool_calls.includes('compose_cami_reply'),
      'tool plan includes explain_packages + compose_cami_reply');
    check('A10', turns[2].agent.agent_fallback_used === true && turns[3].agent.agent_fallback_used === true,
      'agent endorses (does not override) router intake turns');
    check('A11', !/comes to €|total of €/i.test(last.reply),
      'no invented quote total before quote engine ran');
  }

  section('B. Vague booking — intake rules still owned by router');
  {
    const { turns, last } = await runFlow([
      'Hello',
      'Book a stay',
      'June 12 to June 20',
      '3 please',
    ], { phone: '+34600490062' });
    check('B1', /package|accommodation/i.test(last.reply) && /\?/.test(last.reply),
      'asks package vs accommodation after dates+count');
    check('B2', !isHandoff(last.out), 'no handoff');
    check('B3', !WELCOME_MENU_RE.test(last.reply), 'no repeated welcome mid-thread');
    check('B4', !/what name|check-in and check-out dates/i.test(last.reply),
      'no repeated name/date question');
    check('B5', turns.slice(1).every((t) => t.agent.agent_fallback_used === true),
      'agent brain defers to deterministic intake on every booking turn');
    check('B6', fieldsOf(last).check_in === '2026-06-12' && fieldsOf(last).guest_count === 3,
      'router extraction state preserved under agent brain');
    check('B7', last.out.quote && last.out.quote.quote_status !== 'ready',
      'no quote before package/accommodation answered (required field not skipped)');
    check('B8', last.agent.agent_booking_write_intent === false,
      'no booking write intent without required fields');
  }

  section('C. Direct package question — single messy turn');
  {
    const t = await runTurn("What's the difference between Malibu, Uluwatu and Waimea?", {}, { phone: '+34600490063' });
    check('C1', /malibu/i.test(t.reply) && /uluwatu/i.test(t.reply) && /waimea/i.test(t.reply),
      'direct comparison answer');
    check('C2', !isHandoff(t.out), 'no handoff');
    check('C3', t.agent.agent_final_reply_source === 'agent_brain', 'agent brain authored');
    check('C4', /€\s?249|€\s?349/i.test(t.reply), 'prices come from package config truth');
  }

  section('D. Golden booking path — Malibu/2/Aug 18-25/deposit (pg chain)');
  {
    const flow = await withPgClient(async (pg) => runFlow([
      'Malibu package for 2',
      'August 18 to August 25',
      'Deposit is fine',
    ], { phone: '+34600490064', contactName: 'Anna Test', pg }));
    const [t1, t2, t3] = flow.turns;
    check('D1', t2.out.quote && t2.out.quote.quote_status === 'ready', 'quote ready from quote engine');
    check('D2', /€\s?698/.test(t2.reply), 'quoted price comes from quote engine, not invented');
    check('D3', t3.out.payment_choice && t3.out.payment_choice.payment_choice_ready === true,
      'deposit choice accepted (payment intent)');
    check('D4', t3.out.hold_payment_draft_plan && t3.out.hold_payment_draft_plan.plan_status === 'ready',
      'hold/payment draft plan ready (booking intent)');
    check('D5', !isHandoff(t3.out), 'no handoff on golden path');
    check('D6', !/add.?on|lesson|rental/i.test(t3.reply) || /payment|deposit/i.test(t3.reply),
      'no add-on blocker before payment');
    check('D7', flow.turns.every((t) => t.agent.agent_fallback_used === true),
      'agent endorses deterministic quote/payment replies (no re-authoring of money facts)');
    check('D8', t3.agent.agent_booking_write_intent === true && t3.agent.agent_payment_link_intent === true,
      'agent observes booking write + payment link intent via existing gates');
    check('D9', t1.out.quote && t1.out.quote.quote_status !== 'ready',
      'no quote without dates (required fields enforced)');
  }

  section('E. Full live-style booking path (pg chain)');
  {
    const flow = await withPgClient(async (pg) => runFlow([
      'book a stay',
      'June 12 to June 20',
      '3',
      'Malibu',
      'deposit is fine',
    ], { phone: '+34600490065', contactName: 'Marco Test', pg }));
    const last = flow.last;
    check('E1', last.out.payment_choice && last.out.payment_choice.payment_choice_ready === true,
      'reaches payment path');
    check('E2', last.out.hold_payment_draft_plan && last.out.hold_payment_draft_plan.plan_status === 'ready',
      'reaches hold/payment draft path (executes when staging write gates enabled)');
    check('E3', flow.turns.every((t) => !isHandoff(t.out)), 'no handoff anywhere in flow');
    const replies = flow.turns.map((t) => t.reply);
    check('E4', new Set(replies).size === replies.length, 'no repeated questions/replies');
    const preQuote = flow.turns.slice(0, 3);
    check('E5', preQuote.every((t) => t.out.quote && t.out.quote.quote_status !== 'ready'),
      'no quote until package answered (intake sequencing preserved)');
    check('E6', preQuote.every((t) => !/€/.test(t.reply)),
      'no invented prices during intake');
    check('E7', preQuote.every((t) => t.agent.agent_booking_write_intent === false),
      'no booking write intent before required fields complete');
    check('E8', /€\s?960/.test(flow.turns[3].reply),
      'quoted total comes from quote engine (€960 for 8 nights x 3)');
  }

  section('F. Payment issue — truth check or specific handoff');
  {
    const t = await runTurn('I already paid but it still says unpaid', {}, { phone: '+34600490066' });
    check('F1', t.agent.agent_intent === 'payment_status_question', 'classified payment status question');
    check('F2', t.agent.agent_handoff_reason === 'payment_status_unverified',
      'specific handoff reason (not generic)');
    check('F3', /team|double-check|booking code|name/i.test(t.reply),
      'reply explains team check and asks something useful');
    check('F4', !/i can see a payment|payment is confirmed|you'?re all paid/i.test(t.reply),
      'does not invent payment truth without context');
    check('F5', t.agent.agent_tool_calls.includes('check_payment_status'),
      'tool plan includes check_payment_status');
  }

  section('G. Refund on paid booking — specific human handoff');
  {
    const t = await runTurn('I want a refund for a paid booking', {}, { phone: '+34600490067' });
    check('G1', t.agent.agent_handoff_required === true
      && t.agent.agent_handoff_reason === 'paid_booking_refund_or_change',
      'handoff with specific reason');
    check('G2', /team|get back to you/i.test(t.reply), 'reply hands to humans with summary');
    check('G3', !/refund (?:has been|is|will be) (?:processed|issued|sent)/i.test(t.reply),
      'no fake refund promise');
    check('G4', t.agent.agent_tool_calls.includes('mark_handoff')
      && t.agent.agent_tool_calls.includes('summarize_for_staff'),
      'tool plan includes mark_handoff + summarize_for_staff');
  }

  section('H. Cami voice — warm, concise, no internal language');
  {
    const leaks = allReplies.filter((r) => INTERNAL_WORDS_RE.test(r));
    check('H1', leaks.length === 0,
      leaks.length ? `internal words leaked: ${leaks[0].slice(0, 80)}` : 'no internal/technical words in any reply');
    const corporate = allReplies.filter((r) => CORPORATE_RE.test(r));
    check('H2', corporate.length === 0, 'no corporate tone');
    check('H3', allReplies.every((r) => r.length <= 900), 'replies stay concise (<=900 chars)');
    check('H4', allReplies.some((r) => /😊|🌊|👍|🙌|☀️|💛/u.test(r)), 'warm WhatsApp style present');
  }

  section('I. Layering contract — flag off keeps old behavior, repair guard works');
  {
    const off = await runTurn('tell me more about the packages', {}, { phone: '+34600490068', env: OFF_ENV });
    check('I1', off.agent.agent_brain_enabled === false && off.agent.agent_fallback_used === true,
      'flag off → agent brain inert, deterministic stack unchanged');
    check('I2', /malibu/i.test(off.reply), 'Stage 48a composer behavior intact with flag off');
    const { runLunaGuestAgentBrain } = require('./lib/luna-guest-agent-brain');
    const repaired = runLunaGuestAgentBrain({
      message_text: 'tell me more about the packages',
      prior_guest_context: {},
      brain_decision: null,
      candidate_reply: 'We have three packages. Want me to explain them quickly?',
      candidate_source: 'composer',
      payload: { result: { message_lane: 'general_question', detected_language: 'en', extracted_fields: {} } },
      env: AGENT_ENV,
    });
    check('I3', repaired.fallback_used === false && /malibu/i.test(repaired.final_reply || '')
      && !EXPLAIN_ASK_RE.test(repaired.final_reply || ''),
      'agent repairs dumb "want me to explain?" candidate into direct answer');
    const inert = runLunaGuestAgentBrain({
      message_text: 'June 12 to June 20',
      prior_guest_context: {},
      brain_decision: null,
      candidate_reply: 'Perfect — June 12 to June 20. How many guests will be staying?',
      candidate_source: 'composer',
      payload: { result: { message_lane: 'new_booking_inquiry', detected_language: 'en', extracted_fields: { check_in: '2026-06-12', check_out: '2026-06-20' } } },
      env: AGENT_ENV,
    });
    check('I4', inert.fallback_used === true && inert.missing_fields.includes('guest_count'),
      'agent defers to router question and tracks missing fields, never skips them');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
