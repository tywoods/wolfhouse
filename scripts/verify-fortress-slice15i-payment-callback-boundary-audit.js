'use strict';

/**
 * verify:fortress-slice15i-payment-callback-boundary-audit — FORTRESS Slice 15I
 *
 * Read-only reaudit of B14/B15 after merged B13 tenant-bound Stripe payment
 * lookup. No network, no live DB/Stripe/deploy. Does not change runtime
 * behavior and does not rewrite 15A historical artifacts.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15i-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15i-b14-b15-audit-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15i-findings.md');
const CONSUMER_PATH = path.join(FIXTURE_DIR, 'slice15i-consumer-matrix.json');
const ATTACK_PATH = path.join(FIXTURE_DIR, 'slice15i-attack-cases.json');
const REMEDIATION_PATH = path.join(FIXTURE_DIR, 'slice15i-b15-remediation-contract.json');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15i-evidence.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  validateLockedPaymentIdentityForStripeTruth,
  LOCKED_PAYMENT_VALIDATION_CODES,
} = require('./lib/stripe-hold-promote-policy');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const MASTER_BASIS = '7ae3d75f7223a3aea0027b047f2537081fa7e1ee';

let pass = 0;
let fail = 0;
const redResults = [];
const greenResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function green(id, cond, detail) {
  const passed = ok(`GREEN ${id}`, cond, detail);
  greenResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function extractFunction(src, name) {
  const startRe = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const start = src.search(startRe);
  if (start < 0) return '';
  const after = src.slice(start);
  // Prefer next top-level async/function, else module.exports / section rule.
  const endMatchers = [
    /\nasync function /,
    /\nfunction [a-zA-Z]/,
    /\nmodule\.exports/,
    /\n\/\/ ─{10,}/,
  ];
  let end = after.length;
  for (const re of endMatchers) {
    const m = after.slice(1).search(re);
    if (m >= 0) end = Math.min(end, m + 1);
  }
  return after.slice(0, end);
}

console.log('verify:fortress-slice15i-payment-callback-boundary-audit — FORTRESS Slice 15I\n');

// ── Fixtures ───────────────────────────────────────────────────────────────
ok('F1 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F2 overlay exists', fs.existsSync(OVERLAY_PATH));
ok('F3 findings exists', fs.existsSync(FINDINGS_PATH));
ok('F4 consumer matrix exists', fs.existsSync(CONSUMER_PATH));
ok('F5 attack cases exist', fs.existsSync(ATTACK_PATH));
ok('F6 remediation contract exists', fs.existsSync(REMEDIATION_PATH));

const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const consumer = readJson(CONSUMER_PATH);
const attacks = readJson(ATTACK_PATH);
const remediation = readJson(REMEDIATION_PATH);
const matrix = readJson(MATRIX_PATH);
const findings = readText(FINDINGS_PATH);

ok('F7 contract slice 15I + master_basis',
  contract.slice === 'FORTRESS-15I'
  && contract.outcome_id === '15I_payment_callback_boundary_reaudit'
  && contract.master_basis === MASTER_BASIS
  && contract.live_mutation === false
  && contract.runtime_behavior_changed === false);

ok('F8 overlay preserves historical audit',
  overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && overlay.master_basis === MASTER_BASIS);

ok('F9 historical 15A B14/B15 still unproven',
  matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity').verdict === 'unproven'
  && matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven');

ok('F10 overlay reaudit verdicts',
  overlay.reaudit.B14_stripe_locked_payment_identity.reaudit_verdict === 'proven_fail_closed'
  && overlay.reaudit.B15_booking_hold_payment_callbacks.reaudit_verdict === 'vulnerable'
  && contract.reaudit_verdicts.B14_stripe_locked_payment_identity.verdict === 'proven_fail_closed'
  && contract.reaudit_verdicts.B15_booking_hold_payment_callbacks.verdict === 'vulnerable');

ok('F11 remediation design-only not implemented',
  remediation.status === 'design_only_not_implemented'
  && remediation.next_implementation_slice === 'FORTRESS-15J'
  && remediation.outcome_id === '15J_payment_uuid_callback_tenant_acl'
  && remediation.live_mutation === false);

ok('F12 findings cite B13 policy + overlay + taxonomy',
  /do not assume B13|inventoried, not assumed/i.test(findings)
  && /slice15i-b14-b15-audit-overlay/.test(findings)
  && /proven_fail_closed/.test(findings)
  && /vulnerable/.test(findings));

ok('F13 consumer matrix rollup matches contract',
  consumer.boundary_rollup.B14_stripe_locked_payment_identity === 'proven_fail_closed'
  && consumer.boundary_rollup.B15_booking_hold_payment_callbacks === 'vulnerable'
  && Array.isArray(consumer.b15_consumers)
  && consumer.b15_consumers.length >= 8
  && Array.isArray(consumer.b14_locked_payment_chain.production_apply_callers)
  && consumer.b14_locked_payment_chain.production_apply_callers.length === 2);

// ── Secret-free ────────────────────────────────────────────────────────────
console.log('\n── Secret-free scan ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/slice15i-contract.json',
  'fixtures/fortress-tenant-identity/slice15i-b14-b15-audit-overlay.json',
  'fixtures/fortress-tenant-identity/slice15i-consumer-matrix.json',
  'fixtures/fortress-tenant-identity/slice15i-attack-cases.json',
  'fixtures/fortress-tenant-identity/slice15i-b15-remediation-contract.json',
  'fixtures/fortress-tenant-identity/slice15i-findings.md',
  'scripts/verify-fortress-slice15i-payment-callback-boundary-audit.js',
]) {
  const hits = scanSecretFreeText(readText(path.join(ROOT, rel)));
  ok(`S secret-free ${rel}`, hits.length === 0, hits.join(','));
}

// ── Source loads ───────────────────────────────────────────────────────────
const policySrc = readText(path.join(ROOT, 'scripts/lib/stripe-hold-promote-policy.js'));
const truthSrc = readText(path.join(ROOT, 'scripts/lib/stripe-webhook-payment-truth.js'));
const reconcileSrc = readText(path.join(ROOT, 'scripts/lib/stripe-payment-reconcile.js'));
const apiSrc = readText(path.join(ROOT, 'scripts/staff-query-api.js'));
const shortLinkSrc = readText(path.join(ROOT, 'scripts/lib/luna-payment-short-link.js'));
const frontDeskSrc = readText(path.join(ROOT, 'scripts/lib/luna-front-desk-payment-link-service.js'));
const botSrc = readText(path.join(ROOT, 'scripts/lib/staff-bot-v2-routes.js'));
const initSql = readText(path.join(ROOT, 'database/migrations/001_init.sql'));
const renameSql = readText(path.join(ROOT, 'database/migrations/003_rename_hostel_to_client.sql'));

const staffPayFn = extractFunction(apiSrc, 'handlePaymentCreateStripeLink');
const staffSvcFn = extractFunction(apiSrc, 'handleBookingServiceRecordsCreatePaymentLink');
const botPayFn = extractFunction(botSrc, 'handleBotPaymentCreateStripeLink');
const webhookSlice = apiSrc.slice(
  apiSrc.indexOf('async function handleStripeWebhook'),
  apiSrc.indexOf('async function handlePaymentCreateStripeLink'),
);

console.log('\n── B14 locked-payment chain ──');

green('AC15I_B14_IDENTITY_BEFORE_ALREADY_PAID', (() => {
  const idIdx = policySrc.indexOf('validateLockedPaymentIdentityForStripeTruth(lockedPayment, session, identityCtx)');
  const paidIdx = policySrc.indexOf("lockedPayment.payment_status === 'paid'");
  return idIdx > 0 && paidIdx > idIdx;
})());

green('AC15I_B14_EXPECTED_CLIENT_FROM_PM_ROW',
  /expectedClientId:\s*pm\.client_id/.test(policySrc)
  && !/expectedClientId:\s*expectedClient/.test(policySrc));

green('AC15I_B14_WEBHOOK_CALLER_BINDS_SLUG', (() => {
  const a = webhookSlice.indexOf('resolveStripeWebhookExpectedClientSlug');
  const b = webhookSlice.indexOf('lookupPaymentForStripeSession');
  const c = webhookSlice.indexOf('validateStripeBookingPaymentEvent');
  const d = webhookSlice.indexOf('applyStripeBookingPaymentTruthWrites');
  return a >= 0 && b > a && c > b && d > c;
})());

green('AC15I_B14_RECONCILE_REQUIRES_SLUG',
  /expected_client_slug_required/.test(reconcileSrc)
  && /lookupPaymentForStripeSession\(pg,\s*session,\s*expectedClientSlug\)/.test(reconcileSrc)
  && /validateStripeBookingPaymentEvent\(pm,\s*session,\s*eventType,\s*expectedClientSlug\)/.test(reconcileSrc)
  && /applyStripeBookingPaymentTruthWrites/.test(reconcileSrc));

green('AC15I_B14_SESSION_REPLACED_FAIL_CLOSED', (() => {
  try {
    validateLockedPaymentIdentityForStripeTruth(
      {
        payment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        booking_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        client_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        stripe_checkout_session_id: 'cs_test_OLD_SAMPLE',
      },
      {
        id: 'cs_test_NEW_SAMPLE',
        metadata: { payment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      },
      {
        expectedBookingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        expectedClientId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      },
    );
    return false;
  } catch (err) {
    return err && err.code === LOCKED_PAYMENT_VALIDATION_CODES.SESSION_REPLACED;
  }
})());

ok('B14 lock SQL scoped by client_id',
  /FROM payments[\s\S]{0,200}WHERE id = \$1::uuid[\s\S]{0,40}AND client_id = \$2[\s\S]{0,40}FOR UPDATE/.test(policySrc)
  && /FROM bookings[\s\S]{0,200}WHERE id = \$1::uuid[\s\S]{0,40}AND client_id = \$2[\s\S]{0,40}FOR UPDATE/.test(policySrc));

ok('B14 only two production apply callers',
  (apiSrc.match(/applyStripeBookingPaymentTruthWrites/g) || []).length >= 1
  && (reconcileSrc.match(/applyStripeBookingPaymentTruthWrites/g) || []).length >= 1
  && !/applyStripeBookingPaymentTruthWrites/.test(botSrc)
  && !/applyStripeBookingPaymentTruthWrites/.test(shortLinkSrc));

ok('B13 lookup still tenant-bound (context, not assumed close of B15)',
  /cl\.slug = \$2/.test(truthSrc)
  && /expected_client_slug_required/.test(truthSrc));

console.log('\n── B15 callback consumers ──');

red('AC15I_B15_STAFF_PAYMENT_UUID_NO_ACL',
  /FROM payments p[\s\S]{0,120}WHERE p\.id = \$1::uuid/.test(staffPayFn)
  && !/assertStaffClientAccess/.test(staffPayFn)
  && /trustedClientSlug:\s*clientSlug/.test(staffPayFn));

red('AC15I_B15_BOT_PAYMENT_UUID_IGNORES_BOUND',
  /FROM payments p[\s\S]{0,120}WHERE p\.id = \$1::uuid/.test(botPayFn)
  && !/boundClientSlug/.test(botPayFn)
  && /trustedClientSlug:\s*clientSlug/.test(botPayFn));

red('AC15I_B15_SERVICE_RECORDS_WEAK_CLIENT_ID',
  /WHERE b\.id = \$1/.test(staffSvcFn)
  && /user\.client_id/.test(staffSvcFn)
  && !/assertStaffClientAccess/.test(staffSvcFn));

green('AC15I_B15_SHORT_LINK_SQL_SCOPED',
  /WHERE c\.slug = \$1[\s\S]{0,40}AND UPPER\(b\.booking_code\) = UPPER\(\$2\)/.test(shortLinkSrc));

green('AC15I_B15_BOOKING_CODE_PER_CLIENT_UNIQUE',
  /UNIQUE \(hostel_id, booking_code\)/.test(initSql)
  && /RENAME COLUMN hostel_id TO client_id/.test(renameSql));

green('AC15I_B15_FRONT_DESK_LOAD_PAYMENT_SCOPED',
  /async function loadPaymentById[\s\S]{0,1200}WHERE p\.id = \$1::uuid AND cl\.slug = \$2/.test(frontDeskSrc));

const docText = readText(DOC_PATH);
green('AC15I_HISTORICAL_15A_UNCHANGED',
  matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity').verdict === 'unproven'
  && matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven'
  && /B14 \| Locked payment identity revalidation \| `unproven`/.test(docText)
  && /B15 \| Booking\/hold\/payment lookup callbacks \| `unproven`/.test(docText));
green('AC15I_B13_NOT_ASSUMED_CLOSE_B15',
  !/lookupPaymentForStripeSession/.test(staffPayFn)
  && !/lookupPaymentForStripeSession/.test(botPayFn));

ok('LOOKUP_BOOKING_CODE_SQL joins clients.slug',
  /const LOOKUP_BOOKING_CODE_SQL[\s\S]{0,300}AND c\.slug = \$2/.test(apiSrc));

ok('Attack case ids covered',
  Array.isArray(attacks.cases)
  && attacks.cases.length >= 12
  && attacks.cases.every((c) => typeof c.id === 'string' && c.color));

ok('Vulnerable B15 consumers named in matrix',
  consumer.b15_consumers.filter((c) => c.verdict === 'vulnerable').map((c) => c.id).sort().join(',')
  === [
    'C_BOT_PAYMENT_UUID_STRIPE_LINK',
    'C_STAFF_PAYMENT_UUID_STRIPE_LINK',
    'C_STAFF_SERVICE_RECORDS_PAYMENT_LINK',
  ].sort().join(','));

// ── Evidence write ─────────────────────────────────────────────────────────
const evidence = {
  schema_version: 1,
  slice: 'FORTRESS-15I',
  generated_at: new Date().toISOString(),
  master_basis: MASTER_BASIS,
  live_mutation: false,
  runtime_behavior_changed: false,
  reaudit_verdicts: contract.reaudit_verdicts,
  red: {
    total: redResults.length,
    passed: redResults.filter((r) => r.ok).length,
    cases: redResults,
  },
  green: {
    total: greenResults.length,
    passed: greenResults.filter((r) => r.ok).length,
    cases: greenResults,
  },
  pass,
  fail,
  remediation_next_gate: 'FORTRESS-15J / 15J_payment_uuid_callback_tenant_acl',
};

fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
ok('E evidence written', fs.existsSync(EVIDENCE_PATH));

console.log(`\n── verify:fortress-slice15i-payment-callback-boundary-audit ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
process.exit(fail ? 1 : 0);
