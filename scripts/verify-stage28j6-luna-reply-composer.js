/**
 * Stage 28j.6 — Luna Reply Composer MVP verifier.
 *
 * Usage:
 *   npm run verify:stage28j6-luna-reply-composer
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { withPgClient } = require('./lib/pg-connect');

const ROOT = path.join(__dirname, '..');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const EXECUTE = path.join(__dirname, 'lib', 'open-demo-whatsapp-inbound-execute.js');
const GATE = path.join(__dirname, 'lib', 'open-demo-whatsapp-gate.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage28j6-luna-reply-composer';

const DRY_RUN_RE = /I am not confirming the booking|I am not creating a hold|not sending a payment link yet/i;
const INTRO_RE = /(?:Hi|Hey)[!,.]?\s+I'?m\s+Luna\s+from\s+Wolfhouse\s*🌊/gi;
const INTERNAL_RE = /\b(?:dry run|quote_status|payment_choice|automation gate|hold writer)\b/i;
const PACKAGE_RE = /\b(?:Malibu|Uluwatu|Waimea)\b/i;

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function guestContextFromOrch(o) {
  return {
    message_lane: o.result && o.result.message_lane,
    readiness_state: o.result && o.result.readiness_state,
    booking_intake_ready: o.result && o.result.booking_intake_ready,
    missing_required_fields: o.result && o.result.missing_required_fields,
    readiness_missing_fields: o.result && o.result.readiness_missing_fields,
    extracted_fields: o.result && o.result.extracted_fields,
    package_night_rule: o.result && o.result.package_night_rule,
    result: o.result,
    availability: o.availability,
    quote: o.quote,
    payment_choice: o.payment_choice,
    hold_payment_draft_plan: o.hold_payment_draft_plan,
  };
}

async function runShortStayFlow(turns, ctxExtra) {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  let ctx = {};
  const out = [];
  const extra = ctxExtra || {};
  for (const message_text of turns) {
    const o = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_name: extra.guest_name || null,
      contact_name: extra.contact_name || extra.guest_name || null,
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, {
      reference_date: '2026-06-10',
      pg,
      guest_name: extra.guest_name || null,
      contact_name: extra.contact_name || extra.guest_name || null,
      ...extra,
    }));
    out.push({ message_text, o });
    ctx = {
      ...guestContextFromOrch(o),
      result: {
        ...(o.result || {}),
        proposed_luna_reply: o.proposed_luna_reply,
      },
    };
  }
  return out;
}

console.log('\nverify-stage28j6-luna-reply-composer.js  (Stage 28j.6)\n');

for (const f of [COMPOSER, ORCH, EXECUTE, GATE, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE, 'utf8');
const gateSrc = fs.readFileSync(GATE, 'utf8');
const pkg = fs.existsSync(PKG_FILE) ? JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) : {};

section('A. Module + wiring');

check('A1', composerSrc.includes('function composeLunaGuestReply'),
  'composeLunaGuestReply exported');
check('A2', orchSrc.includes('composeLunaGuestReply')
  && orchSrc.includes('tryComposeBookingReply'),
  'orchestrator wires composer at final reply boundary');
check('A3', executeSrc.includes('composeLunaGuestReply'),
  'open-demo execute uses composer for live staging bridge');
check('A4', gateSrc.includes('composeLunaGuestReply'),
  'open-demo gate delegates live bridge to composer');

const composer = require('./lib/luna-guest-reply-composer');
check('A5', typeof composer.composeLunaGuestReply === 'function',
  'composeLunaGuestReply importable');

section('B. Short-stay booking conversation');

(async () => {
  const flow = await runShortStayFlow([
    'hi',
    'book a stay',
    'July 1-5',
    'Ty',
    'just me',
    'Just the stay please',
    'deposit',
  ]);

  const hi = flow[0].o;
  const book = flow[1].o;
  const dates = flow[2].o;
  const nameTurn = flow[3].o;
  const guests = flow[4].o;
  const addons = flow[5].o;
  const deposit = flow[6].o;

  check('B1', /Hey! I'm Luna from Wolfhouse 🌊/i.test(hi.proposed_luna_reply)
    && /book a stay|checking some info/i.test(hi.proposed_luna_reply),
    'greeting uses warm Luna style');
  check('B2', hi.result.conversation_brain.final_reply_source === 'luna_reply_composer',
    'greeting sourced from composer');

  check('B3', /dates/i.test(book.proposed_luna_reply)
    && !/didn't catch/i.test(book.proposed_luna_reply),
    '"book a stay" asks dates without didn\'t-catch language');

  check('B4', dates.result.extracted_fields.check_in === '2026-07-01'
    && dates.result.extracted_fields.check_out === '2026-07-05',
    'July 1-5 parsed');
  check('B5', /grab your name|name/i.test(dates.proposed_luna_reply)
    && !/how many guests/i.test(dates.proposed_luna_reply),
    'July 1-5 asks booking name before guest count');

  check('B6', nameTurn.result.extracted_fields.guest_name === 'Ty',
    '"Ty" captured as guest_name');
  check('B6b', /guests/i.test(nameTurn.proposed_luna_reply),
    'after name Luna asks guest count');
  check('B7', guests.result.extracted_fields.guest_count === 1,
    '"just me" → guest_count=1');
  check('B8', /€180|180/.test(guests.proposed_luna_reply)
    && !PACKAGE_RE.test(guests.proposed_luna_reply),
    'under-7 accommodation quote without package names');
  check('B8b', /wetsuit|surfboard|lessons|just the stay/i.test(guests.proposed_luna_reply),
    'add-ons asked after accommodation quote');

  check('B9', /accommodation only/i.test(addons.proposed_luna_reply)
    && /deposit|full/i.test(addons.proposed_luna_reply),
    'addons skipped → deposit/full prompt');
  check('B10', !DRY_RUN_RE.test(deposit.proposed_luna_reply),
    'deposit reply has no dry-run language');
  check('B11', deposit.result.conversation_brain.final_reply_source === 'luna_reply_composer',
    'deposit turn composer-owned');

  let introCount = 0;
  for (const step of flow) {
    const matches = String(step.o.proposed_luna_reply || '').match(INTRO_RE);
    introCount += matches ? matches.length : 0;
  }
  check('B12', introCount <= 1, 'no repeated intro mid-flow');

  check('B13', !INTERNAL_RE.test(flow.map((s) => s.o.proposed_luna_reply).join(' ')),
    'no internal terms in composer replies');

  const waFlow = await runShortStayFlow(['hi', 'book a stay', 'July 1-5'], { guest_name: 'Ty' });
  const waDates = waFlow[2].o;
  check('B14', waDates.result.extracted_fields.guest_name === 'Ty'
    && /guests/i.test(waDates.proposed_luna_reply)
    && !/what name/i.test(waDates.proposed_luna_reply),
    'WhatsApp profile name skips name question and asks guest count');

  section('C. 7-night package flow');

  const pkgFlow = await runShortStayFlow([
    'Hi, we are interested in the Malibu package',
    'July 10 to July 17',
    'Sarah',
    '2',
    'no add nothing',
    'deposit',
  ]);
  const pkgQuoteTurn = pkgFlow.find((s) => s.o.quote && s.o.quote.quote_status === 'ready') || pkgFlow[3];
  const pkgPayTurn = pkgFlow.find((s) => /deposit|full/i.test(s.o.proposed_luna_reply || '')) || pkgFlow[4];
  check('C1', pkgQuoteTurn.o.quote && pkgQuoteTurn.o.quote.quote_status === 'ready',
    '7-night Malibu quote ready with staging DB');
  check('C2', /deposit|full/i.test(pkgPayTurn.o.proposed_luna_reply || ''),
    '7-night package flow reaches payment choice');
  const pkgComposerTurn = pkgFlow.find((s) => s.o.result?.conversation_brain?.final_reply_source === 'luna_reply_composer'
    && /deposit|full|stay comes to/i.test(s.o.proposed_luna_reply || '')) || pkgPayTurn;
  check('C3', pkgComposerTurn.o.result.conversation_brain.final_reply_source === 'luna_reply_composer',
    '7-night package reply composer-owned when covered');

  section('D. Side question context');

  let ctx = {};
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  const t1 = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo', message_text: '2 people July 10 to July 17', guest_context: ctx,
    reference_date: '2026-06-10',
  }, { reference_date: '2026-06-10' });
  ctx = guestContextFromOrch(t1);
  const t2 = await runGuestAutomationOrchestratorDryRun({
    client_slug: 'wolfhouse-somo', message_text: 'what are the packages?', guest_context: ctx,
    reference_date: '2026-06-10',
  }, { reference_date: '2026-06-10' });
  check('D1', t2.result.extracted_fields.check_in === '2026-07-10',
    'side question preserves booking dates');

  section('E. Safety');

  check('E1', !executeSrc.includes('runGuestConfirmation'),
    'no confirmation send in execute');
  check('E2', !executeSrc.includes('runGuestStripePaymentTruthApplyApproved'),
    'no payment truth from chat execute');
  check('E3', gateSrc.includes('sk_live_') || gateSrc.includes('isStripeLiveSecretKey'),
    'live Stripe guard remains');
  check('E4', !orchSrc.includes('calls_n8n: true'),
    'orchestrator does not activate n8n');
  check('E5', gateSrc.includes('production_blocked'),
    'production guard present in open-demo gates');

  section('F. package.json');

  check('F1', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT} registered`);

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
