/**
 * Stage 31c — live composer stale quote copy verifier.
 *
 * Usage:
 *   npm run verify:stage31c-live-composer-stale-quote-copy
 */

'use strict';

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });

const ROOT = path.join(__dirname, '..');
const QUOTE_FACTS = path.join(__dirname, 'lib', 'luna-quote-facts.js');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const PC = path.join(__dirname, 'lib', 'luna-guest-payment-choice-dry-run.js');
const META = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');
const REVIEW = path.join(__dirname, 'lib', 'luna-guest-inbound-review-dry-run.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage31c-live-composer-stale-quote-copy';

const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
const { assertComposerFactsMatchHoldFacts } = require('./lib/luna-quote-facts');
const { buildOpenDemoResultSummary } = require('./lib/meta-open-demo-inbound-adapter');
const { withPgClient } = require('./lib/pg-connect');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage31c-live-composer-stale-quote-copy.js  (Stage 31c)\n`);

section('A. Files + package');

check('A1', fs.existsSync(QUOTE_FACTS), 'quote facts module exists');
check('A2', fs.existsSync(COMPOSER), 'composer module exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const orchSrc = fs.readFileSync(ORCH, 'utf8');
const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const pcSrc = fs.readFileSync(PC, 'utf8');
const metaSrc = fs.readFileSync(META, 'utf8');
const reviewSrc = fs.readFileSync(REVIEW, 'utf8');

check('A4', composerSrc.includes('quote_refreshing'), 'composer quote_refreshing state');
check('A5', composerSrc.includes('resolveComposerDisplayFields'), 'composer display field resolver');
check('A6', orchSrc.includes('quoteLegacyReplyIsStale'), 'orchestrator blocks stale legacy quote replies');
check('A7', orchSrc.includes('buildQuoteFactsObservability'), 'orchestrator quote observability');
check('A8', pcSrc.includes('stalePrior'), 'payment choice stale prior guard');
check('A9', metaSrc.includes('quote_facts_used_by_composer'), 'open demo summary observability');
check('A10', reviewSrc.includes('quote_facts_used_by_composer'), 'inbound review chain observability');

section('B–H. Orchestrator correction flows');

(async () => {
  function ctxFrom(out) {
    return {
      message_lane: out.result && out.result.message_lane,
      extracted_fields: out.result && out.result.extracted_fields,
      quote: out.quote,
      payment_choice: out.payment_choice,
      availability: out.availability,
      hold_payment_draft_plan: out.hold_payment_draft_plan,
      result: { ...(out.result || {}), proposed_luna_reply: out.proposed_luna_reply },
      previous_quote_invalidated: out.result && out.result.previous_quote_invalidated,
      stale_quote_reason: out.result && out.result.stale_quote_reason,
      corrected_fields: out.result && out.result.corrected_fields,
      contact_name: 'Marco',
      whatsapp_guest_name: 'Marco',
    };
  }

  async function turn(ctx, message_text) {
    const out = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_name: 'Marco',
      contact_name: 'Marco',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, {
      reference_date: '2026-06-10',
      pg,
      guest_name: 'Marco',
      contact_name: 'Marco',
    }));
    if (!out || !out.result) throw new Error(`orchestrator returned empty for "${message_text}"`);
    return { out, ctx: ctxFrom(out) };
  }

  function replyOf(out) {
    return String(out.proposed_luna_reply || '');
  }

  function holdPackage(out) {
    const plan = out.hold_payment_draft_plan || {};
    const rec = plan.planned_records && plan.planned_records.booking_hold;
    return rec && rec.package_code ? String(rec.package_code).toLowerCase() : null;
  }

  function assertFactsMatch(out, id) {
    const composerFacts = out.result && out.result.quote_facts_used_by_composer;
    const writeFacts = out.result && out.result.quote_facts_used_by_hold_writer;
    const match = assertComposerFactsMatchHoldFacts(composerFacts, writeFacts);
    check(id, match.ok, match.ok ? 'composer facts match hold writer facts' : match.errors.join('; '));
    return match.ok;
  }

  function checkObs(out, id) {
    const r = out.result || {};
    check(`${id}a`, r.previous_quote_invalidated != null || r.quote_stale != null || r.quote_facts_used_by_composer,
      'observability fields present on result');
    check(`${id}b`, r.quote_facts_used_by_composer != null, 'quote_facts_used_by_composer set');
    check(`${id}c`, r.quote_facts_used_by_hold_writer != null, 'quote_facts_used_by_hold_writer set');
    const brain = r.conversation_brain || {};
    check(`${id}d`, brain.composer_state != null || brain.final_reply_source != null,
      'composer_state or final_reply_source on brain');
  }

  // 1. Package switch
  section('B. Package switch Malibu → Uluwatu');
  let ctx = {};
  let t1;
  ({ out: t1, ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 1'));
  check('B1', t1.quote && t1.quote.quote_status === 'ready', 'initial Malibu quote ready');
  check('B2', /malibu/i.test(replyOf(t1)), 'initial reply mentions Malibu');

  let t2;
  ({ out: t2, ctx } = await turn(ctx, 'actually make it Uluwatu'));
  check('B3', t2.result.previous_quote_invalidated === true, 'correction marks previous quote invalidated');
  check('B4', t2.result.stale_quote_reason === 'package_changed' || t2.quote.quote_stale === true,
    'stale reason recorded');
  check('B5', !/\bmalibu\b/i.test(replyOf(t2)), 'correction reply does not contain Malibu');
  check('B6', /uluwatu/i.test(replyOf(t2)), 'correction reply contains Uluwatu');
  check('B7', t2.quote && t2.quote.package_code === 'uluwatu', 'fresh quote package is uluwatu');
  checkObs(t2, 'B8');

  let t3;
  ({ out: t3, ctx } = await turn(ctx, 'deposit'));
  check('B9', !/\bmalibu\b/i.test(replyOf(t3)), 'deposit reply does not contain Malibu');
  check('B10', t3.payment_choice && t3.payment_choice.payment_choice_ready === true, 'deposit choice ready');
  check('B11', holdPackage(t3) === 'uluwatu', 'hold writer uses Uluwatu');
  assertFactsMatch(t3, 'B12');

  // 2. Date correction
  section('C. Date correction July 10–17 → July 11–18');
  ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 1'));
  const dateCorr = (await turn(ctx, 'actually July 11 to July 18')).out;
  check('C1', dateCorr.result.previous_quote_invalidated === true, 'date correction invalidates quote');
  check('C2', !/july\s*10|10\s*[-–]\s*17|july\s*17/i.test(replyOf(dateCorr)), 'reply avoids old July 10–17');
  check('C3', /july\s*11|11\s*[-–]\s*18|july\s*18/i.test(replyOf(dateCorr)), 'reply mentions July 11–18');
  check('C4', dateCorr.quote.check_in === '2026-07-11', 'quote check_in is July 11');
  check('C5', dateCorr.quote.check_out === '2026-07-18', 'quote check_out is July 18');

  const dateDep = (await turn(ctxFrom(dateCorr), 'deposit')).out;
  check('C6', dateDep.hold_payment_draft_plan && dateDep.hold_payment_draft_plan.plan_status === 'ready',
    'deposit plan ready after date correction');
  const holdRec = dateDep.hold_payment_draft_plan.planned_records.booking_hold;
  check('C7', holdRec.check_in === '2026-07-11' && holdRec.check_out === '2026-07-18',
    'hold uses corrected dates');
  assertFactsMatch(dateDep, 'C8');

  // 3. Guest count correction
  section('D. Guest count correction 1 → 2');
  ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 1'));
  const gcCorr = (await turn(ctx, 'actually we are 2')).out;
  check('D1', gcCorr.result.previous_quote_invalidated === true, 'guest count correction invalidates quote');
  check('D2', gcCorr.result.extracted_fields.guest_count === 2, 'guest count updated to 2');
  check('D3', gcCorr.quote.guest_count === 2, 'quote guest_count is 2');
  check('D4', gcCorr.quote.quote_total_cents !== t1.quote.quote_total_cents, 'quote total changed for 2 guests');

  const gcDep = (await turn(ctxFrom(gcCorr), 'deposit')).out;
  check('D5', !/how many guests/i.test(replyOf(gcDep)), 'no guest-count loop on deposit');
  check('D6', gcDep.hold_payment_draft_plan.planned_records.booking_hold.guest_count === 2,
    'hold uses 2 guests');
  assertFactsMatch(gcDep, 'D7');

  // 4. Reset after quote
  section('E. Reset after quote');
  ctx = {};
  ({ ctx } = await turn(ctx, 'Malibu July 10 to July 17 for 1'));
  const reset = (await turn(ctx, 'no no I want to create another booking')).out;
  check('E1', reset.result.new_booking_reset === true, 'reset detected');
  check('E2', reset.quote.quote_status === 'not_ready', 'quote cleared on reset');
  check('E3', reset.payment_choice.payment_choice_ready !== true, 'payment choice cleared on reset');
  check('E4', !/€299|malibu.*€/i.test(replyOf(reset)), 'no stale Malibu quote text after reset');

  // 5. Cash side question
  section('F. Cash side question preserves quote');
  ctx = {};
  ({ ctx } = await turn(ctx, 'July 1-5 for 1'));
  ({ ctx } = await turn(ctx, 'no thanks, I have my own stuff'));
  const cash = (await turn(ctx, 'can I pay cash?')).out;
  check('F1', !cash.result.previous_quote_invalidated, 'cash question does not invalidate quote');
  check('F2', cash.quote.quote_status === 'ready', 'quote preserved through cash question');
  check('F3', /cash|arrival|bank transfer/i.test(replyOf(cash)), 'cash question answered naturally');
  const cashDep = (await turn(ctxFrom(cash), 'deposit')).out;
  check('F4', cashDep.payment_choice.payment_choice_ready === true, 'deposit still works after cash question');

  // 6. Happy short-stay path
  section('G. Happy short-stay path');
  ctx = {};
  const shortTurns = [
    'hi',
    'book',
    'July 6-10',
    'just me',
    'Just the stay please',
    'deposit',
  ];
  const shortOut = [];
  for (const msg of shortTurns) {
    const step = await turn(ctx, msg);
    shortOut.push(step.out);
    ctx = step.ctx;
  }
  const lastShort = shortOut[shortOut.length - 1];
  check('G1', !shortOut.some((o) => /how can i help|what would you like to do/i.test(replyOf(o))
    && shortOut.indexOf(o) > 1), 'no greeting menu loop mid-flow');
  check('G2', shortOut.some((o) => o.quote && o.quote.quote_status === 'ready'), 'quote reached in short-stay flow');
  check('G3', lastShort.payment_choice && lastShort.payment_choice.payment_choice_ready === true,
    'deposit choice ready on short-stay path');
  check('G4', lastShort.hold_payment_draft_plan && lastShort.hold_payment_draft_plan.plan_status === 'ready',
    'hold plan ready on short-stay path');

  // 7. Open demo observability summary
  section('H. Open demo result observability');
  const summary = buildOpenDemoResultSummary({
    reviewOutcome: { ok: true, body: { review: { result: lastShort.result, quote: lastShort.quote } } },
    bookingWrite: {},
    bedAssignment: {},
    liveReply: {},
  });
  check('H1', summary.quote_facts_used_by_composer != null, 'summary has quote_facts_used_by_composer');
  check('H2', summary.quote_facts_used_by_hold_writer != null, 'summary has quote_facts_used_by_hold_writer');
  check('H3', summary.composer_state != null || summary.final_reply_source != null,
    'summary has composer_state or final_reply_source');

  section('I. Safety');
  check('I1', !orchSrc.includes('sendWhatsApp') && !orchSrc.includes('send_whatsapp'), 'no WhatsApp send');
  check('I2', !orchSrc.match(/\bactivate.*n8n\b/i), 'no n8n activation');
  check('I3', !orchSrc.includes('stripe.checkout.sessions.create'), 'no live Stripe in orchestrator');
  check('I4', !orchSrc.match(/deploy.*production/i), 'no production deploy hooks');

  section('Summary');
  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
