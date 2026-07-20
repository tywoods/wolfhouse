'use strict';

/**
 * verify:fortress-slice15j-payment-uuid-callback-tenant-acl — FORTRESS Slice 15J
 *
 * Offline RED/GREEN tests for path-UUID payment/booking callback tenant ACL
 * (closes B15 gap from 15I design contract). Invokes the three production HTTP
 * handlers (compiled from staff-query-api source + exported bot handler) with
 * real auth/principal ACL wiring and Stripe/DB spies. No network, no live
 * DB/Stripe/deploy. Does not rewrite tracked evidence or historical 15A/15I.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

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
  UNIFORM_PAYMENT_NOT_FOUND_BODY,
  UNIFORM_BOOKING_NOT_FOUND_BODY,
  gateStaffPaymentUuidCallbackTenantAcl,
  gateBotPaymentUuidCallbackTenantAcl,
  gateStaffBookingUuidCallbackTenantAcl,
} = require('./lib/payment-uuid-callback-tenant-acl');
const {
  handleBotPaymentCreateStripeLink,
  makeInMemoryBotReq,
} = require('./lib/staff-bot-v2-routes');
const {
  buildPaymentLinkCommand,
  PAYMENT_LINK_CHANNELS,
  PAYMENT_LINK_OPERATIONS,
} = require('./lib/luna-front-desk-payment-link-service');
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');

const MASTER_BASIS = '6d9f0e99c6c00d9831710c392ec3ac41dcef811b';
// Use real baseline deploy slugs so buildPaymentLinkCommand accepts trustedClientSlug.
const TENANT_ALPHA = 'wolfhouse-somo';
const TENANT_BETA = 'sunset';
const PAY_ALPHA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAY_BETA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAY_MISSING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const BOOK_ALPHA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BOOK_BETA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const BOOK_MISSING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CLIENT_ID_ALPHA = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID_BETA = '22222222-2222-4222-8222-222222222222';
const SVC_REC_1 = '99999999-9999-4999-8999-999999999999';

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

function responseFingerprint(sent) {
  return JSON.stringify({ status: sent.status, body: sent.body });
}

function bodyLeaksForeignDetail(body) {
  const s = JSON.stringify(body || {});
  return /client_slug|amount_due|booking_code|checkout_url|stripe_checkout|payment_kind/i.test(s);
}

function makeTrackingPg(payments, bookings, serviceRecords) {
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
          if (/FROM booking_service_records/i.test(q)) {
            const ids = params[0] || [];
            const bookingId = params[1];
            const slug = params[2];
            const hits = (serviceRecords || []).filter((r) => (
              ids.includes(r.id)
              && r.booking_id === bookingId
              && r.client_slug === slug
            ));
            return { rows: hits, rowCount: hits.length };
          }
          if (/INSERT INTO payments/i.test(q)) {
            return { rows: [{ id: 'pppppppp-pppp-pppp-pppp-pppppppppppp' }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      };
      return fn(pg);
    },
  };
}

/**
 * Canonical staff ACL mirror of assertStaffClientAccess in staff-query-api.js:
 * STAFF_AUTH_REQUIRED && user && !canAccessClient → 403 client_access_denied + client_slug.
 * Gate swallows that body and normalizes to uniform 404 on the real response.
 */
function makeCanonicalAssertStaffClientAccess({ staffAuthRequired, canAccessClient, sendJSON }) {
  const calls = [];
  const denyBodies = [];
  function assertStaffClientAccess(user, clientSlug, res) {
    calls.push({ user, clientSlug });
    if (staffAuthRequired && user && !canAccessClient(user, clientSlug)) {
      const body = {
        success: false,
        error: 'client_access_denied',
        client_slug: clientSlug,
      };
      denyBodies.push(body);
      sendJSON(res, 403, body);
      return false;
    }
    return true;
  }
  return { assertStaffClientAccess, calls, denyBodies };
}

function principalCanAccess(user, clientSlug) {
  const slug = String(clientSlug || '').trim();
  const allowed = (user && Array.isArray(user.allowed_client_slugs))
    ? user.allowed_client_slugs.map((s) => String(s).trim())
    : [];
  return allowed.includes(slug);
}

function makeHttpRes() {
  const sent = [];
  return {
    sent,
    writeHead(status) {
      this._status = status;
      this._headers = {};
    },
    setHeader() {},
    end(data) {
      let body = data;
      try { body = JSON.parse(data); } catch (_) { /* keep raw */ }
      sent.push({ status: this._status, body });
    },
  };
}

function makeSendJSON() {
  return function sendJSON(res, statusCode, body) {
    const data = JSON.stringify(body, null, 2);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  };
}

function makeInMemoryReq(bodyObj) {
  const payload = JSON.stringify(bodyObj || {});
  return {
    method: 'POST',
    headers: {},
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(payload, 'utf8'));
      if (event === 'end') cb();
      return this;
    },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(payload, 'utf8');
    },
  };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function compileStaffHandler(fnName, apiSrc, deps) {
  const src = extractFunction(apiSrc, fnName);
  if (!src) throw new Error(`missing production handler source: ${fnName}`);
  const keys = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...keys, `${src}\nreturn ${fnName};`);
  return factory(...keys.map((k) => deps[k]));
}

function makeStripeRequire(stripeCalls) {
  const realRequire = Module.createRequire(__filename);
  return function patchedRequire(id) {
    if (id === 'stripe') {
      return function stripeFactory() {
        return {
          checkout: {
            sessions: {
              create: async (opts) => {
                stripeCalls.push(opts);
                return {
                  id: 'cs_test_15j',
                  url: 'https://checkout.test/session',
                  expires_at: null,
                  livemode: false,
                };
              },
            },
          },
        };
      };
    }
    return realRequire(id);
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

ok('F4 findings cite three routes + residual + uniform 404',
  /handlePaymentCreateStripeLink/.test(findings)
  && /handleBotPaymentCreateStripeLink/.test(findings)
  && /handleBookingServiceRecordsCreatePaymentLink/.test(findings)
  && /Residual risk/i.test(findings)
  && /uniform 404/i.test(findings)
  && /indistinguishable/i.test(findings));

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

ok('F9 ACL lib normalizes staff deny via silent sink',
  /makeSilentAclRes/.test(aclSrc)
  && /UNIFORM_PAYMENT_NOT_FOUND_BODY/.test(aclSrc)
  && /UNIFORM_BOOKING_NOT_FOUND_BODY/.test(aclSrc));

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
ok('staff payment handler gates before createPaymentLink + uniform 404', (() => {
  const g = staffPayFn.indexOf('gateStaffPaymentUuidCallbackTenantAcl');
  const c = staffPayFn.indexOf('createPaymentLink');
  const s = staffPayFn.indexOf("require('stripe')");
  return g >= 0 && c > g && s > g
    && /assertStaffClientAccess/.test(staffPayFn)
    && /Payment record not found/.test(staffPayFn)
    && !/already sent 403/.test(staffPayFn);
})());

ok('bot payment handler gates before createPaymentLink', (() => {
  const g = botPayFn.indexOf('gateBotPaymentUuidCallbackTenantAcl');
  const c = botPayFn.indexOf('createPaymentLink');
  const s = botPayFn.indexOf("require('stripe')");
  return g >= 0 && c > g && s > g && /boundClientSlug/.test(botPayFn);
})());

ok('service-records handler gates before INSERT/Stripe + uniform 404', (() => {
  const g = staffSvcFn.indexOf('gateStaffBookingUuidCallbackTenantAcl');
  const ins = staffSvcFn.indexOf('INSERT INTO payments');
  const s = staffSvcFn.indexOf("require('stripe')");
  return g >= 0 && ins > g && s > g
    && /assertStaffClientAccess/.test(staffSvcFn)
    && !/user\.client_id/.test(staffSvcFn)
    && /Booking not found/.test(staffSvcFn)
    && !/already sent 403/.test(staffSvcFn);
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

console.log('\n── Production HTTP handlers RED/GREEN (uniform 404 + zero writes) ──');

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
const serviceRecordsDb = [
  {
    id: SVC_REC_1,
    booking_id: BOOK_BETA,
    client_slug: TENANT_BETA,
    service_type: 'lesson',
    service_date: '2026-07-20',
    status: 'confirmed',
    payment_status: 'unpaid',
    amount_due_cents: 2500,
    amount_paid_cents: 0,
    payment_id: null,
  },
];

(async () => {
  const sendJSON = makeSendJSON();

  function buildStaffPaymentHandler({ pg, acl, stripeCalls, createPaymentLinkCalls }) {
    return compileStaffHandler('handlePaymentCreateStripeLink', apiSrc, {
      STAFF_ACTIONS_ENABLED: true,
      STRIPE_LINKS_ENABLED: true,
      STRIPE_SECRET_KEY: 'sk_test_15j_offline',
      stripeCheckoutRedirectUrlsConfigured: () => true,
      gateStaffPaymentUuidCallbackTenantAcl,
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      sendJSON,
      require: makeStripeRequire(stripeCalls),
      buildPaymentLinkCommand,
      createPaymentLink: async (...args) => {
        createPaymentLinkCalls.push(args);
        return {
          ok: true,
          body: {
            payment_id: args[1] && args[1].paymentId,
            booking_id: BOOK_ALPHA,
            booking_code: 'ALPHA-1',
            amount_due_cents: 1000,
            currency: 'EUR',
            payment_status: 'checkout_created',
            checkout_url: 'https://checkout.test/ok',
            stripe_checkout_session_id: 'cs_test_ok',
          },
        };
      },
      paymentLinkServiceExecOpts: () => ({}),
      PAYMENT_LINK_OPERATIONS,
      PAYMENT_LINK_CHANNELS,
      guestPaymentLinkObservability: () => ({
        payment_short_url: null,
        guest_payment_url: 'https://checkout.test/ok',
        uses_short_payment_link: false,
      }),
      appendAuditLog: () => {},
    });
  }

  function buildStaffServiceHandler({ pg, acl, stripeCalls }) {
    const UUID_VALIDATE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return compileStaffHandler('handleBookingServiceRecordsCreatePaymentLink', apiSrc, {
      STAFF_ACTIONS_ENABLED: true,
      STRIPE_LINKS_ENABLED: true,
      STRIPE_SECRET_KEY: 'sk_test_15j_offline',
      stripeCheckoutRedirectUrlsConfigured: () => true,
      stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
      stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel',
      gateStaffBookingUuidCallbackTenantAcl,
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      sendJSON,
      send400: (res, message) => sendJSON(res, 400, { success: false, error: message }),
      readBody,
      UUID_VALIDATE_RE,
      isMissingBookingServiceRecordsTable: () => false,
      require: makeStripeRequire(stripeCalls),
      guestPaymentLinkObservability: () => ({
        payment_short_url: null,
        guest_payment_url: 'https://checkout.test/session',
        uses_short_payment_link: false,
      }),
      appendAuditLog: () => {},
    });
  }

  // ── RED: staff payment foreign vs nonexistent — identical 404, zero Stripe/DB writes
  {
    const pgForeign = makeTrackingPg(paymentsDb, bookingsDb);
    const pgMissing = makeTrackingPg(paymentsDb, bookingsDb);
    const aclForeign = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const aclMissing = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const stripeForeign = [];
    const stripeMissing = [];
    const createForeign = [];
    const createMissing = [];
    const handleForeign = buildStaffPaymentHandler({
      pg: pgForeign, acl: aclForeign, stripeCalls: stripeForeign, createPaymentLinkCalls: createForeign,
    });
    const handleMissing = buildStaffPaymentHandler({
      pg: pgMissing, acl: aclMissing, stripeCalls: stripeMissing, createPaymentLinkCalls: createMissing,
    });
    const user = {
      email: 'op-alpha@example.com',
      staff_user_id: 'staff-1',
      allowed_client_slugs: [TENANT_ALPHA],
    };
    const resForeign = makeHttpRes();
    const resMissing = makeHttpRes();
    await handleForeign(PAY_BETA, makeInMemoryReq({}), resForeign, user);
    await handleMissing(PAY_MISSING, makeInMemoryReq({}), resMissing, user);

    const fpForeign = responseFingerprint(resForeign.sent[0]);
    const fpMissing = responseFingerprint(resMissing.sent[0]);
    red('staff_payment_foreign_and_nonexistent_identical_404_zero_writes',
      resForeign.sent.length === 1
      && resMissing.sent.length === 1
      && fpForeign === fpMissing
      && resForeign.sent[0].status === 404
      && resForeign.sent[0].body.error === UNIFORM_PAYMENT_NOT_FOUND_BODY.error
      && !bodyLeaksForeignDetail(resForeign.sent[0].body)
      && !bodyLeaksForeignDetail(resMissing.sent[0].body)
      && stripeForeign.length === 0
      && stripeMissing.length === 0
      && createForeign.length === 0
      && createMissing.length === 0
      && pgForeign.writes.length === 0
      && pgMissing.writes.length === 0
      && aclForeign.calls.length === 1
      && aclForeign.calls[0].clientSlug === TENANT_BETA
      && aclMissing.calls.length === 0);
  }

  // ── RED: bot foreign vs nonexistent — identical 404, zero Stripe/DB writes
  {
    const pgForeign = makeTrackingPg(paymentsDb, bookingsDb);
    const pgMissing = makeTrackingPg(paymentsDb, bookingsDb);
    const stripeForeign = [];
    const stripeMissing = [];
    const createForeign = [];
    const createMissing = [];
    const resForeign = makeHttpRes();
    const resMissing = makeHttpRes();
    const botUser = {
      role: 'operator',
      staff_user_id: 'luna-bot-internal',
      client_slug: TENANT_ALPHA,
    };
    const ctxForeign = {
      sendJSON,
      withPgClient: pgForeign.withPgClient,
      appendAuditLog: () => {},
      boundClientSlug: TENANT_ALPHA,
      guestPaymentLinkObservability: () => ({}),
      BOT_BOOKING_ENABLED: true,
      STRIPE_LINKS_ENABLED: true,
      STRIPE_SECRET_KEY: 'sk_test_15j_offline',
      STAFF_AUTH_REQUIRED: true,
      STAFF_ACTIONS_ENABLED: true,
      stripeCheckoutRedirectUrlsConfigured: () => true,
      stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
      stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel',
      createPaymentLink: async (...args) => {
        createForeign.push(args);
        throw new Error('must not create on deny');
      },
    };
    const ctxMissing = {
      ...ctxForeign,
      withPgClient: pgMissing.withPgClient,
      createPaymentLink: async (...args) => {
        createMissing.push(args);
        throw new Error('must not create on deny');
      },
    };
    // Patch require inside bot module path: stripe load happens after gate — use
    // createPaymentLink spy; stripe require only if gate passes.
    await handleBotPaymentCreateStripeLink(PAY_BETA, makeInMemoryBotReq({}), resForeign, botUser, 'bot_token', ctxForeign);
    await handleBotPaymentCreateStripeLink(PAY_MISSING, makeInMemoryBotReq({}), resMissing, botUser, 'bot_token', ctxMissing);

    const fpForeign = responseFingerprint(resForeign.sent[0]);
    const fpMissing = responseFingerprint(resMissing.sent[0]);
    red('bot_payment_foreign_and_nonexistent_identical_404_zero_writes',
      resForeign.sent.length === 1
      && resMissing.sent.length === 1
      && fpForeign === fpMissing
      && resForeign.sent[0].status === 404
      && resForeign.sent[0].body.error === UNIFORM_PAYMENT_NOT_FOUND_BODY.error
      && !bodyLeaksForeignDetail(resForeign.sent[0].body)
      && createForeign.length === 0
      && createMissing.length === 0
      && stripeForeign.length === 0
      && stripeMissing.length === 0
      && pgForeign.writes.length === 0
      && pgMissing.writes.length === 0
      && pgForeign.queries.length === 1
      && /cl\.slug = \$2/i.test(pgForeign.queries[0].sql)
      && pgForeign.queries[0].params[1] === TENANT_ALPHA);
  }

  // ── RED: bot empty boundClientSlug
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const createCalls = [];
    const res = makeHttpRes();
    await handleBotPaymentCreateStripeLink(
      PAY_ALPHA,
      makeInMemoryBotReq({}),
      res,
      { role: 'operator', staff_user_id: 'luna-bot-internal' },
      'bot_token',
      {
        sendJSON,
        withPgClient: pg.withPgClient,
        appendAuditLog: () => {},
        boundClientSlug: '',
        guestPaymentLinkObservability: () => ({}),
        BOT_BOOKING_ENABLED: true,
        STRIPE_LINKS_ENABLED: true,
        STRIPE_SECRET_KEY: 'sk_test_15j_offline',
        STAFF_AUTH_REQUIRED: true,
        STAFF_ACTIONS_ENABLED: true,
        stripeCheckoutRedirectUrlsConfigured: () => true,
        stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
        stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel',
        createPaymentLink: async (...args) => { createCalls.push(args); },
      },
    );
    red('bot_empty_bound_client_slug_denied_zero_query_mutation',
      res.sent.length === 1
      && res.sent[0].status === 403
      && res.sent[0].body.error === 'client_access_denied'
      && createCalls.length === 0
      && pg.queries.length === 0
      && pg.writes.length === 0);
  }

  // ── RED: staff service-records foreign vs nonexistent — identical 404 before INSERT
  {
    const pgForeign = makeTrackingPg(paymentsDb, bookingsDb, serviceRecordsDb);
    const pgMissing = makeTrackingPg(paymentsDb, bookingsDb, serviceRecordsDb);
    const aclForeign = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const aclMissing = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const stripeForeign = [];
    const stripeMissing = [];
    const handleForeign = buildStaffServiceHandler({
      pg: pgForeign, acl: aclForeign, stripeCalls: stripeForeign,
    });
    const handleMissing = buildStaffServiceHandler({
      pg: pgMissing, acl: aclMissing, stripeCalls: stripeMissing,
    });
    const user = {
      email: 'op-alpha@example.com',
      staff_user_id: 'staff-1',
      client_id: CLIENT_ID_ALPHA,
      allowed_client_slugs: [TENANT_ALPHA],
    };
    const body = { service_record_ids: [SVC_REC_1] };
    const resForeign = makeHttpRes();
    const resMissing = makeHttpRes();
    await handleForeign(BOOK_BETA, makeInMemoryReq(body), resForeign, user);
    await handleMissing(BOOK_MISSING, makeInMemoryReq(body), resMissing, user);

    const fpForeign = responseFingerprint(resForeign.sent[0]);
    const fpMissing = responseFingerprint(resMissing.sent[0]);
    red('staff_service_records_foreign_and_nonexistent_identical_404_zero_writes',
      resForeign.sent.length === 1
      && resMissing.sent.length === 1
      && fpForeign === fpMissing
      && resForeign.sent[0].status === 404
      && resForeign.sent[0].body.error === UNIFORM_BOOKING_NOT_FOUND_BODY.error
      && !bodyLeaksForeignDetail(resForeign.sent[0].body)
      && stripeForeign.length === 0
      && stripeMissing.length === 0
      && pgForeign.writes.length === 0
      && pgMissing.writes.length === 0
      && aclForeign.calls.length === 1
      && aclForeign.calls[0].clientSlug === TENANT_BETA
      && aclMissing.calls.length === 0
      && !/FROM booking_service_records/i.test(pgForeign.queries.map((q) => q.sql).join('\n')));
  }

  // ── GREEN: staff same-tenant payment authorized → createPaymentLink runs
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const stripeCalls = [];
    const createCalls = [];
    const handle = buildStaffPaymentHandler({
      pg, acl, stripeCalls, createPaymentLinkCalls: createCalls,
    });
    const res = makeHttpRes();
    await handle(
      PAY_ALPHA,
      makeInMemoryReq({}),
      res,
      {
        email: 'op-alpha@example.com',
        staff_user_id: 'staff-1',
        allowed_client_slugs: [TENANT_ALPHA],
      },
    );
    green('staff_same_tenant_payment_uuid_authorized',
      res.sent.length === 1
      && res.sent[0].status === 200
      && res.sent[0].body.success === true
      && createCalls.length === 1
      && pg.writes.length === 0);
  }

  // ── GREEN: secondary-client staff ACL (alpha+beta) can access beta payment
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const stripeCalls = [];
    const createCalls = [];
    const handle = buildStaffPaymentHandler({
      pg, acl, stripeCalls, createPaymentLinkCalls: createCalls,
    });
    const res = makeHttpRes();
    await handle(
      PAY_BETA,
      makeInMemoryReq({}),
      res,
      {
        email: 'multi@example.com',
        staff_user_id: 'staff-multi',
        client_id: CLIENT_ID_ALPHA,
        allowed_client_slugs: [TENANT_ALPHA, TENANT_BETA],
      },
    );
    green('staff_secondary_client_acl_authorized',
      res.sent.length === 1
      && res.sent[0].status === 200
      && res.sent[0].body.success === true
      && createCalls.length === 1
      && acl.calls[0].clientSlug === TENANT_BETA);
  }

  // ── GREEN: bot bound matching payment tenant → createPaymentLink runs
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const createCalls = [];
    const res = makeHttpRes();
    await handleBotPaymentCreateStripeLink(
      PAY_ALPHA,
      makeInMemoryBotReq({}),
      res,
      {
        role: 'operator',
        staff_user_id: 'luna-bot-internal',
        client_slug: TENANT_ALPHA,
      },
      'bot_token',
      {
        sendJSON,
        withPgClient: pg.withPgClient,
        appendAuditLog: () => {},
        boundClientSlug: TENANT_ALPHA,
        guestPaymentLinkObservability: (pm, url, sid) => ({
          payment_short_url: null,
          guest_payment_url: url,
          uses_short_payment_link: false,
        }),
        BOT_BOOKING_ENABLED: true,
        STRIPE_LINKS_ENABLED: true,
        STRIPE_SECRET_KEY: 'sk_test_15j_offline',
        STAFF_AUTH_REQUIRED: true,
        STAFF_ACTIONS_ENABLED: true,
        stripeCheckoutRedirectUrlsConfigured: () => true,
        stripeCheckoutSessionSuccessUrl: () => 'https://example.test/success',
        stripeCheckoutSessionCancelUrl: () => 'https://example.test/cancel',
        createPaymentLink: async (pg, command) => {
          createCalls.push({ command });
          return {
            ok: true,
            body: {
              payment_id: PAY_ALPHA,
              booking_id: BOOK_ALPHA,
              booking_code: 'ALPHA-1',
              amount_due_cents: 1000,
              currency: 'EUR',
              payment_status: 'checkout_created',
              checkout_url: 'https://checkout.test/bot',
              stripe_checkout_session_id: 'cs_bot_ok',
            },
          };
        },
      },
    );
    green('bot_same_tenant_payment_uuid_authorized',
      res.sent.length === 1
      && res.sent[0].status === 200
      && res.sent[0].body.success === true
      && createCalls.length === 1
      && createCalls[0].command.trustedClientSlug === TENANT_ALPHA
      && /cl\.slug = \$2/i.test(pg.queries[0].sql)
      && pg.writes.length === 0);
  }

  // ── GREEN: service-records secondary ACL authorized → Stripe + payment INSERT
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb, serviceRecordsDb);
    const acl = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const stripeCalls = [];
    const handle = buildStaffServiceHandler({ pg, acl, stripeCalls });
    const res = makeHttpRes();
    await handle(
      BOOK_BETA,
      makeInMemoryReq({ service_record_ids: [SVC_REC_1] }),
      res,
      {
        email: 'multi@example.com',
        staff_user_id: 'staff-multi',
        client_id: CLIENT_ID_ALPHA,
        allowed_client_slugs: [TENANT_ALPHA, TENANT_BETA],
      },
    );
    green('staff_service_records_secondary_acl_authorized',
      res.sent.length === 1
      && res.sent[0].status === 200
      && res.sent[0].body.success === true
      && stripeCalls.length === 1
      && pg.writes.some((w) => /INSERT INTO payments/i.test(w.sql))
      && acl.calls[0].clientSlug === TENANT_BETA);
  }

  // GREEN: historical 15A/15I unchanged markers
  green('historical_15a_15i_unchanged',
    matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven'
    && matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity').verdict === 'unproven'
    && overlay15i.reaudit.B14_stripe_locked_payment_identity.reaudit_verdict === 'proven_fail_closed'
    && overlay15i.reaudit.B15_booking_hold_payment_callbacks.reaudit_verdict === 'vulnerable'
    && design.status === 'design_only_not_implemented'
    && overlay.status === 'remediated');

  // Direct gate unit: staff not_found (no ACL call)
  {
    const pg = makeTrackingPg([], []);
    const aclCalls = [];
    const out = await gateStaffPaymentUuidCallbackTenantAcl({
      paymentId: PAY_ALPHA,
      user: { allowed_client_slugs: [TENANT_ALPHA] },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: (u, s, r) => { aclCalls.push(s); return true; },
      res: makeHttpRes(),
    });
    green('staff_payment_not_found_no_acl_call_needed',
      out.ok === false && out.not_found === true && aclCalls.length === 0 && pg.writes.length === 0);
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
      user: { allowed_client_slugs: [TENANT_ALPHA] },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: () => true,
      res: makeHttpRes(),
    });
    green('staff_booking_same_tenant_gate_ok',
      out.ok === true && out.clientSlug === TENANT_ALPHA && out.booking.booking_id === BOOK_ALPHA);
  }

  // Prove gate deny collapses to not_found (no clientSlug on return)
  {
    const pg = makeTrackingPg(paymentsDb, bookingsDb);
    const acl = makeCanonicalAssertStaffClientAccess({
      staffAuthRequired: true,
      canAccessClient: principalCanAccess,
      sendJSON,
    });
    const out = await gateStaffPaymentUuidCallbackTenantAcl({
      paymentId: PAY_BETA,
      user: { email: 'op@example.com', allowed_client_slugs: [TENANT_ALPHA] },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: acl.assertStaffClientAccess,
      res: makeHttpRes(),
    });
    green('staff_gate_deny_collapses_to_not_found_no_slug_leak',
      out.ok === false
      && out.not_found === true
      && !Object.prototype.hasOwnProperty.call(out, 'clientSlug')
      && !Object.prototype.hasOwnProperty.call(out, 'denied')
      && acl.calls.length === 1);
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
