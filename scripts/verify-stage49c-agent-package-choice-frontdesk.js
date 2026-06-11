/**
 * Stage 49c-fix1 — package choice front-desk quality verifier.
 *
 * Usage:
 *   node scripts/verify-stage49c-agent-package-choice-frontdesk.js
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { normalizeGuestContextForChain } = require('./lib/luna-guest-context-merge');
const { withPgClient } = require('./lib/pg-connect');
const { buildPackageChoiceIntakeReply } = require('./lib/luna-guest-package-explainer');

const REF = '2026-06-11';
const AGENT_ENV = { ...process.env, LUNA_GUEST_AGENT_BRAIN_ENABLED: 'true' };

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const HANDOFF_RE = /looping in our Wolfhouse team|passing this to our team|hand off|handoff|staff will follow up/i;
const EXPLAIN_ASK_RE = /want me to explain them quickly|do you already know which one you prefer/i;
const STALL_RE = /I can look into the best option|not confirming availability yet/i;
const OLD_PACKAGE_ASK_RE = /Are you looking for a surf package like Malibu, or just accommodation/i;
const WELCOME_MENU_RE = /i can help you book a stay|checking some info/i;
const INTERNAL_RE = /\b(?:router|composer|orchestrator|dry.?run|stripe link)\b/i;

function paragraphCount(reply) {
  return String(reply || '').split(/\n\s*\n/).filter((p) => p.trim()).length;
}

async function runTurn(message, prior, opts) {
  const o = opts || {};
  const input = {
    client_slug: 'wolfhouse-somo',
    channel: 'dry_run',
    message_text: message,
    guest_phone: o.phone || '+34600490070',
    guest_context: prior || {},
    reference_date: REF,
  };
  if (o.contactName) input.contact_name = o.contactName;
  const ctx = { env: AGENT_ENV };
  if (o.pg) ctx.pg = o.pg;
  const out = await runGuestAutomationOrchestratorDryRun(input, ctx);
  return {
    out,
    reply: out.proposed_luna_reply || '',
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

function fieldsOf(turn) {
  return (turn.out && turn.out.result && turn.out.result.extracted_fields) || {};
}

function isHandoff(out) {
  const r = out && out.result;
  return !!(r && (r.safe_handoff_required || (r.handoff_reasons && r.handoff_reasons.length)));
}

(async () => {
  console.log('\nverify-stage49c-agent-package-choice-frontdesk.js  (Stage 49c-fix1)\n');

  section('A. Package choice prompt after dates + count');
  {
    const { turns, last } = await runFlow([
      'Hello',
      'lets book a stay',
      'June 11th to 20th',
      '3',
    ], { phone: '+34600490071' });
    const fourth = last;
    check('A1', !isHandoff(fourth.out), 'no handoff');
    check('A2', !OLD_PACKAGE_ASK_RE.test(fourth.reply), 'does not assume guest knows package names');
    check('A3', /malibu/i.test(fourth.reply) && /uluwatu/i.test(fourth.reply) && /waimea/i.test(fourth.reply),
      'explains all three packages before asking');
    check('A4', /🏡|🏄|🌊/.test(fourth.reply), 'WhatsApp emoji bullets present');
    check('A5', (fourth.reply.match(/\n/g) || []).length >= 3, 'readable spacing/newlines');
    check('A6', /stay only|gear included|lessons included/i.test(fourth.reply), 'direction-based choice question');
    check('A7', !WELCOME_MENU_RE.test(fourth.reply), 'no repeated welcome');
    check('A8', fieldsOf(fourth).check_in === '2026-06-11' && fieldsOf(fourth).guest_count === 3,
      'dates/count preserved');
  }

  section('B. Package info request — spaced formatting');
  {
    let ctx = normalizeGuestContextForChain({
      extracted_fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 },
    });
    const t = await runTurn('Tell me about the packages', ctx, { phone: '+34600490072' });
    check('B1', /malibu/i.test(t.reply) && /uluwatu/i.test(t.reply) && /waimea/i.test(t.reply),
      'direct explanation');
    check('B2', !EXPLAIN_ASK_RE.test(t.reply), 'no want me to explain');
    check('B3', paragraphCount(t.reply) >= 2 || (t.reply.match(/\n/g) || []).length >= 3,
      'not one giant paragraph');
    check('B4', (t.reply.match(/\n/g) || []).length >= 2, 'WhatsApp line breaks');
    check('B5', !INTERNAL_RE.test(t.reply), 'no internal language');
  }

  section('C. Package selection after explainer — ok Malibu');
  {
    const flow = await withPgClient(async (pg) => runFlow([
      'book a stay',
      'June 11 to June 20',
      '3',
      'Tell me about the packages',
      'ok Malibu',
    ], { phone: '+34600490073', contactName: 'Test Guest', pg }));
    const last = flow.last;
    check('C1', fieldsOf(last).package_interest === 'malibu', 'Malibu selected');
    check('C2', fieldsOf(last).check_in === '2026-06-11' && fieldsOf(last).guest_count === 3,
      'dates/count preserved');
    check('C3', !STALL_RE.test(last.reply), 'no availability stall copy');
    check('C4', !isHandoff(last.out), 'no handoff');
    check('C5', last.out.quote && last.out.quote.quote_status === 'ready', 'quote ready from quote engine');
    check('C6', /€/.test(last.reply) && /deposit|which do you prefer/i.test(last.reply),
      'asks deposit vs full with quote values');
    check('C7', !/invented|estimate/i.test(last.reply), 'no invented pricing language');
  }

  section('D. Beginner recommendation');
  {
    let ctx = normalizeGuestContextForChain({
      extracted_fields: { check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3 },
    });
    const t = await runTurn('what package should we do? we are beginners', ctx, { phone: '+34600490074' });
    check('D1', /waimea/i.test(t.reply), 'mentions Waimea');
    check('D2', /easiest|lessons|beginner/i.test(t.reply), 'recommends Waimea for beginners');
    check('D3', /check waimea|want me to check/i.test(t.reply), 'asks to check Waimea');
    check('D4', !/guaranteed|definitely will/i.test(t.reply), 'no fake certainty');
  }

  section('E. Direct package selection + dates');
  {
    const flow = await withPgClient(async (pg) => runFlow([
      'Malibu package for 3',
      'June 11 to June 20',
    ], { phone: '+34600490075', contactName: 'Direct Guest', pg }));
    const last = flow.last;
    check('E1', last.out.quote && last.out.quote.quote_status === 'ready', 'quote path');
    check('E2', /deposit|which do you prefer|full/i.test(last.reply), 'payment choice prompt');
    check('E3', !isHandoff(last.out), 'no handoff');
  }

  section('F. Golden path unchanged');
  {
    const flow = await withPgClient(async (pg) => runFlow([
      'Malibu package for 2',
      'August 18 to August 25',
      'Deposit is fine',
    ], { phone: '+34600490076', contactName: 'Golden Guest', pg }));
    const last = flow.last;
    check('F1', last.out.quote && last.out.quote.quote_status === 'ready', 'quote ready');
    check('F2', last.out.payment_choice && last.out.payment_choice.payment_choice_ready === true,
      'deposit accepted');
    check('F3', last.out.hold_payment_draft_plan && last.out.hold_payment_draft_plan.plan_status === 'ready',
      'hold/payment plan ready');
    check('F4', !isHandoff(last.out), 'no handoff');
  }

  section('G. Copy quality — intake builder + live turns');
  {
    const raw = buildPackageChoiceIntakeReply('en', {
      check_in: '2026-06-11', check_out: '2026-06-20', guest_count: 3,
    });
    check('G1', paragraphCount(raw) >= 3, 'package intake not dense paragraph');
    check('G2', !OLD_PACKAGE_ASK_RE.test(raw), 'intake builder avoids old package ask');
    check('G3', /\?/.test(raw), 'one clear next question');
    check('G4', /lovely|😊/i.test(raw), 'Cami warm tone');
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error('verifier crashed:', err);
  process.exit(1);
});
