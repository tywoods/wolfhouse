/**
 * Stage 27o — Stripe test Checkout link verifier.
 *
 * Usage:
 *   npm run verify:stage27o-stripe-test-link
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API = path.join(__dirname, 'staff-query-api.js');
const LINK_MOD = path.join(__dirname, 'lib', 'luna-guest-stripe-test-link-create.js');
const PKG_FILE = path.join(ROOT, 'package.json');
const DOC = path.join(ROOT, 'docs', 'STAGE-27O-STRIPE-TEST-LINK.md');
const SCRIPT = 'verify:stage27o-stripe-test-link';

const {
  runGuestStripeTestLinkCreateApproved,
  shouldAllowGuestStripeTestLinkCreate,
  isGuestStripeTestLinkEnvironment,
  confirmStripeTestLinkApproved,
  isStripeTestSecretKey,
  REUSED_STRIPE_PATH,
  LINK_SAFETY,
} = require('./lib/luna-guest-stripe-test-link-create');

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

const FORBIDDEN_NOTICE_RE = /\b(?:booking is confirmed|confirmed your booking|payment has been received|payment received|sent you (?:a )?link|link sent to guest)\b/i;

const stagingEnv = {
  NODE_ENV: 'development',
  STAFF_ACTIONS_ENABLED: 'true',
  STRIPE_LINKS_ENABLED: 'true',
  WHATSAPP_DRY_RUN: 'true',
  STRIPE_SECRET_KEY: 'sk_test_mock',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://staging.example.com/staff/payment/success?session_id={CHECKOUT_SESSION_ID}',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://staging.example.com/staff/payment/cancel',
};

const prodEnv = { NODE_ENV: 'production', STAFF_ACTIONS_ENABLED: 'true', STRIPE_LINKS_ENABLED: 'true', WHATSAPP_DRY_RUN: 'true' };

console.log('\nverify-stage27o-stripe-test-link.js  (Stage 27o)\n');

try {
  execSync(`node --check "${LINK_MOD}"`, { stdio: 'pipe' });
  pass('0a', 'stripe test link module passes node --check');
} catch {
  fail('0a', 'module syntax error');
}

const apiSrc = fs.readFileSync(API, 'utf8');
const linkSrc = fs.readFileSync(LINK_MOD, 'utf8');
const handlerStart = apiSrc.indexOf('async function handlePaymentCreateStripeLink(');
const handlerEnd = handlerStart > -1 ? apiSrc.indexOf('\n// ───', handlerStart + 50) : -1;
const stripeHandler = handlerStart > -1 ? apiSrc.slice(handlerStart, handlerEnd > 0 ? handlerEnd : handlerStart + 12000) : '';

section('A. package.json script');

const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
if (pkg.scripts && pkg.scripts[SCRIPT]) pass('A1', `${SCRIPT} registered`);
else fail('A1', `missing npm script ${SCRIPT}`);

section('B. Reused Stripe path reference');

if (linkSrc.includes('handlePaymentCreateStripeLink')) pass('B1', 'documents reused Staff Portal Stripe path');
else fail('B1', 'must reference handlePaymentCreateStripeLink');

if (linkSrc.includes("checkout_created'::payment_record_status")) pass('B2', 'uses checkout_created payment status');
else fail('B2', 'must use checkout_created convention');

if (linkSrc.includes('checkout.sessions.create')) pass('B3', 'creates Stripe Checkout session');
else fail('B3', 'Stripe session create missing');

if (stripeHandler.includes('checkout.sessions.create') && stripeHandler.includes('STAFF_ACTIONS_ENABLED')) {
  pass('B4', 'Staff API anchor handler exists with same gates pattern');
} else {
  fail('B4', 'handlePaymentCreateStripeLink anchor missing');
}

section('C. Hard gates');

if (!confirmStripeTestLinkApproved({})) pass('C1', 'confirm_stripe_test_link false by default');
else fail('C1', 'confirm should default false');

const noConfirm = shouldAllowGuestStripeTestLinkCreate(
  { payment_draft_id: 'pay-1' },
  { env: stagingEnv },
);
if (!noConfirm.allowed && noConfirm.reasons.includes('confirm_stripe_test_link_required')) {
  pass('C2', 'confirm_stripe_test_link required');
} else {
  fail('C2', 'missing confirm_stripe_test_link gate');
}

const gatedEnv = {
  ...stagingEnv,
};
const withConfirm = shouldAllowGuestStripeTestLinkCreate(
  { payment_draft_id: 'pay-1' },
  { env: gatedEnv, confirm_stripe_test_link: true },
);
if (withConfirm.allowed) pass('C3', 'all staging gates pass');
else fail('C3', `gates failed: ${withConfirm.reasons.join(',')}`);

if (!isGuestStripeTestLinkEnvironment(prodEnv)) pass('C4', 'production blocked');
else fail('C4', 'production must be blocked');

if (isStripeTestSecretKey({ STRIPE_SECRET_KEY: 'sk_test_abc' })) pass('C5', 'sk_test_ accepted');
else fail('C5', 'sk_test_ should pass');

if (!isStripeTestSecretKey({ STRIPE_SECRET_KEY: 'sk_live_abc' })) pass('C6', 'sk_live_ rejected');
else fail('C6', 'sk_live_ must be rejected');

const noWhatsapp = shouldAllowGuestStripeTestLinkCreate(
  { payment_draft_id: 'pay-1' },
  { env: { ...stagingEnv, WHATSAPP_DRY_RUN: 'false' }, confirm_stripe_test_link: true },
);
if (!noWhatsapp.allowed && noWhatsapp.reasons.includes('WHATSAPP_DRY_RUN_required')) {
  pass('C7', 'WHATSAPP_DRY_RUN=true required');
} else {
  fail('C7', 'WHATSAPP_DRY_RUN gate missing');
}

section('D. Blocked without confirm');

(async () => {
  const blocked = await runGuestStripeTestLinkCreateApproved(
    { payment_draft_id: '00000000-0000-4000-8000-000000000001' },
    { env: stagingEnv },
  );

  if (blocked.stripe_link_attempted === false && blocked.stripe_link_created === false) {
    pass('D1', 'no Stripe attempt without confirm');
  } else {
    fail('D1', 'must not attempt Stripe without confirm');
  }

  if (blocked.sends_whatsapp === false && blocked.live_send_blocked === true) {
    pass('D2', 'safety flags on blocked response');
  } else {
    fail('D2', 'missing safety flags');
  }

  section('E. Production blocked');

  const prodBlocked = await runGuestStripeTestLinkCreateApproved(
    { payment_draft_id: '00000000-0000-4000-8000-000000000001' },
    { env: prodEnv, confirm_stripe_test_link: true },
  );

  if (prodBlocked.stripe_link_attempted === false) pass('E1', 'production blocks Stripe');
  else fail('E1', 'production must block');

  section('F. Output shape');

  const keys = [
    'stripe_link_attempted',
    'stripe_link_created',
    'stripe_mode',
    'booking_id',
    'booking_code',
    'payment_draft_id',
    'stripe_checkout_session_id',
    'stripe_checkout_url',
    'payment_status',
    'next_safe_step',
    'sends_whatsapp',
    'live_send_blocked',
    'booking_confirmed',
    'payment_truth_recorded',
  ];
  for (const key of keys) {
    if (key in blocked) pass(`F.${key}`, `output has ${key}`);
    else fail(`F.${key}`, `missing ${key}`);
  }

  if (blocked.booking_confirmed === false && blocked.payment_truth_recorded === false) {
    pass('F.no_truth', 'no booking confirm or payment truth');
  } else {
    fail('F.no_truth', 'must not confirm booking or record payment truth');
  }

  if (blocked.next_safe_step === 'keep_dry_run') pass('F.next', 'blocked next_safe_step keep_dry_run');
  else fail('F.next', 'blocked should stay keep_dry_run');

  section('G. Idempotent reuse (mock pg)');

  const mockPg = {
    async query(sql, params) {
      if (/FROM payments p/.test(sql)) {
        return {
          rows: [{
            payment_draft_id: params[0],
            booking_id: 'bk-1',
            booking_code: 'WH-G27-MOCK',
            payment_status: 'checkout_created',
            payment_kind: 'deposit_only',
            currency: 'EUR',
            amount_due_cents: 20000,
            amount_paid_cents: 0,
            stripe_checkout_session_id: 'cs_test_mock',
            checkout_url: 'https://checkout.stripe.test/cs_test_mock',
            guest_name: 'Test Guest',
            check_in: '2026-06-15',
            check_out: '2026-06-22',
            booking_status: 'hold',
            hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
            booking_payment_status: 'waiting_payment',
            client_slug: 'wolfhouse-somo',
          }],
        };
      }
      throw new Error('unexpected query in idempotent mock');
    },
  };

  const reused = await runGuestStripeTestLinkCreateApproved(
    { payment_draft_id: '00000000-0000-4000-8000-000000000001' },
    { env: stagingEnv, confirm_stripe_test_link: true, pg: mockPg },
  );

  if (reused.stripe_link_created === true && reused.idempotent === true) {
    pass('G1', 'idempotent reuse of checkout_created session');
  } else {
    fail('G1', `expected idempotent reuse got created=${reused.stripe_link_created} idempotent=${reused.idempotent}`);
  }

  if (reused.stripe_checkout_url && reused.stripe_checkout_session_id) {
    pass('G2', 'returns existing session url/id');
  } else {
    fail('G2', 'missing reused session fields');
  }

  if (reused.next_safe_step === 'awaiting_payment_truth') pass('G3', 'awaiting_payment_truth on success path');
  else fail('G3', `unexpected next_safe_step ${reused.next_safe_step}`);

  section('H. Source hygiene');

  const forbidden = [
    ['H.whatsapp', /graph\.facebook\.com|sendWhatsApp|whatsapp\.send/i],
    ['H.n8n', /fetch\s*\([^)]*n8n|activateWorkflow/i],
    ['H.webhook', /handleStripeWebhook|runStripeWebhook|processWebhook|webhookHandler/i],
    ['H.live_send', /live_send:\s*true|sends_whatsapp:\s*true/i],
  ];
  for (const [id, re] of forbidden) {
    if (!re.test(linkSrc)) pass(id, 'module source clean');
    else fail(id, 'forbidden pattern in module');
  }

  if (!/booking_status\s*=\s*'confirmed'|SET.*status.*confirmed/i.test(linkSrc)) {
    pass('H.no_confirm', 'does not confirm booking');
  } else {
    fail('H.no_confirm', 'must not confirm booking');
  }

  if (!/status\s*=\s*'paid'|amount_paid_cents\s*=/i.test(linkSrc.replace(/amount_paid_cents\s*>\s*0/g, ''))) {
    pass('H.no_paid', 'does not mark payment paid');
  } else {
    fail('H.no_paid', 'must not mark payment paid');
  }

  section('I. Staff notice safety');

  for (const r of [blocked, prodBlocked, reused]) {
    const notice = r.staff_notice || '';
    if (!FORBIDDEN_NOTICE_RE.test(notice)) {
      pass(`I.${r.idempotent ? 'reused' : 'blocked'}`, 'staff_notice avoids forbidden guest claims');
    } else {
      fail(`I.${r.idempotent ? 'reused' : 'blocked'}`, `forbidden notice: ${notice.slice(0, 80)}`);
    }
    if (/staff|manual testing|not sent to guest/i.test(notice)) {
      pass(`I.hint.${r.idempotent ? 'reused' : 'blocked'}`, 'staff_notice clarifies manual-only');
    } else {
      fail(`I.hint.${r.idempotent ? 'reused' : 'blocked'}`, 'staff_notice should say manual/staff only');
    }
  }

  section('J. LINK_SAFETY constants');

  for (const [k, v] of Object.entries(LINK_SAFETY)) {
    if (blocked[k] === v) pass(`J.${k}`, `${k}=${v}`);
    else fail(`J.${k}`, `expected ${k}=${v}`);
  }

  section('K. Doc files');

  if (fs.existsSync(DOC)) pass('K1', 'STAGE-27O doc exists');
  else fail('K1', 'missing STAGE-27O doc');

  const docText = fs.readFileSync(DOC, 'utf8');
  if (docText.includes('runGuestStripeTestLinkCreateApproved')) pass('K2', 'doc names function');
  else fail('K2', 'doc must name function');

  if (docText.includes('handlePaymentCreateStripeLink') && docText.includes('confirm_stripe_test_link')) {
    pass('K3', 'doc covers reused path and confirm gate');
  } else {
    fail('K3', 'doc missing reused path or confirm gate');
  }

  if (docText.includes('27p') && docText.includes('webhook')) pass('K4', 'doc references Stage 27p');
  else fail('K4', 'doc should reference 27p webhook slice');

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FAIL — verifier error:', e.message);
  process.exit(1);
});
