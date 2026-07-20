'use strict';

/**
 * verify:fortress-slice15j-payment-uuid-callback-tenant-acl — FORTRESS Slice 15J
 *
 * Offline RED/GREEN route-level tests for path-UUID payment/booking callback
 * tenant ACL (closes B15 gap from 15I design contract). No network, no live
 * DB/Stripe/deploy. Does not rewrite tracked evidence or historical 15A/15I.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15j-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15j-b15-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15j-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15j-evidence.json');
const DESIGN_PATH = path.join(FIXTURE_DIR, 'slice15i-b15-remediation-contract.json');
const MATRIX_PATH = path.join(FIXTURE_DIR, 'boundary-matrix.json');
const OVERLAY_15I_PATH = path.join(FIXTURE_DIR, 'slice15i-b14-b15-audit-overlay.json');
const DOC_PATH = path.join(ROOT, 'docs', 'FORTRESS-TENANT-IDENTITY-BOUNDARY-MATRIX.md');

const {
  PAYMENT_TENANT_LOOKUP_SQL,
  PAYMENT_TENANT_LOOKUP_BOUND_SQL,
  BOOKING_TENANT_LOOKUP_SQL,
  gateStaffPaymentUuidCallbackTenantAcl,
  gateBotPaymentUuidCallbackTenantAcl,
  gateStaffBookingUuidCallbackTenantAcl,
  runStaffPaymentUuidCallbackWithTenantAcl,
  runBotPaymentUuidCallbackWithTenantAcl,
  runStaffBookingUuidCallbackWithTenantAcl,
} = require('./lib/payment-uuid-callback-tenant-acl');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const MASTER_BASIS = '6d9f0e99c6c00d9831710c392ec3ac41dcef811b';
const TENANT_ALPHA = 'tenant-alpha';
const TENANT_BETA = 'tenant-beta';
const PAY_ALPHA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PAY_BETA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const BOOK_ALPHA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const BOOK_BETA = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const CLIENT_ID_ALPHA = '11111111-1111-1111-1111-111111111111';
const CLIENT_ID_BETA = '22222222-2222-2222-2222-222222222222';

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

function makeTrackingPg(payments, bookings) {
  const queries = [];
  const writes = [];
  return {
    queries,
    writes,
    withPgClient: async (fn) => {
      const pg = {
        query: async (sql, params) => {
          const q = String(sql);
          queries.push({ sql: q, params: params || [] });
          if (/INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|BEGIN|COMMIT|ROLLBACK/i.test(q)
            && !/^\s*SELECT/i.test(q.trim())) {
            writes.push({ sql: q, params: params || [] });
          }
          if (/FROM payments p/i.test(q) && /p\.id = \$1::uuid/i.test(q)) {
            const pid = params[0];
            const slugParam = /cl\.slug = \$2/i.test(q) ? params[1] : null;
            const hit = (payments || []).find((r) => {
              if (r.payment_id !== pid) return false;
              if (slugParam != null && r.client_slug !== slugParam) return false;
              return true;
            });
            return { rows: hit ? [{ client_slug: hit.client_slug }] : [], rowCount: hit ? 1 : 0 };
          }
          if (/FROM bookings b/i.test(q) && /b\.id = \$1/i.test(q)) {
            const bid = params[0];
            const hit = (bookings || []).find((r) => r.booking_id === bid);
            return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(pg);
    },
  };
}

function mockAssertStaffClientAccess(allowedSlugs) {
  const calls = [];
  const responses = [];
  return {
    calls,
    responses,
    assertStaffClientAccess(user, clientSlug, res) {
      calls.push({ user, clientSlug });
      const allowed = (allowedSlugs || []).includes(String(clientSlug || '').trim());
      if (!allowed) {
        const body = { success: false, error: 'client_access_denied', client_slug: clientSlug };
        responses.push({ status: 403, body });
        if (res && typeof res._send === 'function') res._send(403, body);
        return false;
      }
      return true;
    },
  };
}

function makeRes() {
  const sent = [];
  return {
    sent,
    _send(status, body) { sent.push({ status, body }); },
  };
}

console.log('verify:fortress-slice15j-payment-uuid-callback-tenant-acl — FORTRESS Slice 15J\n');

const contract = readJson(CONTRACT_PATH);
const overlay = readJson(OVERLAY_PATH);
const findings = readText(FINDINGS_PATH);
const design = readJson(DESIGN_PATH);
const matrix = readJson(MATRIX_PATH);
const overlay15i = readJson(OVERLAY_15I_PATH);
const doc = readText(DOC_PATH);
const apiSrc = readText(path.join(ROOT, 'scripts/staff-query-api.js'));
const botSrc = readText(path.join(ROOT, 'scripts/lib/staff-bot-v2-routes.js'));
const aclSrc = readText(path.join(ROOT, 'scripts/lib/payment-uuid-callback-tenant-acl.js'));
const committedEvidence = fs.existsSync(EVIDENCE_PATH) ? readJson(EVIDENCE_PATH) : null;

const staffPayFn = extractFunction(apiSrc, 'handlePaymentCreateStripeLink');
const staffSvcFn = extractFunction(apiSrc, 'handleBookingServiceRecordsCreatePaymentLink');
const botPayFn = extractFunction(botSrc, 'handleBotPaymentCreateStripeLink');

ok('F1 contract 15J + master_basis',
  contract.slice === 'FORTRESS-15J'
  && contract.outcome_id === '15J_payment_uuid_callback_tenant_acl'
  && contract.master_basis === MASTER_BASIS
  && contract.live_mutation === false
  && Array.isArray(contract.guarded_routes)
  && contract.guarded_routes.length === 3);

ok('F2 overlay remediated historical untouched',
  overlay.boundary_id === 'B15_booking_hold_payment_callbacks'
  && overlay.status === 'remediated'
  && overlay.historical_audit_unchanged === true
  && overlay.live_mutation === false
  && Array.isArray(overlay.historical_artifacts)
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/boundary-matrix.json')
  && overlay.historical_artifacts.includes('fixtures/fortress-tenant-identity/slice15i-b14-b15-audit-overlay.json'));

ok('F3 design contract still names three handlers',
  design.outcome_id === '15J_payment_uuid_callback_tenant_acl'
  && design.in_scope_handlers.length === 3
  && design.in_scope_handlers.map((h) => h.id).sort().join(',')
    === [
      'bot_payment_create_stripe_link',
      'staff_payment_create_stripe_link',
      'staff_service_records_payment_link',
    ].sort().join(','));

ok('F4 findings cite three routes + residual',
  /handlePaymentCreateStripeLink/.test(findings)
  && /handleBotPaymentCreateStripeLink/.test(findings)
  && /handleBookingServiceRecordsCreatePaymentLink/.test(findings)
  && /Residual risk/i.test(findings));

ok('F5 historical 15A B15 still unproven',
  matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven'
  && /B15 \| Booking\/hold\/payment lookup callbacks \| `unproven`/.test(doc));

ok('F6 historical 15I overlay still vulnerable',
  overlay15i.reaudit.B15_booking_hold_payment_callbacks.reaudit_verdict === 'vulnerable');

ok('F7 no hardcoded tenant authority in ACL lib',
  !/wolfhouse-somo/.test(aclSrc)
  && !/'sunset'/.test(aclSrc)
  && !/"sunset"/.test(aclSrc));

ok('F8 SQL exports are SELECT-only',
  /^\s*SELECT/i.test(PAYMENT_TENANT_LOOKUP_SQL.trim())
  && /^\s*SELECT/i.test(PAYMENT_TENANT_LOOKUP_BOUND_SQL.trim())
  && /^\s*SELECT/i.test(BOOKING_TENANT_LOOKUP_SQL.trim())
  && /AND cl\.slug = \$2/.test(PAYMENT_TENANT_LOOKUP_BOUND_SQL));

console.log('\n── Secret-free ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/slice15j-contract.json',
  'fixtures/fortress-tenant-identity/slice15j-b15-remediation-overlay.json',
  'fixtures/fortress-tenant-identity/slice15j-findings.md',
  'scripts/lib/payment-uuid-callback-tenant-acl.js',
  'scripts/verify-fortress-slice15j-payment-uuid-callback-tenant-acl.js',
]) {
  const hits = scanSecretFreeText(readText(path.join(ROOT, rel)));
  ok(`S secret-free ${rel}`, hits.length === 0, hits.join(','));
}

console.log('\n── Source wiring ──');
ok('staff payment handler gates before createPaymentLink', (() => {
  const g = staffPayFn.indexOf('gateStaffPaymentUuidCallbackTenantAcl');
  const c = staffPayFn.indexOf('createPaymentLink');
  const s = staffPayFn.indexOf("require('stripe')");
  return g >= 0 && c > g && s > g && /assertStaffClientAccess/.test(staffPayFn);
})());

ok('bot payment handler gates before createPaymentLink', (() => {
  const g = botPayFn.indexOf('gateBotPaymentUuidCallbackTenantAcl');
  const c = botPayFn.indexOf('createPaymentLink');
  const s = botPayFn.indexOf("require('stripe')");
  return g >= 0 && c > g && s > g && /boundClientSlug/.test(botPayFn);
})());

ok('service-records handler gates before INSERT/Stripe', (() => {
  const g = staffSvcFn.indexOf('gateStaffBookingUuidCallbackTenantAcl');
  const ins = staffSvcFn.indexOf('INSERT INTO payments');
  const s = staffSvcFn.indexOf("require('stripe')");
  return g >= 0 && ins > g && s > g
    && /assertStaffClientAccess/.test(staffSvcFn)
    && !/user\.client_id/.test(staffSvcFn);
})());

ok('B13/B14 surfaces untouched by this slice (no webhook edits required)',
  /lookupPaymentForStripeSession/.test(apiSrc)
  && /validateLockedPaymentIdentityForStripeTruth/.test(
    readText(path.join(ROOT, 'scripts/lib/stripe-hold-promote-policy.js')),
  ));

ok('guest short-link SQL still slug-scoped',
  /WHERE c\.slug = \$1[\s\S]{0,40}AND UPPER\(b\.booking_code\) = UPPER\(\$2\)/.test(
    readText(path.join(ROOT, 'scripts/lib/luna-payment-short-link.js')),
  ));

console.log('\n── Route-level RED/GREEN (zero writes on deny) ──');

const paymentsDb = [
  { payment_id: PAY_ALPHA, client_slug: TENANT_ALPHA },
  { payment_id: PAY_BETA, client_slug: TENANT_BETA },
];
const bookingsDb = [
  {
    booking_id: BOOK_ALPHA,
    booking_code: 'ALPHA-1',
    guest_name: 'Alpha Guest',
    client_id: CLIENT_ID_ALPHA,
    client_slug: TENANT_ALPHA,
  },
  {
    booking_id: BOOK_BETA,
    booking_code: 'BETA-1',
    guest_name: 'Beta Guest',
    client_id: CLIENT_ID_BETA,
    client_slug: TENANT_BETA,
  },
];

(async () => {
  // RED: staff ACL={tenant-alpha} + other-tenant payment UUID
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = mockAssertStaffClientAccess([TENANT_ALPHA]);
    const res = makeRes();
    let stripeCalls = 0;
    let dbWrites = 0;
    const out = await runStaffPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_BETA,
      user: { email: 'op@example.com', staff_user_id: 'staff-1' },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res,
      onAuthorizedMutation: async () => {
        stripeCalls += 1;
        dbWrites += 1;
      },
    });
    red('staff_cross_tenant_payment_uuid_denied_zero_writes',
      out.ok === false
      && out.denied === true
      && out.mutated === false
      && stripeCalls === 0
      && dbWrites === 0
      && pg.writes.length === 0
      && acl.calls.length === 1
      && acl.calls[0].clientSlug === TENANT_BETA
      && acl.responses[0]
      && acl.responses[0].body.error === 'client_access_denied'
      && !/amount|booking_code|checkout/i.test(JSON.stringify(acl.responses[0].body)));
  }

  // RED: bot bound=alpha + other-tenant payment UUID → uniform 404, zero writes
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    let stripeCalls = 0;
    let dbWrites = 0;
    let denyReason = null;
    const out = await runBotPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_BETA,
      boundClientSlug: TENANT_ALPHA,
      withPgClient: pg.withPgClient,
      onDenied: (g) => { denyReason = g.reason; },
      onAuthorizedMutation: async () => {
        stripeCalls += 1;
        dbWrites += 1;
      },
    });
    red('bot_cross_tenant_payment_uuid_uniform_miss_zero_writes',
      out.ok === false
      && out.mutated === false
      && stripeCalls === 0
      && dbWrites === 0
      && pg.writes.length === 0
      && denyReason === 'payment_not_found_or_tenant_mismatch'
      && pg.queries.length === 1
      && /cl\.slug = \$2/i.test(pg.queries[0].sql)
      && pg.queries[0].params[1] === TENANT_ALPHA
      && !Object.prototype.hasOwnProperty.call(out, 'foreign_client_slug'));
  }

  // RED: bot empty boundClientSlug
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    let stripeCalls = 0;
    const out = await runBotPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_ALPHA,
      boundClientSlug: '',
      withPgClient: pg.withPgClient,
      onAuthorizedMutation: async () => { stripeCalls += 1; },
    });
    red('bot_empty_bound_client_slug_denied_zero_query_mutation',
      out.ok === false
      && out.reason === 'bound_client_slug_required'
      && out.mutated === false
      && stripeCalls === 0
      && pg.queries.length === 0
      && pg.writes.length === 0);
  }

  // RED: staff service-records other-tenant booking UUID before payment insert
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = mockAssertStaffClientAccess([TENANT_ALPHA]);
    const res = makeRes();
    let stripeCalls = 0;
    let paymentInserts = 0;
    const out = await runStaffBookingUuidCallbackWithTenantAcl({
      bookingId: BOOK_BETA,
      user: { email: 'op@example.com', staff_user_id: 'staff-1', client_id: CLIENT_ID_ALPHA },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res,
      onAuthorizedMutation: async () => {
        stripeCalls += 1;
        paymentInserts += 1;
      },
    });
    red('staff_service_records_cross_tenant_booking_denied_before_insert',
      out.ok === false
      && out.denied === true
      && out.mutated === false
      && stripeCalls === 0
      && paymentInserts === 0
      && pg.writes.length === 0
      && acl.responses[0]
      && acl.responses[0].body.error === 'client_access_denied');
  }

  // GREEN: staff matching ACL creates checkout path (mutation allowed)
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = mockAssertStaffClientAccess([TENANT_ALPHA]);
    const res = makeRes();
    let stripeCalls = 0;
    let dbWrites = 0;
    const out = await runStaffPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_ALPHA,
      user: { email: 'op@example.com', staff_user_id: 'staff-1' },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res,
      onAuthorizedMutation: async ({ clientSlug }) => {
        if (clientSlug !== TENANT_ALPHA) throw new Error('trusted slug mismatch');
        stripeCalls += 1;
        dbWrites += 1;
      },
    });
    green('staff_same_tenant_payment_uuid_authorized',
      out.ok === true
      && out.mutated === true
      && stripeCalls === 1
      && dbWrites === 1
      && out.clientSlug === TENANT_ALPHA
      && res.sent.length === 0);
  }

  // GREEN: secondary-client staff ACL (alpha+beta) can access beta payment
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = mockAssertStaffClientAccess([TENANT_ALPHA, TENANT_BETA]);
    let stripeCalls = 0;
    const out = await runStaffPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_BETA,
      user: {
        email: 'multi@example.com',
        staff_user_id: 'staff-multi',
        client_id: CLIENT_ID_ALPHA,
      },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res: makeRes(),
      onAuthorizedMutation: async () => { stripeCalls += 1; },
    });
    green('staff_secondary_client_acl_authorized',
      out.ok === true
      && out.mutated === true
      && stripeCalls === 1
      && out.clientSlug === TENANT_BETA);
  }

  // GREEN: bot bound matching payment tenant
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    let stripeCalls = 0;
    let dbWrites = 0;
    const out = await runBotPaymentUuidCallbackWithTenantAcl({
      paymentId: PAY_ALPHA,
      boundClientSlug: TENANT_ALPHA,
      withPgClient: pg.withPgClient,
      onAuthorizedMutation: async ({ clientSlug }) => {
        if (clientSlug !== TENANT_ALPHA) throw new Error('bound slug mismatch');
        stripeCalls += 1;
        dbWrites += 1;
      },
    });
    green('bot_same_tenant_payment_uuid_authorized',
      out.ok === true
      && out.mutated === true
      && stripeCalls === 1
      && dbWrites === 1
      && out.clientSlug === TENANT_ALPHA
      && /cl\.slug = \$2/i.test(pg.queries[0].sql));
  }

  // GREEN: service-records same-tenant booking authorized (incl. secondary ACL)
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = mockAssertStaffClientAccess([TENANT_ALPHA, TENANT_BETA]);
    let paymentInserts = 0;
    let sawBookingSlug = null;
    const out = await runStaffBookingUuidCallbackWithTenantAcl({
      bookingId: BOOK_BETA,
      user: { email: 'multi@example.com', staff_user_id: 'staff-multi', client_id: CLIENT_ID_ALPHA },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res: makeRes(),
      onAuthorizedMutation: async ({ booking }) => {
        paymentInserts += 1;
        sawBookingSlug = booking.client_slug;
      },
    });
    green('staff_service_records_secondary_acl_authorized',
      out.ok === true
      && out.mutated === true
      && paymentInserts === 1
      && sawBookingSlug === TENANT_BETA);
  }

  // GREEN: historical 15A/15I unchanged markers
  green('historical_15a_15i_unchanged',
    matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven'
    && matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity').verdict === 'unproven'
    && overlay15i.reaudit.B14_stripe_locked_payment_identity.reaudit_verdict === 'proven_fail_closed'
    && overlay15i.reaudit.B15_booking_hold_payment_callbacks.reaudit_verdict === 'vulnerable'
    && design.status === 'design_only_not_implemented'
    && overlay.status === 'remediated');

  // Direct gate unit: staff not_found
  {
    const pg = makeTrackingPg([], []);
    const out = await gateStaffPaymentUuidCallbackTenantAcl({
      paymentId: PAY_ALPHA,
      user: {},
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: () => true,
      res: makeRes(),
    });
    green('staff_payment_not_found_no_acl_call_needed',
      out.ok === false && out.not_found === true && pg.writes.length === 0);
  }

  {
    const out = await gateBotPaymentUuidCallbackTenantAcl({
      paymentId: PAY_ALPHA,
      boundClientSlug: null,
      withPgClient: async () => { throw new Error('must not query'); },
    });
    green('bot_null_bound_fails_before_lookup',
      out.ok === false && out.reason === 'bound_client_slug_required');
  }

  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const out = await gateStaffBookingUuidCallbackTenantAcl({
      bookingId: BOOK_ALPHA,
      user: {},
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: () => true,
      res: makeRes(),
    });
    green('staff_booking_same_tenant_gate_ok',
      out.ok === true && out.clientSlug === TENANT_ALPHA && out.booking.booking_id === BOOK_ALPHA);
  }
})().then(() => {
  console.log('\n── Evidence (read-only) ──');
  ok('evidence exists (not rewritten by verifier)', fs.existsSync(EVIDENCE_PATH));
  if (!committedEvidence) {
    ok('evidence readable', false, 'missing slice15j-evidence.json');
  } else {
    ok('evidence slice + master_basis',
      committedEvidence.slice === 'FORTRESS-15J'
      && committedEvidence.master_basis === MASTER_BASIS
      && committedEvidence.live_mutation === false
      && committedEvidence.boundary_id === 'B15_booking_hold_payment_callbacks'
      && committedEvidence.status === 'remediated');

    const runRedIds = redResults.map((r) => r.id);
    const runGreenIds = greenResults.map((r) => r.id);
    const evidenceRedIds = ((committedEvidence.red && committedEvidence.red.cases) || []).map((c) => c.id);
    const evidenceGreenIds = ((committedEvidence.green && committedEvidence.green.cases) || []).map((c) => c.id);

    ok('evidence RED ids match this run',
      evidenceRedIds.length === runRedIds.length
      && evidenceRedIds.every((id, i) => id === runRedIds[i])
      && redResults.every((r) => r.ok)
      && ((committedEvidence.red && committedEvidence.red.cases) || []).every((c) => c.ok === true));

    ok('evidence GREEN ids match this run',
      evidenceGreenIds.length === runGreenIds.length
      && evidenceGreenIds.every((id, i) => id === runGreenIds[i])
      && greenResults.every((r) => r.ok)
      && ((committedEvidence.green && committedEvidence.green.cases) || []).every((c) => c.ok === true));

    ok('verifier does not rewrite tracked evidence', (() => {
      const src = fs.readFileSync(__filename, 'utf8');
      const writeHits = src.match(/writeFileSync\s*\(\s*EVIDENCE_PATH/g) || [];
      return writeHits.length === 0;
    })());

    ok('evidence pass/fail totals match this run',
      committedEvidence.pass === pass + 1
      && committedEvidence.fail === fail);
  }

  console.log(`\n── verify:fortress-slice15j-payment-uuid-callback-tenant-acl ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
