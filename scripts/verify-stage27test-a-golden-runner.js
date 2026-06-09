/**
 * Stage 27test-a — Verifier for Luna guest golden message bulk runner.
 *
 * Usage:
 *   npm run verify:stage27test-a-golden-runner
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const RUNNER = path.join(__dirname, 'run-luna-guest-golden-tests.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'luna-guest-golden-messages.json');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27TEST-A-GOLDEN-RUNNER.md');
const SCRIPT = 'verify:stage27test-a-golden-runner';
const REL = 'scripts/verify-stage27test-a-golden-runner.js';
const INBOUND_ROUTE = '/staff/bot/guest-inbound-review-dry-run';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

console.log('\nverify-stage27test-a-golden-runner.js  (Stage 27test-a)\n');

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('0', 'verifier passes node --check');
} catch {
  fail('0', 'verifier syntax error');
}

section('A. Fixture file');

if (!fs.existsSync(FIXTURE)) {
  fail('A1', 'luna-guest-golden-messages.json missing');
} else {
  pass('A1', 'fixture file exists');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  } catch {
    fail('A2', 'fixture JSON invalid');
    data = null;
  }
  if (data) {
    if (Array.isArray(data.cases) && data.cases.length >= 100) {
      pass('A2', `fixture has ${data.cases.length} cases (>= 100)`);
    } else {
      fail('A2', `fixture case count ${data.cases && data.cases.length} < 100`);
    }

    const langs = new Set(data.cases.map((c) => c.language));
    for (const lang of ['en', 'it', 'es', 'de', 'fr']) {
      if (langs.has(lang)) pass(`A3.${lang}`, `includes language ${lang}`);
      else fail(`A3.${lang}`, `missing language ${lang}`);
    }

    const cats = new Set(data.cases.map((c) => c.category));
    const requiredCats = [
      ['booking_en', /booking_en|booking_partial|booking_full|booking_it|booking_es|booking_de|booking_fr/],
      ['non_booking', /service_addon|transfer|payment_|checkin_faq|cancel_change|angry_unclear|off_topic/],
    ];
    if ([...cats].some((c) => /booking/.test(c))) pass('A4a', 'includes booking categories');
    else fail('A4a', 'missing booking categories');
    if ([...cats].some((c) => /service_addon|transfer|payment_|checkin_faq|cancel_change|angry|off_topic/.test(c))) {
      pass('A4b', 'includes non-booking categories');
    } else {
      fail('A4b', 'missing non-booking categories');
    }

    const sample = data.cases[0];
    if (sample && sample.id && sample.language && sample.message_text && sample.expected) {
      pass('A5', 'case shape includes id/language/message_text/expected');
    } else {
      fail('A5', 'case shape incomplete');
    }
    if (data.cases.every((c) => c.expected && c.expected.message_lane)) {
      pass('A6', 'all cases define expected.message_lane');
    } else {
      fail('A6', 'some cases missing expected.message_lane');
    }
  }
}

section('B. Runner script');

if (fs.existsSync(RUNNER)) pass('B1', 'run-luna-guest-golden-tests.js exists');
else fail('B1', 'runner missing');

const runnerSrc = fs.existsSync(RUNNER) ? fs.readFileSync(RUNNER, 'utf8') : '';
const runnerCode = runnerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

try {
  execSync(`node --check "${RUNNER}"`, { stdio: 'pipe' });
  pass('B2', 'runner passes node --check');
} catch {
  fail('B2', 'runner syntax error');
}

if (runnerSrc.includes(INBOUND_ROUTE)) pass('B3', 'runner targets guest-inbound-review-dry-run');
else fail('B3', 'runner missing inbound review route');

if (runnerSrc.includes('runGuestInboundReviewDryRun')) pass('B4', 'runner supports local function mode');
else fail('B4', 'local function mode missing');

if (runnerSrc.includes('--limit') && runnerSrc.includes('--language') && runnerSrc.includes('--category')) {
  pass('B5', 'runner supports limit/language/category filters');
} else {
  fail('B5', 'runner filter flags missing');
}

if (runnerSrc.includes('--fail-fast') && runnerSrc.includes('--json')) {
  pass('B6', 'runner supports --json and --fail-fast');
} else {
  fail('B6', 'runner output/control flags missing');
}

section('C. Banned terms and safety checks');

if (runnerSrc.includes('BANNED_REPLY_TERMS') && runnerSrc.includes('findBannedTerms')) {
  pass('C1', 'runner defines banned reply term checks');
} else {
  fail('C1', 'banned term checks missing');
}

const bannedRequired = [
  'confirmed quote', 'payment_choice', 'quote_status', 'guest_context',
  'intake_state', 'dry run', 'webhook',
];
for (let i = 0; i < bannedRequired.length; i++) {
  const term = bannedRequired[i];
  if (runnerSrc.includes(term)) pass(`C2.${i}`, `banned list includes "${term}"`);
  else fail(`C2.${i}`, `banned list missing "${term}"`);
}

if (runnerSrc.includes('checkSafetyFlags') && /sends_whatsapp/.test(runnerSrc) && /live_send_blocked/.test(runnerSrc)) {
  pass('C3', 'runner checks safety flags');
} else {
  fail('C3', 'safety flag checks missing');
}

if (runnerSrc.includes('failures_by_category') && runnerSrc.includes('failures_by_language')) {
  pass('C4', 'runner reports failures by category/language');
} else {
  fail('C4', 'failure aggregation missing');
}

if (runnerSrc.includes('isStaffHandoffRequired') && runnerSrc.includes('TECHNICAL_HANDOFF_REASONS')) {
  pass('C5', 'runner filters technical skipped-chain handoff reasons');
} else {
  fail('C5', 'technical handoff filter missing');
}

if (runnerSrc.includes('booking_intake_not_ready') && runnerSrc.includes('quote_not_ready')) {
  pass('C6', 'runner excludes booking_intake_not_ready / quote_not_ready from handoff');
} else {
  fail('C6', 'technical handoff reason list incomplete');
}

try {
  const { isStaffHandoffRequired } = require('./run-luna-guest-golden-tests.js');
  const mockReview = {
    proposed_next_action: 'ask_missing_details',
    handoff_reasons: ['booking_intake_not_ready', 'availability_not_available', 'quote_not_ready'],
    availability: { availability_check_attempted: false },
    quote: { quote_proposal_attempted: false },
  };
  const mockResult = { safe_handoff_required: false };
  if (isStaffHandoffRequired(mockReview, mockResult) === false) {
    pass('C7', 'en-book-01 style technical handoff reasons do not count as staff handoff');
  } else {
    fail('C7', 'technical handoff reasons still counted as staff handoff');
  }
} catch (e) {
  fail('C7', `handoff self-test failed: ${e.message}`);
}

section('D. No live side effects in runner');

const forbidden = [
  ['D1', 'sendWhatsApp', 'WhatsApp send'],
  ['D2', 'runGuestHoldPaymentDraftWriteDryRunApproved', 'hold/payment write'],
  ['D3', 'runGuestStripeTestLinkCreateApproved', 'Stripe link create'],
  ['D4', 'handlePaymentCreateStripeLink', 'payment link create'],
  ['D5', 'handleBotGuestReplySend', 'guest reply send'],
];
for (const [id, sym, label] of forbidden) {
  if (!runnerCode.includes(sym)) pass(id, `runner does not call ${label}`);
  else fail(id, `runner calls ${label}`);
}

if (!/api\.stripe\.com|graph\.facebook\.com|fetch\s*\([^)]*n8n/i.test(runnerCode)) {
  pass('D6', 'no Stripe/WhatsApp/n8n fetch in runner');
} else {
  fail('D6', 'forbidden external fetch in runner');
}

if (!runnerSrc.includes('guest-simulator-create-hold-draft') && !runnerSrc.includes('guest-simulator-create-stripe-test-link')) {
  pass('D7', 'runner does not target hold/Stripe simulator routes');
} else {
  fail('D7', 'runner targets write simulator routes');
}

section('E. No new public automation route');

if (fs.existsSync(API)) {
  const apiSrc = fs.readFileSync(API, 'utf8');
  if (!apiSrc.includes("'/webhook/luna-guest-golden") && !apiSrc.includes("'/webhook/guest-inbound")) {
    pass('E1', 'no new public golden/inbound webhook route');
  } else {
    fail('E1', 'public webhook route detected');
  }
  if (apiSrc.includes(INBOUND_ROUTE)) pass('E2', 'reuses existing 27x.1 inbound review route');
  else fail('E2', '27x.1 inbound route not found in API');
} else {
  fail('E1', 'staff-query-api.js missing');
}

section('F. Docs and npm scripts');

if (fs.existsSync(DOC)) pass('F1', 'STAGE-27TEST-A-GOLDEN-RUNNER.md exists');
else fail('F1', 'doc missing');

if (fs.existsSync(DOC)) {
  const doc = fs.readFileSync(DOC, 'utf8');
  if (doc.includes('run-luna-guest-golden-tests.js')) pass('F2', 'doc mentions runner');
  else fail('F2', 'doc missing runner');
  if (/staging|local|127\.0\.0\.1/i.test(doc)) pass('F3', 'doc includes local/staging usage');
  else fail('F3', 'doc missing usage');
  if (/banned|safety|category/i.test(doc)) pass('F4', 'doc explains categories/report');
  else fail('F4', 'doc missing report explanation');
}

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${REL}`) pass('F5', `${SCRIPT} registered`);
else fail('F5', `${SCRIPT} npm script missing`);

if (pkg.scripts && pkg.scripts['luna:guest-golden']) pass('F6', 'luna:guest-golden npm script registered');
else fail('F6', 'luna:guest-golden npm script missing');

section('Summary');

console.log(`\nResults: ${passes} passed, ${failures} failed\n`);
process.exit(failures > 0 ? 1 : 0);
