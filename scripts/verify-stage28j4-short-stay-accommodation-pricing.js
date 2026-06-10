/**
 * Stage 28j.4 — Verifier: Luna short-stay accommodation uses Staff Portal pricing.
 *
 * Usage:
 *   npm run verify:stage28j4-short-stay-accommodation-pricing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const ROUTER = path.join(__dirname, 'lib', 'luna-guest-message-router.js');
const PKG_NIGHT = path.join(__dirname, 'lib', 'wolfhouse-package-night-rules.js');
const SHORT_STAY = path.join(__dirname, 'lib', 'wolfhouse-short-stay-pricing.js');
const QUOTE_CALC = path.join(__dirname, 'lib', 'wolfhouse-quote-calculator.js');
const INTAKE = path.join(__dirname, 'lib', 'luna-guest-message-intake.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28j4-short-stay-accommodation-pricing';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

const PACKAGE_NAMES_RE = /\b(?:malibu|uluwatu|waimea)\b/i;

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
    ctx = o.result ? {
      ...ctx,
      message_lane: o.result.message_lane,
      readiness_state: o.result.readiness_state,
      booking_intake_ready: o.result.booking_intake_ready,
      extracted_fields: o.result.extracted_fields,
      detected_language: o.result.detected_language,
      package_night_rule: o.result.package_night_rule,
      quote: o.quote,
      result: o.result,
    } : ctx;
  }
  return out;
}

function asksPackageChoice(reply) {
  return /which package|Malibu, Uluwatu,? (?:or |and )?Waimea\?/i.test(reply || '');
}

function mentionsWeeklyPackages(reply) {
  return PACKAGE_NAMES_RE.test(reply || '');
}

function asksAddonsBeforeQuote(flow) {
  const guestTurn = flow.find((t) => t.message_text === '1');
  if (!guestTurn) return true;
  const reply = guestTurn.orchestrator.proposed_luna_reply || '';
  const quoteReady = guestTurn.orchestrator.quote
    && guestTurn.orchestrator.quote.quote_status === 'ready';
  if (!quoteReady) return true;
  const addonsAsked = /wetsuit|surfboard|lessons/i.test(reply);
  const priceShown = /€\s*180|180\.00/i.test(reply);
  return !(addonsAsked && priceShown);
}

console.log('\nverify-stage28j4-short-stay-accommodation-pricing.js  (Stage 28j.4)\n');

for (const f of [ORCH, ROUTER, PKG_NIGHT, SHORT_STAY, QUOTE_CALC, INTAKE, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A0', !!pkg.scripts[SCRIPT], 'verifier npm script registered');

(async () => {
  const { extractLunaGuestMessageIntake } = require('./lib/luna-guest-message-intake');
  const { quoteShortStayAccommodation, ceil5 } = require('./lib/wolfhouse-short-stay-pricing');
  const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');

  section('1. Date parsing — July 1-5');
  const dates = extractLunaGuestMessageIntake({ message_text: 'July 1-5' }, { reference_date: '2026-06-10' });
  check('1A', dates.check_in === '2026-07-01' && dates.check_out === '2026-07-05',
    'July 1-5 → 2026-07-01 / 2026-07-05');

  section('2–9. Core short-stay accommodation flow');
  const flow = await runTurns(['hi', 'book a stay', 'July 1-5', 'Ty', '1', 'no add nothing']);
  const tDates = flow[2];
  const tGuests = flow[4];
  const tNoAddons = flow[5];

  check('2A', !mentionsWeeklyPackages(tDates.orchestrator.proposed_luna_reply),
    'under-7 no-package: July 1-5 reply does not mention Malibu/Uluwatu/Waimea');
  check('3A', tGuests.result.package_night_rule === 'short_stay_accommodation',
    'under-7 no-package uses short_stay_accommodation rule');
  check('3B', tGuests.result.extracted_fields.package_interest === 'accommodation_only',
    'package_interest defaults to accommodation_only');

  const staffQuote = quoteShortStayAccommodation({
    client_slug: 'wolfhouse-somo',
    check_in: '2026-07-01',
    check_out: '2026-07-05',
    guest_count: 1,
  });
  const lunaQuote = tGuests.orchestrator.quote;
  check('4A', staffQuote.success && lunaQuote && lunaQuote.quote_status === 'ready',
    'Luna produces accommodation quote');
  check('4B', lunaQuote.quote_total_cents === staffQuote.total_cents,
    'Luna quote total matches Staff Portal helper');
  check('5A', staffQuote.total_cents === 18000,
    'price = Malibu weekly ÷ 7 ceil5 × 4 nights × 1 guest → €180');
  check('5B', /ceil5|per_night_ceil5/i.test(staffQuote.formula_summary || ''),
    'formula uses ceil5 per-night from Malibu weekly reference');

  check('6A', !asksAddonsBeforeQuote(flow),
    'add-ons question comes after accommodation quote');
  check('6B', /wetsuit|surfboard|lessons/i.test(tGuests.orchestrator.proposed_luna_reply),
    'guest-count turn asks about wetsuit/surfboard/lessons');

  check('7A', tNoAddons.result.extracted_fields.package_interest === 'accommodation_only',
    '"no add nothing" → accommodation_only');
  check('7B', /accommodation only|no add-ons|deposit now|pay the full/i.test(tNoAddons.orchestrator.proposed_luna_reply),
    '"no add nothing" acknowledged and advances to payment choice');
  check('8A', !asksPackageChoice(tNoAddons.orchestrator.proposed_luna_reply),
    'no package prompt after accommodation-only choice');
  check('9A', !/team needs to confirm|passing this to our team/i.test(tGuests.orchestrator.proposed_luna_reply),
    'no staff handoff on normal short-stay quote');
  check('9B', tGuests.orchestrator.proposed_next_action !== 'await_staff_accommodation_confirmation',
    'no await_staff_accommodation_confirmation on quoted short stay');

  section('10. 7-night package flow still works');
  const weekFlow = await runTurns(['hi', 'book a stay', 'July 10-17', 'Ty', '1', 'explain the packages', 'Malibu']);
  const w4 = weekFlow[4];
  const w6 = weekFlow[6];
  check('10A', w4.result.package_night_rule === 'weekly_explain_before_choice',
    '7-night stay gets weekly_explain_before_choice');
  check('10B', w6.result.extracted_fields.package_interest === 'malibu'
    && w6.orchestrator.availability
    && w6.orchestrator.availability.availability_check_attempted === true,
    'Malibu on 7-night stay enters availability/quote path');

  section('11. No Stripe/payment-link/confirmation/n8n changes');
  const orchSrc = fs.readFileSync(ORCH, 'utf8');
  let unsafe = 0;
  for (const t of flow) {
    const o = t.orchestrator;
    if (o.stripe_link_created === true || o.payment_link_sent === true
      || o.confirmation_sent === true || o.calls_n8n === true
      || o.no_write_performed === false) unsafe++;
  }
  check('11A', unsafe === 0, 'orchestrator responses remain dry-run safe');
  check('11B', !orchSrc.includes("require('stripe')"),
    'no new Stripe wiring in orchestrator');
  check('11C', calculateWolfhouseQuote && quoteShortStayAccommodation,
    'reuses existing calculateWolfhouseQuote via wolfhouse-short-stay-pricing');

  console.log(`\nStage 28j.4 verifier: ${passes} passed, ${failures} failed`);
  console.log(failures === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
