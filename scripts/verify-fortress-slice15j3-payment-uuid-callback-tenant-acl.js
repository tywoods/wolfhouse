'use strict';

/**
 * verify:fortress-slice15j3-payment-uuid-callback-tenant-acl — FORTRESS Slice 15J3
 *
 * Offline RED/GREEN tests for path-UUID payment/booking callback tenant ACL
 * (closes B15 gap from 15I design contract). Drives the real production
 * staff-query-api listener/router plus staff-session and bot-token middleware;
 * injects PG/Stripe boundaries only. No network, no live DB/Stripe/deploy.
 * Does not rewrite tracked evidence or historical 15A/15I.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'fortress-tenant-identity');
const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice15j3-contract.json');
const OVERLAY_PATH = path.join(FIXTURE_DIR, 'slice15j3-b15-remediation-overlay.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice15j3-findings.md');
const EVIDENCE_PATH = path.join(FIXTURE_DIR, 'slice15j3-evidence.json');
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
const { scanSecretFreeText } = require('./lib/fortress-tenant-identity-boundary');
const {
  createFortress15j3OfflineListener,
  listenHarness,
  closeHarness,
  httpRequest,
  staffSessionCookie,
  responseFingerprint,
  bodyLeaksForeignDetail,
  routeParamMatched,
  assertFortress15j3DualGate,
  fortress15j3DualGateActive,
} = require('./lib/staff-query-api-fortress15j3-offline-harness');
const Module = require('module');
const { spawnSync } = require('child_process');

const MASTER_BASIS = '6d9f0e99c6c00d9831710c392ec3ac41dcef811b';
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

console.log('verify:fortress-slice15j3-payment-uuid-callback-tenant-acl — FORTRESS Slice 15J3\n');

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
const harnessSrc = readText(path.join(ROOT, 'scripts/lib/staff-query-api-fortress15j3-offline-harness.js'));
const committedEvidence = fs.existsSync(EVIDENCE_PATH) ? readJson(EVIDENCE_PATH) : null;

const staffPayFn = extractFunction(apiSrc, 'handlePaymentCreateStripeLink');
const staffSvcFn = extractFunction(apiSrc, 'handleBookingServiceRecordsCreatePaymentLink');
const botPayFn = extractFunction(botSrc, 'handleBotPaymentCreateStripeLink');

ok('F1 contract 15J3 + master_basis',
  contract.slice === 'FORTRESS-15J3'
  && contract.outcome_id === '15J3_payment_uuid_callback_tenant_acl_no_prod_exports'
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

ok('F10 dual-gate offline listener seam (ZERO prod exports + fail-closed inject)',
  /STAFF_API_FORTRESS_OFFLINE_LISTENER/.test(apiSrc)
  && /fortressOfflineListenerSeamsActive/.test(apiSrc)
  && /NODE_ENV/.test(apiSrc)
  && /createStaffQueryApiHttpServer/.test(apiSrc)
  && /shouldEagerCreateStaffQueryApiServer/.test(apiSrc)
  && /getStaffQueryApiCreateServerCalls/.test(apiSrc)
  && /if \(fortressOfflineListenerSeamsActive\(\)\)/.test(apiSrc)
  && /setFortress15j3OfflineSeams/.test(apiSrc)
  && /canAccessClient/.test(apiSrc)
  && /resolveSessionUser/.test(apiSrc)
  && /ZERO seam\/factory\/counter\/router\/server test exports/.test(apiSrc)
  && /createFortress15j3OfflineListener/.test(harnessSrc)
  && /assertFortress15j3DualGate/.test(harnessSrc)
  && /delete safeOverrides\.NODE_ENV/.test(harnessSrc)
  && /api\.server/.test(harnessSrc)
  && !/STAFF_PORTAL_ACCESS_FILE/.test(harnessSrc)
  && !/\bnew\s+Function\s*\(/.test(readText(path.join(ROOT, 'scripts/verify-fortress-slice15j3-payment-uuid-callback-tenant-acl.js')))
  && (() => {
    // Production path must not assign test exports outside the dual-gate block.
    const ungatedAssign = /module\.exports\.(setFortress15j3OfflineSeams|getFortress15j3OfflineSeams|fortressOfflineListenerSeamsActive|createStaffQueryApiHttpServer|getStaffQueryApiCreateServerCalls)\s*=/;
    return !ungatedAssign.test(apiSrc);
  })());

ok('F11 staff-portal-clients ACL loading unchanged (no env override)',
  !/STAFF_PORTAL_ACCESS_FILE/.test(readText(path.join(ROOT, 'scripts/lib/staff-portal-clients.js'))));

console.log('\n── Secret-free ──');
for (const rel of [
  'fixtures/fortress-tenant-identity/slice15j3-contract.json',
  'fixtures/fortress-tenant-identity/slice15j3-b15-remediation-overlay.json',
  'fixtures/fortress-tenant-identity/slice15j3-findings.md',
  'fixtures/fortress-tenant-identity/slice15j3-evidence.json',
  'scripts/lib/payment-uuid-callback-tenant-acl.js',
  'scripts/lib/staff-query-api-fortress15j3-offline-harness.js',
  'scripts/verify-fortress-slice15j3-payment-uuid-callback-tenant-acl.js',
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
const draftPaymentsDb = [
  {
    payment_id: PAY_ALPHA,
    client_id: CLIENT_ID_ALPHA,
    client_slug: TENANT_ALPHA,
    booking_id: BOOK_ALPHA,
    booking_code: 'ALPHA-1',
    guest_name: 'Alpha Guest',
    payment_status: 'draft',
    payment_kind: 'deposit',
    currency: 'EUR',
    amount_due_cents: 1000,
    amount_paid_cents: 0,
    check_in: '2026-07-21',
    check_out: '2026-07-28',
    booking_status: 'confirmed',
    stripe_checkout_session_id: null,
    checkout_url: null,
    metadata: {},
  },
  {
    payment_id: PAY_BETA,
    client_id: CLIENT_ID_BETA,
    client_slug: TENANT_BETA,
    booking_id: BOOK_BETA,
    booking_code: 'BETA-1',
    guest_name: 'Beta Guest',
    payment_status: 'draft',
    payment_kind: 'deposit',
    currency: 'EUR',
    amount_due_cents: 2500,
    amount_paid_cents: 0,
    check_in: '2026-07-21',
    check_out: '2026-07-28',
    booking_status: 'confirmed',
    stripe_checkout_session_id: null,
    checkout_url: null,
    metadata: {},
  },
];

(async () => {
  console.log('\n── Dual-gate RED (export-key sets + createServer=0 + loader identity) ──');

  const FORBIDDEN_TEST_EXPORT_KEYS = [
    'setFortress15j3OfflineSeams',
    'getFortress15j3OfflineSeams',
    'fortressOfflineListenerSeamsActive',
    'createStaffQueryApiHttpServer',
    'getStaffQueryApiCreateServerCalls',
    'router',
    'server',
    'COOKIE_NAME',
    'PAYMENT_STRIPE_LINK_RE',
    'BOT_PAYMENT_STRIPE_LINK_RE',
    'BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE',
  ];

  const REQUIRED_FULL_GATE_EXPORT_KEYS = FORBIDDEN_TEST_EXPORT_KEYS.slice();

  function clearStaffApiCacheLocal() {
    for (const key of Object.keys(require.cache)) {
      if (/staff-query-api\.js$/.test(key)
        || /staff-auth-config\.js$/.test(key)
        || /staff-portal-clients\.js$/.test(key)) {
        delete require.cache[key];
      }
    }
  }

  function applyMinimalStaffApiEnvForRequire(nodeEnv) {
    process.env.NODE_ENV = nodeEnv;
    process.env.STAFF_RUNTIME_PROFILE = nodeEnv;
    process.env.STAFF_AUTH_REQUIRED = 'true';
    process.env.STAFF_AUTH_HTTPS = nodeEnv === 'test' ? 'false' : 'true';
    process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
    process.env.LUNA_BOT_INTERNAL_TOKEN = 'fortress15j3_bot_token_offline_test_01';
    // FORTRESS 15L — staging/production require Meta signature samples (not live).
    if (nodeEnv === 'staging' || nodeEnv === 'production' || nodeEnv === 'prod') {
      process.env.META_APP_SECRET = 'fortress15j3_meta_app_secret_SAMPLE_NOT_LIVE';
      process.env.META_WHATSAPP_VERIFY_TOKEN = 'fortress15j3_verify_token_SAMPLE_NOT_LIVE';
      process.env.META_WEBHOOK_SKIP_VERIFY = 'false';
    }
  }

  function snapshotStaffApiEnv() {
    return {
      NODE_ENV: process.env.NODE_ENV,
      STAFF_RUNTIME_PROFILE: process.env.STAFF_RUNTIME_PROFILE,
      STAFF_AUTH_REQUIRED: process.env.STAFF_AUTH_REQUIRED,
      STAFF_AUTH_HTTPS: process.env.STAFF_AUTH_HTTPS,
      STAFF_QUERY_API_HOST: process.env.STAFF_QUERY_API_HOST,
      LUNA_BOT_INTERNAL_TOKEN: process.env.LUNA_BOT_INTERNAL_TOKEN,
      STAFF_API_FORTRESS_OFFLINE_LISTENER: process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER,
      META_APP_SECRET: process.env.META_APP_SECRET,
      META_WHATSAPP_VERIFY_TOKEN: process.env.META_WHATSAPP_VERIFY_TOKEN,
      META_WEBHOOK_SKIP_VERIFY: process.env.META_WEBHOOK_SKIP_VERIFY,
    };
  }

  function restoreStaffApiEnv(saved) {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  function exportKeySet(apiMod) {
    return Object.keys(apiMod || {}).sort();
  }

  function hasForbiddenTestExports(apiMod) {
    const keys = new Set(exportKeySet(apiMod));
    return FORBIDDEN_TEST_EXPORT_KEYS.filter((k) => keys.has(k));
  }

  function listenerExportsPresent(apiMod) {
    return apiMod
      && typeof apiMod.router === 'function'
      && typeof apiMod.server !== 'undefined'
      && apiMod.COOKIE_NAME
      && apiMod.PAYMENT_STRIPE_LINK_RE
      && apiMod.BOT_PAYMENT_STRIPE_LINK_RE
      && apiMod.BOOKING_SERVICE_RECORDS_PAYMENT_LINK_RE
      && typeof apiMod.setFortress15j3OfflineSeams === 'function'
      && typeof apiMod.getFortress15j3OfflineSeams === 'function'
      && typeof apiMod.fortressOfflineListenerSeamsActive === 'function'
      && typeof apiMod.createStaffQueryApiHttpServer === 'function'
      && typeof apiMod.getStaffQueryApiCreateServerCalls === 'function';
  }

  function tryAssertDualGateNoStripePatch(envSetup) {
    const savedLoad = Module._load;
    const savedNodeEnv = process.env.NODE_ENV;
    const savedFlag = process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER;
    try {
      envSetup();
      let threw = false;
      try {
        assertFortress15j3DualGate();
      } catch (err) {
        threw = err && err.code === 'FORTRESS_15J3_DUAL_GATE';
      }
      return { threw, stripePatched: Module._load !== savedLoad, loaderIdentity: Module._load === savedLoad };
    } finally {
      process.env.NODE_ENV = savedNodeEnv;
      process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = savedFlag;
      Module._load = savedLoad;
    }
  }

  /**
   * Subprocess probe: wrap http.createServer before require so production/
   * partial-gate imports prove createServerCalls=0 without any test exports.
   * Does not patch Module._load (loader identity stays native).
   */
  function probeImportCreateServerAndExports(nodeEnv, flag) {
    const apiScript = path.join(ROOT, 'scripts/staff-query-api.js');
    const probe = `
      const http = require('http');
      let createServerCalls = 0;
      const orig = http.createServer;
      http.createServer = function wrappedCreateServer(...args) {
        createServerCalls += 1;
        return orig.apply(this, args);
      };
      process.env.NODE_ENV = ${JSON.stringify(nodeEnv)};
      process.env.STAFF_RUNTIME_PROFILE = ${JSON.stringify(nodeEnv)};
      process.env.STAFF_AUTH_REQUIRED = 'true';
      process.env.STAFF_AUTH_HTTPS = ${JSON.stringify(nodeEnv === 'test' ? 'false' : 'true')};
      process.env.STAFF_QUERY_API_HOST = '127.0.0.1';
      process.env.LUNA_BOT_INTERNAL_TOKEN = 'fortress15j3_bot_token_offline_test_01';
      process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = ${JSON.stringify(flag)};
      if (${JSON.stringify(nodeEnv === 'staging' || nodeEnv === 'production' || nodeEnv === 'prod')}) {
        process.env.META_APP_SECRET = 'fortress15j3_meta_app_secret_SAMPLE_NOT_LIVE';
        process.env.META_WHATSAPP_VERIFY_TOKEN = 'fortress15j3_verify_token_SAMPLE_NOT_LIVE';
        process.env.META_WEBHOOK_SKIP_VERIFY = 'false';
      }
      const api = require(${JSON.stringify(apiScript)});
      const keys = Object.keys(api).sort();
      process.stdout.write(JSON.stringify({ createServerCalls, keys }));
    `;
    const r = spawnSync(process.execPath, ['-e', probe], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: nodeEnv },
      timeout: 15000,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      return {
        ok: false,
        detail: `${r.stderr || r.stdout || 'probe failed'}`.slice(0, 400),
        createServerCalls: -1,
        keys: [],
      };
    }
    try {
      const parsed = JSON.parse(String(r.stdout || '').trim());
      return {
        ok: true,
        createServerCalls: parsed.createServerCalls,
        keys: parsed.keys || [],
      };
    } catch (err) {
      return { ok: false, detail: String(err), createServerCalls: -1, keys: [] };
    }
  }

  function createServerCalls(apiMod) {
    return typeof apiMod.getStaffQueryApiCreateServerCalls === 'function'
      ? apiMod.getStaffQueryApiCreateServerCalls()
      : -1;
  }

  function probeMainModuleCliStartup() {
    const apiScript = path.join(ROOT, 'scripts/staff-query-api.js');
    const r = spawnSync(process.execPath, [apiScript], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        STAFF_RUNTIME_PROFILE: 'development',
        STAFF_AUTH_REQUIRED: 'false',
        STAFF_AUTH_ALLOW_OPEN: 'true',
        STAFF_AUTH_HTTPS: 'false',
        STAFF_QUERY_API_PORT: '0',
        STAFF_QUERY_API_HOST: '127.0.0.1',
        LUNA_BOT_INTERNAL_TOKEN: 'fortress15j3_bot_token_offline_test_01',
      },
      timeout: 4000,
      encoding: 'utf8',
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    return /Wolfhouse staff query API/i.test(out);
  }

  function assertPartialGateInert(label, nodeEnv, flag) {
    const saved = snapshotStaffApiEnv();
    const savedLoad = Module._load;
    try {
      applyMinimalStaffApiEnvForRequire(nodeEnv);
      process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = flag;
      clearStaffApiCacheLocal();
      const loaderBefore = Module._load;
      const apiMod = require('./staff-query-api');
      const loaderAfter = Module._load;
      const forbidden = hasForbiddenTestExports(apiMod);
      const probe = probeImportCreateServerAndExports(nodeEnv, flag);
      const gateTry = tryAssertDualGateNoStripePatch(() => {
        applyMinimalStaffApiEnvForRequire(nodeEnv);
        process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = flag;
      });
      red(label,
        forbidden.length === 0
        && exportKeySet(apiMod).length === 0
        && loaderBefore === loaderAfter
        && loaderAfter === savedLoad
        && probe.ok
        && probe.createServerCalls === 0
        && FORBIDDEN_TEST_EXPORT_KEYS.every((k) => !probe.keys.includes(k))
        && gateTry.threw
        && gateTry.loaderIdentity
        && !gateTry.stripePatched,
        forbidden.length ? `leaked=${forbidden.join(',')}` : (probe.detail || ''));
    } finally {
      Module._load = savedLoad;
      restoreStaffApiEnv(saved);
      clearStaffApiCacheLocal();
    }
  }

  // ── RED: production / flag-only / test-only — ZERO test exports, createServer=0, loader identity
  assertPartialGateInert('dual_gate_production_zero_test_exports_createServer_loader', 'production', '');
  assertPartialGateInert('dual_gate_flag_only_zero_test_exports_createServer_loader', 'production', '1');
  assertPartialGateInert('dual_gate_test_only_zero_test_exports_createServer_loader', 'test', '');

  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      env: { NODE_ENV: 'production', STAFF_API_FORTRESS_OFFLINE_LISTENER: '' },
    });
    try {
      const keys = exportKeySet(harness.api);
      green('env_override_cannot_downgrade_node_env',
        process.env.NODE_ENV === 'test'
        && process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER === '1'
        && fortress15j3DualGateActive()
        && listenerExportsPresent(harness.api));
      green('dual_gate_full_listener_factory_createServer_calls_one',
        createServerCalls(harness.api) === 1
        && harness.server === harness.api.server
        && typeof harness.server.listen === 'function'
        && REQUIRED_FULL_GATE_EXPORT_KEYS.every((k) => keys.includes(k)));
    } finally {
      await closeHarness(harness);
    }
  }

  green('main_module_cli_startup_uses_server_factory',
    probeMainModuleCliStartup());

  console.log('\n── Production listener RED/GREEN (uniform 404 + zero writes) ──');

  // ── RED: staff payment foreign vs nonexistent — identical 404, zero Stripe/DB writes
  {
    const harnessForeign = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
    });
    const harnessMissing = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
    });
    const portForeign = await listenHarness(harnessForeign);
    const portMissing = await listenHarness(harnessMissing);
    try {
      const staffPathForeign = `/staff/payments/${PAY_BETA}/create-stripe-link`;
      const staffPathMissing = `/staff/payments/${PAY_MISSING}/create-stripe-link`;
      ok('route staff payment path param foreign', routeParamMatched(harnessForeign.api, staffPathForeign, PAY_BETA));
      ok('route staff payment path param missing', routeParamMatched(harnessMissing.api, staffPathMissing, PAY_MISSING));

      const cookie = staffSessionCookie(harnessForeign.sessionAlpha);
      const resForeign = await httpRequest(portForeign, {
        method: 'POST',
        path: staffPathForeign,
        headers: { Cookie: cookie },
        body: {},
      });
      const resMissing = await httpRequest(portMissing, {
        method: 'POST',
        path: staffPathMissing,
        headers: { Cookie: cookie },
        body: {},
      });

      const fpForeign = responseFingerprint(resForeign);
      const fpMissing = responseFingerprint(resMissing);
      red('staff_payment_foreign_and_nonexistent_identical_404_zero_writes',
        resForeign.status === 404
        && resMissing.status === 404
        && fpForeign === fpMissing
        && resForeign.body.error === UNIFORM_PAYMENT_NOT_FOUND_BODY.error
        && !bodyLeaksForeignDetail(resForeign.body)
        && !bodyLeaksForeignDetail(resMissing.body)
        && resForeign.headers['cache-control'] === 'no-store'
        && resMissing.headers['cache-control'] === 'no-store'
        && harnessForeign.stripeCalls.length === 0
        && harnessMissing.stripeCalls.length === 0
        && harnessForeign.tracking.writes.length === 0
        && harnessMissing.tracking.writes.length === 0
        && harnessForeign.tracking.queries.some((q) => /FROM payments p/i.test(q.sql) && q.params[0] === PAY_BETA));
    } finally {
      await closeHarness(harnessForeign);
      await closeHarness(harnessMissing);
    }
  }

  // ── RED: bot foreign vs nonexistent — identical 404, zero Stripe/DB writes
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
    });
    const port = await listenHarness(harness);
    try {
      const botPathForeign = `/staff/bot/payments/${PAY_BETA}/create-stripe-link`;
      const botPathMissing = `/staff/bot/payments/${PAY_MISSING}/create-stripe-link`;
      ok('route bot payment path param foreign', routeParamMatched(harness.api, botPathForeign, PAY_BETA));
      ok('route bot payment path param missing', routeParamMatched(harness.api, botPathMissing, PAY_MISSING));

      const botHeaders = { 'X-Luna-Bot-Token': harness.botToken };
      const resForeign = await httpRequest(port, {
        method: 'POST',
        path: botPathForeign,
        headers: botHeaders,
        body: {},
      });
      const queriesBeforeMissing = harness.tracking.queries.length;
      const resMissing = await httpRequest(port, {
        method: 'POST',
        path: botPathMissing,
        headers: botHeaders,
        body: {},
      });

      const fpForeign = responseFingerprint(resForeign);
      const fpMissing = responseFingerprint(resMissing);
      const boundQueries = harness.tracking.queries.filter((q) => /cl\.slug = \$2/i.test(q.sql));
      red('bot_payment_foreign_and_nonexistent_identical_404_zero_writes',
        resForeign.status === 404
        && resMissing.status === 404
        && fpForeign === fpMissing
        && resForeign.body.error === UNIFORM_PAYMENT_NOT_FOUND_BODY.error
        && !bodyLeaksForeignDetail(resForeign.body)
        && harness.stripeCalls.length === 0
        && harness.tracking.writes.length === 0
        && boundQueries.length >= 1
        && boundQueries[0].params[1] === TENANT_ALPHA
        && queriesBeforeMissing >= 1);
    } finally {
      await closeHarness(harness);
    }
  }

  // ── RED: bot open-auth empty boundClientSlug (real router, no bot principal pin)
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      env: {
        STAFF_AUTH_REQUIRED: 'false',
        STAFF_AUTH_ALLOW_OPEN: 'true',
        LUNA_BOT_INTERNAL_TOKEN: '',
      },
    });
    const port = await listenHarness(harness);
    try {
      const res = await httpRequest(port, {
        method: 'POST',
        path: `/staff/bot/payments/${PAY_ALPHA}/create-stripe-link`,
        headers: {},
        body: {},
      });
      red('bot_empty_bound_client_slug_denied_zero_query_mutation',
        res.status === 403
        && res.body.error === 'client_access_denied'
        && harness.stripeCalls.length === 0
        && harness.tracking.writes.length === 0
        && !harness.tracking.queries.some((q) => /FROM payments p/i.test(q.sql)));
    } finally {
      await closeHarness(harness);
    }
  }

  // ── RED: staff service-records foreign vs nonexistent — identical 404 before INSERT
  {
    const harnessForeign = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      serviceRecords: serviceRecordsDb,
    });
    const harnessMissing = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      serviceRecords: serviceRecordsDb,
    });
    const portForeign = await listenHarness(harnessForeign);
    const portMissing = await listenHarness(harnessMissing);
    try {
      const svcPathForeign = `/staff/bookings/${BOOK_BETA}/service-records/create-payment-link`;
      const svcPathMissing = `/staff/bookings/${BOOK_MISSING}/service-records/create-payment-link`;
      ok('route service-records path param foreign', routeParamMatched(harnessForeign.api, svcPathForeign, null, BOOK_BETA));
      ok('route service-records path param missing', routeParamMatched(harnessMissing.api, svcPathMissing, null, BOOK_MISSING));

      const cookie = staffSessionCookie(harnessForeign.sessionAlpha);
      const body = { service_record_ids: [SVC_REC_1] };
      const resForeign = await httpRequest(portForeign, {
        method: 'POST',
        path: svcPathForeign,
        headers: { Cookie: cookie },
        body,
      });
      const resMissing = await httpRequest(portMissing, {
        method: 'POST',
        path: svcPathMissing,
        headers: { Cookie: cookie },
        body,
      });

      const fpForeign = responseFingerprint(resForeign);
      const fpMissing = responseFingerprint(resMissing);
      red('staff_service_records_foreign_and_nonexistent_identical_404_zero_writes',
        resForeign.status === 404
        && resMissing.status === 404
        && fpForeign === fpMissing
        && resForeign.body.error === UNIFORM_BOOKING_NOT_FOUND_BODY.error
        && !bodyLeaksForeignDetail(resForeign.body)
        && harnessForeign.stripeCalls.length === 0
        && harnessMissing.stripeCalls.length === 0
        && harnessForeign.tracking.writes.length === 0
        && harnessMissing.tracking.writes.length === 0
        && !harnessForeign.tracking.queries.some((q) => /FROM booking_service_records/i.test(q.sql)));
    } finally {
      await closeHarness(harnessForeign);
      await closeHarness(harnessMissing);
    }
  }

  // ── GREEN: staff same-tenant payment authorized → createPaymentLink + Stripe boundary
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      draftPayments: draftPaymentsDb,
    });
    const port = await listenHarness(harness);
    try {
      const res = await httpRequest(port, {
        method: 'POST',
        path: `/staff/payments/${PAY_ALPHA}/create-stripe-link`,
        headers: { Cookie: staffSessionCookie(harness.sessionAlpha) },
        body: {},
      });
      green('staff_same_tenant_payment_uuid_authorized',
        res.status === 200
        && res.body.success === true
        && harness.stripeCalls.length === 1
        && harness.tracking.writes.some((w) => /UPDATE payments/i.test(w.sql)));
    } finally {
      await closeHarness(harness);
    }
  }

  // ── GREEN: secondary-client staff ACL (multi fixture email) can access beta payment
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      draftPayments: draftPaymentsDb,
    });
    const port = await listenHarness(harness);
    try {
      const res = await httpRequest(port, {
        method: 'POST',
        path: `/staff/payments/${PAY_BETA}/create-stripe-link`,
        headers: { Cookie: staffSessionCookie(harness.sessionMulti) },
        body: {},
      });
      green('staff_secondary_client_acl_authorized',
        res.status === 400
        && /booking_id or booking_code is required/i.test(String(res.body.error || ''))
        && harness.tracking.queries.some((q) => /FROM payments p/i.test(q.sql) && q.params[0] === PAY_BETA));
    } finally {
      await closeHarness(harness);
    }
  }

  // ── GREEN: bot bound matching payment tenant → createPaymentLink + bound SELECT
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      draftPayments: draftPaymentsDb,
    });
    const port = await listenHarness(harness);
    try {
      const res = await httpRequest(port, {
        method: 'POST',
        path: `/staff/bot/payments/${PAY_ALPHA}/create-stripe-link`,
        headers: { 'X-Luna-Bot-Token': harness.botToken },
        body: {},
      });
      const boundQuery = harness.tracking.queries.find((q) => /cl\.slug = \$2/i.test(q.sql));
      green('bot_same_tenant_payment_uuid_authorized',
        res.status === 200
        && res.body.success === true
        && harness.stripeCalls.length === 1
        && boundQuery
        && boundQuery.params[1] === TENANT_ALPHA
        && boundQuery.params[0] === PAY_ALPHA);
    } finally {
      await closeHarness(harness);
    }
  }

  // ── GREEN: service-records secondary ACL authorized → Stripe + payment INSERT
  {
    const harness = createFortress15j3OfflineListener({
      payments: paymentsDb,
      bookings: bookingsDb,
      serviceRecords: serviceRecordsDb,
    });
    const port = await listenHarness(harness);
    try {
      const res = await httpRequest(port, {
        method: 'POST',
        path: `/staff/bookings/${BOOK_BETA}/service-records/create-payment-link`,
        headers: { Cookie: staffSessionCookie(harness.sessionMulti) },
        body: { service_record_ids: [SVC_REC_1] },
      });
      green('staff_service_records_secondary_acl_authorized',
        res.status === 200
        && res.body.success === true
        && harness.stripeCalls.length === 1
        && harness.tracking.writes.some((w) => /INSERT INTO payments/i.test(w.sql)));
    } finally {
      await closeHarness(harness);
    }
  }

  green('historical_15a_15i_unchanged',
    matrix.boundaries.find((b) => b.id === 'B15_booking_hold_payment_callbacks').verdict === 'unproven'
    && matrix.boundaries.find((b) => b.id === 'B14_stripe_locked_payment_identity').verdict === 'unproven'
    && overlay15i.reaudit.B14_stripe_locked_payment_identity.reaudit_verdict === 'proven_fail_closed'
    && overlay15i.reaudit.B15_booking_hold_payment_callbacks.reaudit_verdict === 'vulnerable'
    && design.status === 'design_only_not_implemented'
    && overlay.status === 'remediated');

  // Direct gate unit: staff not_found (no ACL call)
  {
    const { makeTrackingPg } = require('./lib/staff-query-api-fortress15j3-offline-harness');
    const pg = makeTrackingPg({ payments: [], bookings: [] });
    const aclCalls = [];
    const out = await gateStaffPaymentUuidCallbackTenantAcl({
      paymentId: PAY_ALPHA,
      user: { email: 'fortress15j3.alpha@example.test' },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: (u, s, r) => { aclCalls.push(s); return true; },
      res: { writeHead() {}, setHeader() {}, end() {} },
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
    const pg = require('./lib/staff-query-api-fortress15j3-offline-harness').makeTrackingPg({
      payments: paymentsDb,
      bookings: bookingsDb,
    });
    const out = await gateStaffBookingUuidCallbackTenantAcl({
      bookingId: BOOK_ALPHA,
      user: { email: 'fortress15j3.alpha@example.test' },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: () => true,
      res: { writeHead() {}, setHeader() {}, end() {} },
    });
    green('staff_booking_same_tenant_gate_ok',
      out.ok === true && out.clientSlug === TENANT_ALPHA && out.booking.booking_id === BOOK_ALPHA);
  }

  {
    const pg = require('./lib/staff-query-api-fortress15j3-offline-harness').makeTrackingPg({
      payments: paymentsDb,
      bookings: bookingsDb,
    });
    const denyBodies = [];
    const out = await gateStaffPaymentUuidCallbackTenantAcl({
      paymentId: PAY_BETA,
      user: { email: 'fortress15j3.alpha@example.test' },
      withPgClient: pg.withPgClient,
      assertStaffClientAccess: (user, slug, res) => {
        denyBodies.push({ slug });
        res.writeHead(403);
        res.end(JSON.stringify({ success: false, error: 'client_access_denied', client_slug: slug }));
        return false;
      },
      res: { writeHead() {}, setHeader() {}, end() {} },
    });
    green('staff_gate_deny_collapses_to_not_found_no_slug_leak',
      out.ok === false
      && out.not_found === true
      && !Object.prototype.hasOwnProperty.call(out, 'clientSlug')
      && denyBodies.length === 1
      && denyBodies[0].slug === TENANT_BETA);
  }

  // ── Production/partial-gate: ZERO test exports (seam setters absent) ──
  {
    const saved = snapshotStaffApiEnv();
    const savedLoad = Module._load;
    try {
      applyMinimalStaffApiEnvForRequire('production');
      process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '1';
      clearStaffApiCacheLocal();
      const loaderBefore = Module._load;
      const apiProd = require('./staff-query-api');
      green('production_node_env_seam_inert',
        hasForbiddenTestExports(apiProd).length === 0
        && exportKeySet(apiProd).length === 0
        && typeof apiProd.setFortress15j3OfflineSeams === 'undefined'
        && typeof apiProd.getFortress15j3OfflineSeams === 'undefined'
        && typeof apiProd.fortressOfflineListenerSeamsActive === 'undefined'
        && Module._load === loaderBefore
        && Module._load === savedLoad);

      applyMinimalStaffApiEnvForRequire('test');
      process.env.STAFF_API_FORTRESS_OFFLINE_LISTENER = '';
      clearStaffApiCacheLocal();
      const loaderBefore2 = Module._load;
      const apiPartial = require('./staff-query-api');
      green('production_seam_set_inert_without_dual_gate',
        hasForbiddenTestExports(apiPartial).length === 0
        && exportKeySet(apiPartial).length === 0
        && typeof apiPartial.setFortress15j3OfflineSeams === 'undefined'
        && typeof apiPartial.getFortress15j3OfflineSeams === 'undefined'
        && Module._load === loaderBefore2
        && Module._load === savedLoad);
    } finally {
      Module._load = savedLoad;
      restoreStaffApiEnv(saved);
      clearStaffApiCacheLocal();
    }
  }

  green('no_acl_file_env_override_in_harness',
    !/STAFF_PORTAL_ACCESS_FILE/.test(harnessSrc)
    && /canAccessClient/.test(harnessSrc)
    && /HARNESS_CLIENT_ACCESS/.test(harnessSrc)
    && /function createFortress15j3OfflineListener[\s\S]*?assertFortress15j3DualGate\(\);[\s\S]*?patchStripeModule\(/.test(harnessSrc));
})().then(() => {
  console.log('\n── Evidence (read-only) ──');
  ok('evidence exists (not rewritten by verifier)', fs.existsSync(EVIDENCE_PATH));
  if (!committedEvidence) {
    ok('evidence readable', false, 'missing slice15j3-evidence.json');
  } else {
    ok('evidence slice + master_basis',
      committedEvidence.slice === 'FORTRESS-15J3'
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

    ok('evidence proof cites listener-level HTTP',
      committedEvidence.proof
      && committedEvidence.proof.handler_invocation === 'production_listener_http'
      && /middleware/.test(String(committedEvidence.proof.auth || '')));

    ok('verifier does not rewrite tracked evidence', (() => {
      const src = fs.readFileSync(__filename, 'utf8');
      const writeHits = src.match(/writeFileSync\s*\(\s*EVIDENCE_PATH/g) || [];
      return writeHits.length === 0;
    })());

    ok('evidence pass/fail totals match this run',
      committedEvidence.pass === pass + 1
      && committedEvidence.fail === fail);
  }

  console.log(`\n── verify:fortress-slice15j3-payment-uuid-callback-tenant-acl ${fail ? 'FAILED' : 'PASSED'} (pass=${pass} fail=${fail}) ──\n`);
  process.exit(fail ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
