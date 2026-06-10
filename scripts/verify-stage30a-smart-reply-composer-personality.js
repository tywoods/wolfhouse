/**
 * Stage 30a — smart reply composer personality verifier.
 *
 * Usage:
 *   npm run verify:stage30a-smart-reply-composer-personality
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { withPgClient } = require('./lib/pg-connect');

const ROOT = path.join(__dirname, '..');
const COMPOSER = path.join(__dirname, 'lib', 'luna-guest-reply-composer.js');
const CONTRACT = path.join(__dirname, 'lib', 'luna-guest-reply-style-contract.js');
const ORCH = path.join(__dirname, 'lib', 'luna-guest-automation-orchestrator-dry-run.js');
const RUNNER = path.join(__dirname, 'run-luna-conversation-state-machine-tests.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:stage30a-smart-reply-composer-personality';

const {
  composeLunaGuestReply,
  buildReplyForState,
  COMPOSER_STATES,
} = require('./lib/luna-guest-reply-composer');
const {
  FORBIDDEN_GUEST_PHRASES,
  isForbiddenGuestCopy,
  isFormDevCopy,
  sanitizeGuestReply,
  validateComposerFacts,
  LUNA_IDENTITY,
  groundingRulesSummary,
} = require('./lib/luna-guest-reply-style-contract');

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

console.log(`\nverify-stage30a-smart-reply-composer-personality.js  (Stage 30a)\n`);

section('A. Files + package');

check('A1', fs.existsSync(CONTRACT), 'style contract exists');
check('A2', fs.existsSync(COMPOSER), 'reply composer exists');
const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
check('A3', pkg.scripts && pkg.scripts[SCRIPT], `npm script ${SCRIPT}`);

const composerSrc = fs.readFileSync(COMPOSER, 'utf8');
const contractSrc = fs.readFileSync(CONTRACT, 'utf8');
const orchSrc = fs.readFileSync(ORCH, 'utf8');
const runnerSrc = fs.readFileSync(RUNNER, 'utf8');

section('B. Personality / style contract');

check('B1', contractSrc.includes('LUNA_IDENTITY'), 'Luna identity defined');
check('B2', LUNA_IDENTITY.place === 'Wolfhouse', 'Wolfhouse identity');
check('B3', contractSrc.includes('TONE_RULES'), 'tone rules defined');
check('B4', FORBIDDEN_GUEST_PHRASES.includes('orchestrator'), 'forbids orchestrator term');
check('B5', FORBIDDEN_GUEST_PHRASES.includes('no_write_performed'), 'forbids no_write_performed');
check('B6', typeof groundingRulesSummary === 'function', 'grounding rules export');
check('B7', isForbiddenGuestCopy('This is a dry run test'), 'forbidden copy detected');
check('B8', !isForbiddenGuestCopy('Good news — we have space for those dates.'), 'natural copy allowed');

section('C. Composer owns core booking states');

const requiredStates = [
  'greeting', 'ask_dates', 'confirm_dates', 'ask_guests', 'ask_guest_name',
  'explain_packages', 'accommodation_quote_ready', 'package_quote_ready',
  'addons_none_confirmed', 'ask_payment_choice', 'payment_choice_ack',
  'stripe_test_link_created', 'payment_link_sent', 'payment_pending_no_link',
  'payment_link_failed', 'payment_received_preview_ready', 'confirmation_sent_ack',
];
for (const st of requiredStates) {
  check('C', COMPOSER_STATES.includes(st), `composer state ${st}`);
}

check('C2', composerSrc.includes('luna-guest-reply-style-contract'), 'composer imports style contract');
check('C3', composerSrc.includes('buildPackageExplainerReply'), 'package explainer via composer');
check('C4', composerSrc.includes('validateComposerFacts'), 'fact grounding enforced');

section('D. Grounding — no invention');

const noQuote = validateComposerFacts('ask_payment_choice', {});
check('D1', noQuote.includes('quote_or_deposit_cents_required'), 'payment choice requires quote facts');
const noLink = validateComposerFacts('stripe_test_link_created', { quote_total_cents: 18000, deposit_amount_cents: 10000 });
check('D2', noLink.includes('payment_link_url_required'), 'stripe link requires URL fact');
const okQuote = validateComposerFacts('accommodation_quote_ready', { quote_total_cents: 18000 });
check('D3', okQuote.length === 0, 'quote state ok with facts');

const shortStayReply = buildReplyForState('accommodation_quote_ready', {
  lang: 'en',
  fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
  quote: { quote_status: 'ready', quote_total_cents: 18000 },
  availability: { availability_status: 'available' },
  plan: {}, pc: {}, result: {}, stripe: {}, facts: { quote_total_cents: 18000 },
});
check('D4', shortStayReply && shortStayReply.includes('€180'), 'short-stay quote includes €180');
check('D5', shortStayReply && !isForbiddenGuestCopy(shortStayReply), 'short-stay quote has no forbidden terms');

const noAddons = buildReplyForState('addons_none_confirmed', {
  lang: 'en',
  fields: { check_in: '2026-07-01', check_out: '2026-07-05', guest_count: 1 },
  quote: { quote_status: 'ready', quote_total_cents: 18000, deposit_options: { deposit_required_cents: 10000 } },
  plan: {}, pc: {}, result: {}, availability: {}, stripe: {},
  facts: { quote_total_cents: 18000, deposit_amount_cents: 10000 },
});
check('D6', noAddons && /accommodation only/i.test(noAddons), 'no-add-ons copy natural');
check('D7', noAddons && noAddons.includes('€180'), 'no-add-ons includes full total');

const depositLink = buildReplyForState('stripe_test_link_created', {
  lang: 'en',
  fields: {},
  quote: { quote_total_cents: 18000, deposit_options: { deposit_required_cents: 10000 } },
  plan: { payment_amount_cents: 10000 },
  pc: { payment_choice: 'deposit' },
  result: {},
  availability: {},
  stripe: { stripe_checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_abc' },
  facts: { quote_total_cents: 18000, deposit_amount_cents: 10000, payment_link_url: 'https://checkout.stripe.com/c/pay/cs_test_abc' },
});
check('D8', depositLink && depositLink.includes('cs_test_abc'), 'deposit link copy includes URL');
check('D9', depositLink && /held your stay/i.test(depositLink), 'deposit link copy natural');

const linkFailed = buildReplyForState('payment_link_failed', {
  lang: 'en',
  fields: {},
  quote: { deposit_options: { deposit_required_cents: 10000 } },
  plan: { payment_amount_cents: 10000 },
  pc: { payment_choice: 'deposit' },
  result: {}, availability: {}, stripe: {},
  facts: { deposit_amount_cents: 10000 },
});
check('D10', linkFailed && /hiccup|shortly/i.test(linkFailed), 'link failure fallback natural');

const paidPreview = buildReplyForState('payment_received_preview_ready', {
  lang: 'en',
  fields: {},
  quote: {},
  plan: {}, pc: {}, result: {}, availability: {}, stripe: {},
  facts: { amount_paid_cents: 10000, balance_due_cents: 8000, payment_status: 'deposit_paid', booking_code: 'WH-G27-TEST' },
});
check('D11', paidPreview && paidPreview.includes('€100'), 'payment received mentions paid amount');
check('D12', paidPreview && paidPreview.includes('€80'), 'payment received mentions balance');

section('E. Legacy internal copy blocked');

const legacyBad = 'Thanks — I noted you would like to pay the deposit. I am not confirming the booking yet.';
check('E1', sanitizeGuestReply(legacyBad) === null, 'legacy payment-choice copy sanitized away');
check('E2', isFormDevCopy('Thanks — for your stay I estimate a total of €180'), 'form dev copy detected');

section('F. Safety');

check('F1', !orchSrc.includes('sendLunaBookingConfirmation') || !composerSrc.includes('sendLunaBookingConfirmation'), 'no confirmation send in composer');
check('F2', !composerSrc.match(/\bactivate.*n8n\b|\bn8n\.(activate|trigger)/i), 'composer does not activate n8n');
check('F3', !composerSrc.includes('stripe.checkout.sessions.create'), 'composer does not create Stripe');
check('F4', orchSrc.includes('tryComposeBookingReply'), 'orchestrator still uses composer first');
check('F5', runnerSrc.includes('luna-guest-reply-style-contract'), 'tester uses style contract blacklist');

section('G. Short-stay orchestrator flow');

(async () => {
  const { runGuestAutomationOrchestratorDryRun } = require('./lib/luna-guest-automation-orchestrator-dry-run');
  let ctx = {};
  const turns = ['hi', 'book a stay', 'July 1-5', '1', 'no thanks, i have my own stuff', 'deposit'];
  let last = null;
  for (const message_text of turns) {
    last = await withPgClient((pg) => runGuestAutomationOrchestratorDryRun({
      client_slug: 'wolfhouse-somo',
      channel: 'whatsapp',
      message_text,
      guest_phone: '+491726422307',
      guest_name: 'Marco',
      contact_name: 'Marco',
      guest_context: ctx,
      reference_date: '2026-06-10',
    }, { reference_date: '2026-06-10', pg, guest_name: 'Marco', contact_name: 'Marco' }));
    ctx = {
      message_lane: last.result && last.result.message_lane,
      extracted_fields: last.result && last.result.extracted_fields,
      quote: last.quote,
      payment_choice: last.payment_choice,
      availability: last.availability,
      result: { ...(last.result || {}), proposed_luna_reply: last.proposed_luna_reply },
    };
  }
  const src = last.result && last.result.conversation_brain && last.result.conversation_brain.final_reply_source;
  const reply = last.proposed_luna_reply || '';
  check('G1', src === 'luna_reply_composer', 'short-stay flow uses composer');
  check('G2', !isForbiddenGuestCopy(reply), 'final reply has no forbidden terms');
  check('G3', /deposit|payment link/i.test(reply), 'deposit turn natural');
  check('G4', last.payment_choice && last.payment_choice.payment_choice === 'deposit', 'deposit choice preserved');

  section('H. Syntax');
  for (const f of [COMPOSER, CONTRACT, ORCH, RUNNER, __filename]) {
    try {
      execSync(`node --check "${f}"`, { stdio: 'pipe' });
      pass('H', `${path.basename(f)} passes node --check`);
    } catch {
      fail('H', `${path.basename(f)} syntax error`);
    }
  }

  section('Summary');
  console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
