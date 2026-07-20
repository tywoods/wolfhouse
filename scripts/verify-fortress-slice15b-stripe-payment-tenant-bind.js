'use strict';

/**
 * verify:fortress-slice15b-stripe-payment-tenant-bind — FORTRESS Slice 15B
 *
 * Offline dynamic fake-PG + config unit tests for authoritative Stripe
 * checkout-session payment tenant binding. No network, no live Stripe/DB,
 * no payment/deploy/guest mutation.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15b-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15b-b13-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15b-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15b-evidence.json');

const {
  lookupPaymentForStripeSession,
  validateStripeBookingPaymentEvent,
  PAYMENT_LOOKUP_SQL,
} = require('./lib/stripe-webhook-payment-truth');
const {
  resolveStripeWebhookExpectedClientSlug,
} = require('./lib/stripe-webhook-tenant-config');
const {
  reconcilePaidStripeSession,
} = require('./lib/stripe-payment-reconcile');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

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

const TENANT_A = 'tenant-alpha-sample';
const TENANT_B = 'tenant-beta-sample';
const PAY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CS_A = 'cs_test_TENANT_A_SAMPLE';
const CS_B = 'cs_test_TENANT_B_SAMPLE';

function makeTrackingPg(rowsByKey) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params: params || [] });
      const q = String(sql);
      if (/stripe_checkout_session_id = \$1/i.test(q) && /cl\.slug = \$2/i.test(q)) {
        const sid = params[0];
        const slug = params[1];
        const hit = (rowsByKey.bySession || []).find(
          (r) => r.stripe_checkout_session_id === sid && r.client_slug === slug,
        );
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      if (/p\.id = \$1::uuid/i.test(q) && /cl\.slug = \$2/i.test(q)) {
        const pid = params[0];
        const slug = params[1];
        const hit = (rowsByKey.byId || []).find(
          (r) => r.payment_id === pid && r.client_slug === slug,
        );
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function basePm(overrides) {
  return Object.assign({
    payment_id: PAY_A,
    payment_status: 'checkout_created',
    payment_kind: 'full_amount',
    currency: 'EUR',
    amount_due_cents: 5000,
    stripe_checkout_session_id: CS_A,
    client_slug: TENANT_A,
    client_id: 'client-a',
    booking_id: 'bk-a',
    booking_code: 'BK-A',
  }, overrides || {});
}

function baseSession(overrides) {
  return Object.assign({
    id: CS_A,
    payment_status: 'paid',
    status: 'complete',
    currency: 'eur',
    amount_total: 5000,
    metadata: {},
  }, overrides || {});
}

console.log('verify:fortress-slice15b-stripe-payment-tenant-bind — FORTRESS Slice 15B\n');

// ── Fixtures ───────────────────────────────────────────────────────────────
ok('F1 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F2 remediation overlay exists', fs.existsSync(OVERLAY_PATH));
ok('F3 findings exists', fs.existsSync(FINDINGS_PATH));

const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
ok('F4 contract master_basis', contract.master_basis === '8ed81111b9a67a656dee0b7dbd5a46ab91ca125c');
ok('F5 live_mutation false', contract.live_mutation === false && overlay.live_mutation === false);
ok('F6 overlay historical unchanged', overlay.historical_audit_unchanged === true && overlay.status === 'remediated');
ok('F7 overlay does not rewrite 15A matrix',
  fs.existsSync(path.join(FIXTURE_DIR, 'boundary-matrix.json'))
  && readJson(path.join(FIXTURE_DIR, 'boundary-matrix.json')).boundaries
    .find((b) => b.id === 'B13_stripe_webhook_payment_lookup').verdict === 'vulnerable');

const truthSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripe-webhook-payment-truth.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripe-webhook-tenant-config.js'), 'utf8');
const reconcileSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/stripe-payment-reconcile.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');

ok('S1 session SQL tenant predicate parameterized',
  /stripe_checkout_session_id = \$1[\s\S]{0,80}cl\.slug = \$2/.test(truthSrc)
  && !/cl\.slug = ['"]/.test(PAYMENT_LOOKUP_SQL + truthSrc.match(/WHERE p\.stripe_checkout_session_id[\s\S]{0,120}/)?.[0] || ''));
ok('S2 metadata SQL tenant predicate parameterized',
  /p\.id = \$1::uuid[\s\S]{0,80}cl\.slug = \$2/.test(truthSrc));
ok('S3 no hardcode wolfhouse/sunset in tenant config',
  !/wolfhouse-somo|['"]sunset['"]/.test(configSrc));
ok('S4 signature skip-verify not enabled',
  !/STRIPE_WEBHOOK_SKIP_VERIFY\s*=\s*['"]true['"]/.test(apiSrc)
  && /STRIPE_WEBHOOK_SKIP_VERIFY === 'true'/.test(apiSrc));
ok('S5 webhook resolves tenant before lookup',
  /resolveStripeWebhookExpectedClientSlug[\s\S]{0,800}lookupPaymentForStripeSession/.test(apiSrc));
ok('S6 reconcile requires expectedClientSlug',
  /expected_client_slug_required/.test(reconcileSrc)
  && /expectedClientSlug:\s*clientSlug/.test(reconcileSrc));

// ── Config helper unit tests ───────────────────────────────────────────────
console.log('\n── Config helper ──');
{
  const missing = resolveStripeWebhookExpectedClientSlug({});
  red('missing_runtime_slug',
    missing.ok === false
    && missing.reason === 'missing_runtime_client_slug'
    && missing.no_db_write === true
    && missing.client_slug == null);

  const conflict = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: TENANT_A,
    DEFAULT_CLIENT_SLUG: TENANT_B,
  });
  red('conflicting_runtime_slugs',
    conflict.ok === false
    && conflict.reason === 'conflicting_runtime_client_slugs'
    && conflict.no_db_write === true);

  const dedicated = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: TENANT_A,
  });
  ok('config dedicated STRIPE_WEBHOOK_CLIENT_SLUG',
    dedicated.ok && dedicated.client_slug === TENANT_A && dedicated.source === 'STRIPE_WEBHOOK_CLIENT_SLUG');

  const compat = resolveStripeWebhookExpectedClientSlug({
    DEFAULT_CLIENT_SLUG: TENANT_B,
  });
  ok('config DEFAULT_CLIENT_SLUG compat',
    compat.ok && compat.client_slug === TENANT_B && compat.source === 'DEFAULT_CLIENT_SLUG');

  const aligned = resolveStripeWebhookExpectedClientSlug({
    STRIPE_WEBHOOK_CLIENT_SLUG: TENANT_A,
    DEFAULT_CLIENT_SLUG: TENANT_A,
  });
  ok('config aligned both set', aligned.ok && aligned.client_slug === TENANT_A);
}

// ── Dynamic lookup RED/GREEN ───────────────────────────────────────────────
console.log('\n── Lookup RED/GREEN (fake PG) ──');

(async () => {
  const rowA = basePm({
    payment_id: PAY_A,
    client_slug: TENANT_A,
    stripe_checkout_session_id: CS_A,
    payment_kind: 'full_amount',
  });
  const rowB = basePm({
    payment_id: PAY_B,
    client_slug: TENANT_B,
    stripe_checkout_session_id: CS_B,
    payment_kind: 'addon_service',
  });
  const rowAMetaOnly = basePm({
    payment_id: PAY_A,
    client_slug: TENANT_A,
    stripe_checkout_session_id: null,
  });

  {
    const pg = makeTrackingPg({ bySession: [rowA, rowB], byId: [rowA, rowB, rowAMetaOnly] });
    const omitted = await lookupPaymentForStripeSession(pg, baseSession(), '');
    red('caller_omits_slug',
      omitted.ok === false
      && omitted.reason === 'expected_client_slug_required'
      && omitted.queried === false
      && pg.queries.length === 0);
  }

  {
    const pg = makeTrackingPg({ bySession: [rowA], byId: [rowAMetaOnly] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_A } },
      TENANT_A,
    );
    red('metadata_fallback_missing_slug',
      r.ok === false
      && r.reason === 'metadata_client_slug_required'
      && r.queried === false
      && pg.queries.length === 1
      && /stripe_checkout_session_id/.test(pg.queries[0].sql)
      && pg.queries.every((q) => !/p\.id = \$1::uuid/.test(q.sql)));
  }

  {
    const pg = makeTrackingPg({ bySession: [rowA], byId: [rowAMetaOnly] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_A, client_slug: TENANT_B } },
      TENANT_A,
    );
    red('metadata_fallback_mismatched_slug',
      r.ok === false
      && r.reason === 'metadata_client_slug_mismatch'
      && r.queried === false
      && pg.queries.every((q) => !/p\.id = \$1::uuid/.test(q.sql)));
  }

  {
    const pg = makeTrackingPg({ bySession: [], byId: [rowB] });
    const before = pg.queries.length;
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_B, client_slug: TENANT_A } },
      TENANT_A,
    );
    red('other_tenant_uuid',
      r.ok === true
      && r.payment == null
      && r.reason === 'payment_not_found'
      && pg.queries.length > before
      && pg.queries.some((q) => /p\.id = \$1::uuid/.test(q.sql) && q.params[1] === TENANT_A));
  }

  {
    const pg = makeTrackingPg({ bySession: [], byId: [rowAMetaOnly] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_A, client_slug: TENANT_B } },
      TENANT_B,
    );
    // Same UUID exists under TENANT_A only; expected TENANT_B + metadata TENANT_B → scoped miss
    red('same_uuid_wrong_expected_tenant',
      r.ok === true && r.payment == null && r.reason === 'payment_not_found');
  }

  {
    const pg = makeTrackingPg({ bySession: [rowB], byId: [] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: CS_B, metadata: {} },
      TENANT_A,
    );
    red('session_id_other_tenant',
      r.ok === true && r.payment == null
      && pg.queries[0] && pg.queries[0].params[1] === TENANT_A);
  }

  {
    // Simulate a buggy PG that returns wrong-tenant row despite predicate (defense in depth).
    const pg = {
      queries: [],
      query: async (sql, params) => {
        pg.queries.push({ sql: String(sql), params });
        return {
          rows: [{ ...rowB, client_slug: TENANT_B }],
          rowCount: 1,
        };
      },
    };
    const r = await lookupPaymentForStripeSession(pg, { id: CS_B, metadata: {} }, TENANT_A);
    red('returned_row_client_mismatch',
      r.ok === false && r.reason === 'payment_client_slug_mismatch' && r.payment == null);
  }

  {
    const pg = makeTrackingPg({ bySession: [], byId: [rowAMetaOnly] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_A, client_slug: TENANT_B } },
      TENANT_A,
    );
    red('no_query_on_rejected_fallback',
      r.queried === false
      && r.reason === 'metadata_client_slug_mismatch'
      && pg.queries.every((q) => !/p\.id = \$1::uuid/.test(q.sql)));
  }

  {
    const pg = makeTrackingPg({ bySession: [rowA], byId: [] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: CS_A, metadata: { payment_id: PAY_A } },
      TENANT_A,
    );
    green('session_id_absent_metadata_slug',
      r.ok && r.payment && r.payment.payment_id === PAY_A
      && r.lookup_path === 'session_id'
      && pg.queries[0].params[1] === TENANT_A
      && /cl\.slug = \$2/.test(pg.queries[0].sql));
  }

  {
    const pg = makeTrackingPg({ bySession: [], byId: [rowAMetaOnly] });
    const r = await lookupPaymentForStripeSession(
      pg,
      { id: 'cs_unknown', metadata: { payment_id: PAY_A, client_slug: TENANT_A } },
      TENANT_A,
    );
    green('same_tenant_metadata_fallback',
      r.ok && r.payment && r.payment.payment_id === PAY_A
      && r.lookup_path === 'metadata_payment_id'
      && pg.queries.some((q) => /p\.id = \$1::uuid/.test(q.sql) && q.params[0] === PAY_A && q.params[1] === TENANT_A));
  }

  {
    const addon = { ...rowB, client_slug: TENANT_A, payment_id: PAY_B, stripe_checkout_session_id: CS_B };
    const pg = makeTrackingPg({ bySession: [addon], byId: [] });
    const r = await lookupPaymentForStripeSession(pg, { id: CS_B, metadata: {} }, TENANT_A);
    green('addon_same_tenant',
      r.ok && r.payment && r.payment.payment_kind === 'addon_service'
      && r.payment.client_slug === TENANT_A);
  }

  {
    const reasons = validateStripeBookingPaymentEvent(
      basePm({ payment_status: 'paid', client_slug: TENANT_A }),
      baseSession({ payment_status: 'unpaid' }),
      'checkout.session.completed',
      TENANT_A,
    );
    green('idempotent_same_tenant', reasons.length === 0);

    const mismatch = validateStripeBookingPaymentEvent(
      basePm({ payment_status: 'paid', client_slug: TENANT_A }),
      baseSession(),
      'checkout.session.completed',
      TENANT_B,
    );
    ok('validate independent tenant even when paid',
      mismatch.includes('payment_client_slug_mismatch'));
  }

  {
    const eligible = validateStripeBookingPaymentEvent(
      basePm(),
      baseSession({ metadata: { payment_id: PAY_A, client_slug: TENANT_A } }),
      'checkout.session.completed',
      TENANT_A,
    );
    green('payment_truth_locked_hold_paths',
      eligible.length === 0
      && validateStripeBookingPaymentEvent(
        basePm(),
        baseSession({ metadata: { payment_id: PAY_A, client_slug: TENANT_B } }),
        'checkout.session.completed',
        TENANT_A,
      ).includes('stripe_metadata_client_slug_mismatch'));
  }

  // Reconcile omission
  {
    const pg = makeTrackingPg({ bySession: [rowA], byId: [] });
    const res = await reconcilePaidStripeSession(pg, baseSession(), {
      eventType: 'checkout.session.completed',
    });
    red('reconcile_omission',
      res.ok === false
      && res.reason === 'expected_client_slug_required'
      && res.no_db_write === true
      && pg.queries.length === 0);
  }

  // Secret scan
  console.log('\n── Secret-free scan ──');
  for (const rel of [
    'fixtures/fortress-tenant-identity/slice15b-contract.json',
    'fixtures/fortress-tenant-identity/slice15b-b13-remediation-overlay.json',
    'fixtures/fortress-tenant-identity/slice15b-findings.md',
    'scripts/lib/stripe-webhook-tenant-config.js',
    'scripts/lib/stripe-webhook-payment-truth.js',
    'scripts/verify-fortress-slice15b-stripe-payment-tenant-bind.js',
  ]) {
    const hits = scanSecretFreeText(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    ok(`secret-free ${path.basename(rel)}`, hits.length === 0, hits.join(','));
  }

  const evidence = {
    schema_version: 1,
    slice: 'FORTRESS-15B',
    generated_at: new Date().toISOString(),
    master_basis: contract.master_basis,
    live_mutation: false,
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
    gates_note: 'offline only; zero live Stripe/DB/payment/deploy/guest mutation',
  };
  fs.writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  ok('evidence written', fs.existsSync(EVIDENCE_PATH));

  console.log(`\n── RED ${evidence.red.passed}/${evidence.red.total}  GREEN ${evidence.green.passed}/${evidence.green.total} ──`);
  console.log(`── fortress-slice15b: ${pass} passed, ${fail} failed ──`);
  if (fail > 0) process.exit(1);
  console.log('OK — Slice 15B Stripe payment tenant bind (offline, zero live mutation).');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
