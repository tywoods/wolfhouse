/**
 * Phase 13c / 13c.2 / 13e — Verifier for Luna gated booking write bridge.
 *
 * Deny-matrix hardening: every blocked case must not call invokeCreate.
 * No real DB writes — eligible path uses mock invokeCreate only.
 *
 * Usage:
 *   npm run verify:luna-agent-phase13-booking-write-bridge
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const BRIDGE  = path.join(__dirname, 'lib', 'luna-guest-booking-write-bridge.js');
const API     = path.join(__dirname, 'staff-query-api.js');
const PKG     = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

function makeCompleteInput(overrides) {
  return Object.assign({
    client_slug:      'wolfhouse-somo',
    guest_name:       'Bridge Guest',
    check_in:         '2026-09-01',
    check_out:        '2026-09-08',
    guest_count:      2,
    package_code:     'malibu',
    room_type:        'shared',
    phone:            '+34000000000',
    payment_choice:   'deposit',
    confirm:          true,
    idempotency_key:  'phase13c-bridge-key-001',
  }, overrides || {});
}

function makeEmptyBedPg() {
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/bot_pause_states/i.test(s)) return { rows: [] };
      if (/FROM\s+booking_beds/i.test(s)) return { rows: [] };
      if (/FROM\s+rooms\s+r/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function makePausedGatePg() {
  const bedRows = [
    { bed_code: 'MOCK-B1', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B1' },
    { bed_code: 'MOCK-B2', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B2' },
  ];
  const pauseRow = {
    id: 'pause-test-1',
    client_slug: 'wolfhouse-somo',
    guest_phone: '+34000000000',
    conversation_id: null,
    booking_id: null,
    booking_code: null,
    paused: true,
    pause_reason: 'deny-matrix-test',
    paused_by: 'verifier',
    paused_at: new Date().toISOString(),
    resumed_by: null,
    resumed_at: null,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/bot_pause_states/i.test(s)) return { rows: [pauseRow] };
      if (/FROM\s+booking_beds/i.test(s)) return { rows: [] };
      if (/FROM\s+rooms\s+r/i.test(s) && /bd\.bed_code/i.test(s)) return { rows: bedRows };
      return { rows: [] };
    },
  };
}

/** Minimal pg mock: pause gate active + two available beds for dry-run availability. */
function makeMockPg() {
  const bedRows = [
    { bed_code: 'MOCK-B1', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B1' },
    { bed_code: 'MOCK-B2', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B2' },
  ];
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/bot_pause_states/i.test(s)) {
        return { rows: [] };
      }
      if (/FROM\s+booking_beds/i.test(s)) {
        return { rows: [] };
      }
      if (/FROM\s+rooms\s+r/i.test(s) && /bd\.bed_code/i.test(s)) {
        return { rows: bedRows };
      }
      return { rows: [] };
    },
  };
}

console.log('\nverify-luna-agent-phase13-booking-write-bridge.js  (Phase 13c)\n');

// ─────────────────────────────────────────────────────────────────────────────
section('A. Module and route presence');

if (!fs.existsSync(BRIDGE)) {
  fail('A1', 'luna-guest-booking-write-bridge.js missing');
  process.exit(1);
}
pass('A1', 'bridge module exists');

try {
  execSync(`node --check "${BRIDGE}"`, { stdio: 'pipe' });
  pass('A2', 'bridge passes node --check');
} catch {
  fail('A2', 'bridge syntax error');
}

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A3', 'staff-query-api.js passes node --check');
} catch {
  fail('A3', 'staff-query-api.js syntax error');
}

const apiSrc = readOrEmpty(API);
const bridgeSrc = readOrEmpty(BRIDGE);

let bridge;
try {
  bridge = require('./lib/luna-guest-booking-write-bridge');
  pass('A4', 'bridge module loads');
} catch (e) {
  fail('A4', 'bridge load failed: ' + e.message);
  process.exit(1);
}

if (typeof bridge.runLunaGuestBookingWriteBridge === 'function') {
  pass('A5', 'exports runLunaGuestBookingWriteBridge');
} else {
  fail('A5', 'runLunaGuestBookingWriteBridge missing');
}

if (typeof bridge.buildBotBookingCreatePayload === 'function') {
  pass('A6', 'exports buildBotBookingCreatePayload');
} else {
  fail('A6', 'buildBotBookingCreatePayload missing');
}

const routeIdx = apiSrc.indexOf("'/staff/bot/booking-create-from-plan'");
if (routeIdx > -1 && apiSrc.includes('handleBotBookingCreateFromPlan')) {
  pass('A7', 'POST /staff/bot/booking-create-from-plan route registered');
} else {
  fail('A7', 'booking-create-from-plan route missing');
}

const routeBlock = routeIdx > -1 ? apiSrc.slice(routeIdx, routeIdx + 500) : '';
if (routeBlock.includes('requireBotAuth')) {
  pass('A8', 'route uses requireBotAuth');
} else {
  fail('A8', 'requireBotAuth missing on route');
}

const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase13-booking-write-bridge']) {
  pass('A9', 'npm script registered');
} else {
  fail('A9', 'npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Reuse dry-run, eligibility, and bot create path');

if (bridgeSrc.includes('runLunaGuestBookingDryRun')) pass('B1', 'reuses runLunaGuestBookingDryRun');
else fail('B1', 'dry-run orchestrator not referenced');

if (bridgeSrc.includes('evaluateLunaBookingWriteEligibility')) pass('B2', 'reuses evaluateLunaBookingWriteEligibility');
else fail('B2', 'eligibility evaluator not referenced');

if (bridgeSrc.includes('handleBotBookingCreate') || apiSrc.includes('handleBotBookingCreate')) {
  pass('B3', 'references handleBotBookingCreate path');
} else {
  fail('B3', 'handleBotBookingCreate not referenced');
}

if (bridgeSrc.includes('/staff/bot/bookings/create') || bridge.BOT_CREATE_ROUTE === 'POST /staff/bot/bookings/create') {
  pass('B4', 'would_call targets POST /staff/bot/bookings/create');
} else {
  fail('B4', 'bot create route constant missing');
}

if (!bridgeSrc.includes('calculateWolfhouseQuote')) {
  pass('B5', 'no duplicate pricing engine in bridge');
} else {
  fail('B5', 'bridge duplicates calculateWolfhouseQuote');
}

if (bridgeSrc.includes('selected_bed_codes')) pass('B6', 'maps selected_bed_codes to create payload');
else fail('B6', 'selected_bed_codes mapping missing');

const eligCallIdx = bridgeSrc.indexOf('evaluateLunaBookingWriteEligibility');
const writeReadyGateIdx = bridgeSrc.indexOf('eligibility.write_ready !== true');
const invokeIdx = bridgeSrc.indexOf('ctx.invokeCreate');
if (eligCallIdx > -1 && writeReadyGateIdx > -1 && invokeIdx > -1
    && eligCallIdx < writeReadyGateIdx && writeReadyGateIdx < invokeIdx) {
  pass('B7', 'eligibility evaluated before invokeCreate gate');
} else {
  fail('B7', 'eligibility/invokeCreate order unclear in bridge');
}

if (bridgeSrc.includes('formatBridgeDenied') && bridgeSrc.includes('BOT_BOOKING_ENABLED')) {
  pass('B8', 'belt-and-suspenders env/confirm/idempotency checks before invoke');
} else {
  fail('B8', 'pre-invoke approval checks missing');
}

const lookupIdx = bridgeSrc.indexOf('lookupIdempotentBookingReplay');
const dryRunIdx = bridgeSrc.indexOf('runLunaGuestBookingDryRun(src');
if (lookupIdx > -1 && dryRunIdx > -1 && lookupIdx < dryRunIdx) {
  pass('B9', 'idempotency lookup before dry-run (13e)');
} else {
  fail('B9', 'idempotency-first order missing');
}

if (bridgeSrc.includes('idempotent_replay') && bridgeSrc.includes('formatIdempotentReplay')) {
  pass('B10', 'idempotent replay response helper present');
} else {
  fail('B10', 'idempotent replay helper missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Static safety — no Stripe/WhatsApp/n8n/webhook/payment-link');

const stripped = bridgeSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

if (!/\bINSERT\s+INTO\b/i.test(stripped)) pass('C1', 'bridge: no INSERT SQL');
else fail('C1', 'INSERT in bridge');

if (!/\bUPDATE\s+\w/i.test(stripped)) pass('C2', 'bridge: no UPDATE SQL');
else fail('C2', 'UPDATE in bridge');

const forbidden = [
  ['C3', 'create-stripe-link', 'Stripe link'],
  ['C4', 'api.stripe.com', 'Stripe API'],
  ['C5', 'graph.facebook.com', 'WhatsApp'],
  ['C6', 'handleStripeWebhook', 'webhook'],
  ['C7', 'generate-payment-link', 'payment-link route'],
  ['C8', 'require(\'n8n', 'n8n'],
];

for (const [id, needle, label] of forbidden) {
  if (!bridgeSrc.includes(needle)) pass(id, 'bridge: no ' + label);
  else fail(id, label + ' in bridge');
}

if (!/require\s*\(\s*['"]\.\/staff-query-api['"]/.test(bridgeSrc)) {
  pass('C9', 'bridge does not import staff-query-api');
} else {
  fail('C9', 'bridge imports staff-query-api');
}

const handlerStart = apiSrc.indexOf('async function handleBotBookingCreateFromPlan(');
const handlerEnd   = apiSrc.indexOf('// Route: POST /staff/stripe/webhook', handlerStart);
const handlerSlice = handlerStart > -1 && handlerEnd > handlerStart
  ? apiSrc.slice(handlerStart, handlerEnd)
  : '';

if (handlerSlice.includes('runLunaGuestBookingWriteBridge') && handlerSlice.includes('handleBotBookingCreate')) {
  pass('C10', 'route handler chains bridge → handleBotBookingCreate');
} else {
  fail('C10', 'handler chain incomplete');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Runtime default-deny (no DB write)');

(async () => {
  const disabledEnv = { BOT_BOOKING_ENABLED: 'false' };

  try {
    const sparse = await bridge.runLunaGuestBookingWriteBridge(
      { client_slug: 'wolfhouse-somo' },
      { pg: null, env: disabledEnv }
    );
    if (sparse.write_performed === false && sparse.success === false) {
      pass('D1', 'sparse input: no write performed');
    } else {
      fail('D1', 'sparse input unexpectedly wrote');
    }
  } catch (e) {
    fail('D0.sparse', e.message);
  }

  try {
    const noFlag = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput(),
      { pg: makeMockPg(), env: disabledEnv }
    );
    if (noFlag.write_performed === false
        && (noFlag.required_approvals || []).includes('BOT_BOOKING_ENABLED')) {
      pass('D2', 'BOT_BOOKING_ENABLED=false blocks write');
    } else {
      fail('D2', 'BOT_BOOKING_ENABLED gate failed: ' + JSON.stringify(noFlag.required_approvals));
    }
  } catch (e) {
    fail('D0.flag', e.message);
  }

  try {
    const noConfirm = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput({ confirm: false }),
      { pg: makeMockPg(), env: { BOT_BOOKING_ENABLED: 'true' } }
    );
    if (noConfirm.write_performed === false
        && (noConfirm.required_approvals || []).includes('confirm_true')) {
      pass('D3', 'missing confirm blocks write');
    } else {
      fail('D3', 'confirm gate failed');
    }
  } catch (e) {
    fail('D0.confirm', e.message);
  }

  try {
    const noIdem = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput({ idempotency_key: '' }),
      { pg: makeMockPg(), env: { BOT_BOOKING_ENABLED: 'true' } }
    );
    if (noIdem.write_performed === false
        && (noIdem.required_approvals || []).includes('idempotency_key')) {
      pass('D4', 'missing idempotency_key blocks write');
    } else {
      fail('D4', 'idempotency gate failed');
    }
  } catch (e) {
    fail('D0.idem', e.message);
  }

  try {
    const noPay = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput({ payment_choice: '' }),
      { pg: makeMockPg(), env: { BOT_BOOKING_ENABLED: 'true' } }
    );
    if (noPay.write_performed === false
        && (noPay.blocked_reasons || []).includes('payment_choice_missing')) {
      pass('D5', 'missing payment choice blocks write');
    } else {
      fail('D5', 'payment choice block missing');
    }
  } catch (e) {
    fail('D0.pay', e.message);
  }

  try {
    const noBeds = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput(),
      { pg: null, env: { BOT_BOOKING_ENABLED: 'true' } }
    );
    if (noBeds.write_performed === false
        && (noBeds.blocked_reasons || []).some((r) => r.startsWith('availability_'))) {
      pass('D6', 'insufficient availability blocks write');
    } else {
      fail('D6', 'availability block missing: ' + JSON.stringify(noBeds.blocked_reasons));
    }
  } catch (e) {
    fail('D0.beds', e.message);
  }

  try {
    let invoked = false;
    const blocked = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput({ payment_choice: '' }),
      {
        pg: makeMockPg(),
        env: { BOT_BOOKING_ENABLED: 'true' },
        invokeCreate: async () => {
          invoked = true;
          return { write_performed: true };
        },
      }
    );
    if (!invoked && blocked.write_performed === false) {
      pass('D7', 'invokeCreate not called when not write_ready');
    } else {
      fail('D7', 'invokeCreate called when blocked');
    }
  } catch (e) {
    fail('D0.invoke', e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('E. Eligible path — mock invoke only (no DB)');

  try {
    let mockPayload = null;
    let invokeCount = 0;
    const enabledEnv = { BOT_BOOKING_ENABLED: 'true' };

    const eligible = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput(),
      {
        pg: makeMockPg(),
        env: enabledEnv,
        invokeCreate: async (payload) => {
          invokeCount++;
          mockPayload = payload;
          return {
            success:         true,
            write_performed: true,
            status_code:     201,
            create_response: { success: true, created: true, mocked: true },
          };
        },
      }
    );

    if (eligible.eligibility && eligible.eligibility.write_ready === true) {
      pass('E1', 'mock pg path reaches write_ready');
    } else {
      fail('E1', 'write_ready false: ' + JSON.stringify(eligible.blocked_reasons || eligible.required_approvals));
    }

    if (invokeCount === 1) pass('E2', 'invokeCreate called once on eligible path');
    else fail('E2', 'invokeCreate call count: ' + invokeCount);

    if (mockPayload && mockPayload.confirm === true
        && Array.isArray(mockPayload.selected_bed_codes)
        && mockPayload.selected_bed_codes.length >= 2) {
      pass('E3', 'create payload has confirm + selected_bed_codes');
    } else {
      fail('E3', 'create payload shape wrong');
    }

    if ((eligible.would_call || []).length === 1
        && eligible.would_call[0] === 'POST /staff/bot/bookings/create') {
      pass('E4', 'would_call only bot bookings create');
    } else {
      fail('E4', 'would_call: ' + JSON.stringify(eligible.would_call));
    }

    if (eligible.creates_stripe_link === false && eligible.sends_whatsapp === false
        && eligible.calls_n8n === false) {
      pass('E5', 'bridge result safety flags false');
    } else {
      fail('E5', 'unsafe bridge result flags');
    }

    if (eligible.write_performed === true && eligible.create_outcome && eligible.create_outcome.mocked !== true) {
      // mocked response uses create_response.mocked not top level - check create_outcome
    }
    if (eligible.write_performed === true
        && eligible.create_outcome
        && eligible.create_outcome.create_response
        && eligible.create_outcome.create_response.mocked === true) {
      pass('E6', 'write_performed via mock only (no real DB)');
    } else if (eligible.write_performed === true) {
      pass('E6', 'write_performed via mock invokeCreate stub');
    } else {
      fail('E6', 'mock write path failed');
    }
  } catch (e) {
    fail('E0', 'eligible mock path threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('F. Deny matrix — invokeCreate blocked (13c.2)');

  const dryRunLib = require('./lib/luna-guest-booking-dry-run');
  const enabledEnv = { BOT_BOOKING_ENABLED: 'true' };

  async function assertDenyNoInvoke(id, label, input, ctx, assertFn) {
    let invokeCount = 0;
    try {
      const result = await bridge.runLunaGuestBookingWriteBridge(input, Object.assign({
        env: enabledEnv,
        invokeCreate: async () => {
          invokeCount++;
          return { write_performed: true };
        },
      }, ctx));
      const assertOk = typeof assertFn === 'function' ? assertFn(result) : true;
      if (invokeCount === 0 && result.write_performed === false && assertOk) {
        pass(id, label);
      } else {
        fail(id, `${label} (invoke=${invokeCount}, write=${result.write_performed})`);
      }
    } catch (e) {
      fail(id, `${label} threw: ${e.message}`);
    }
  }

  await assertDenyNoInvoke(
    'F1',
    'BOT_BOOKING_ENABLED=false → no invokeCreate',
    makeCompleteInput(),
    { pg: makeMockPg(), env: { BOT_BOOKING_ENABLED: 'false' } },
    (r) => (r.required_approvals || []).includes('BOT_BOOKING_ENABLED'),
  );

  await assertDenyNoInvoke(
    'F1b',
    'BOT_BOOKING_ENABLED missing → no invokeCreate',
    makeCompleteInput(),
    { pg: makeMockPg(), env: {} },
    (r) => (r.required_approvals || []).includes('BOT_BOOKING_ENABLED'),
  );

  await assertDenyNoInvoke(
    'F2',
    'confirm=false → no invokeCreate',
    makeCompleteInput({ confirm: false }),
    { pg: makeMockPg() },
    (r) => (r.required_approvals || []).includes('confirm_true'),
  );

  await assertDenyNoInvoke(
    'F2b',
    'confirm missing → no invokeCreate',
    makeCompleteInput({ confirm: undefined }),
    { pg: makeMockPg() },
    (r) => (r.required_approvals || []).includes('confirm_true'),
  );

  await assertDenyNoInvoke(
    'F3',
    'idempotency_key missing → no invokeCreate',
    makeCompleteInput({ idempotency_key: '' }),
    { pg: makeMockPg() },
    (r) => (r.required_approvals || []).includes('idempotency_key'),
  );

  await assertDenyNoInvoke(
    'F4',
    'payment_choice missing → no invokeCreate',
    makeCompleteInput({ payment_choice: '' }),
    { pg: makeMockPg() },
    (r) => (r.blocked_reasons || []).includes('payment_choice_missing'),
  );

  await assertDenyNoInvoke(
    'F5',
    'availability skipped (no pg) → no invokeCreate',
    makeCompleteInput(),
    { pg: null },
    (r) => (r.blocked_reasons || []).includes('availability_not_checked'),
  );

  await assertDenyNoInvoke(
    'F6',
    'insufficient beds → no invokeCreate',
    makeCompleteInput(),
    { pg: makeEmptyBedPg() },
    (r) => (r.blocked_reasons || []).includes('availability_insufficient_beds'),
  );

  await assertDenyNoInvoke(
    'F7',
    'selected_bed_codes empty → no invokeCreate',
    makeCompleteInput(),
    { pg: makeEmptyBedPg() },
    (r) => (r.blocked_reasons || []).includes('availability_selected_beds_missing'),
  );

  // F8 — unsafe dry-run flags: reload bridge so stubbed orchestrator is used
  const DRY_RUN_MOD = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
  const BRIDGE_MOD  = path.join(__dirname, 'lib', 'luna-guest-booking-write-bridge.js');
  let f8Invoke = 0;
  let f8Restore = null;
  try {
    delete require.cache[require.resolve(BRIDGE_MOD)];
    delete require.cache[require.resolve(DRY_RUN_MOD)];
    const dryRunFresh = require(DRY_RUN_MOD);
    const origDryRun = dryRunFresh.runLunaGuestBookingDryRun;
    dryRunFresh.runLunaGuestBookingDryRun = async (input, ctx) => {
      const plan = await origDryRun(input, ctx);
      return Object.assign({}, plan, { dry_run: false, creates_booking: true });
    };
    f8Restore = () => {
      dryRunFresh.runLunaGuestBookingDryRun = origDryRun;
      delete require.cache[require.resolve(BRIDGE_MOD)];
      delete require.cache[require.resolve(DRY_RUN_MOD)];
    };
    const bridgeUnsafe = require(BRIDGE_MOD);
    const unsafe = await bridgeUnsafe.runLunaGuestBookingWriteBridge(makeCompleteInput(), {
      pg: makeMockPg(),
      env: enabledEnv,
      invokeCreate: async () => {
        f8Invoke++;
        return { write_performed: true };
      },
    });
    if (f8Invoke === 0 && unsafe.write_performed === false
        && (unsafe.blocked_reasons || []).some((x) => x.startsWith('dry_run_unsafe'))) {
      pass('F8', 'unsafe dry-run flags → no invokeCreate');
    } else {
      fail('F8', `unsafe dry-run (invoke=${f8Invoke})`);
    }
  } catch (e) {
    fail('F8', 'unsafe dry-run threw: ' + e.message);
  } finally {
    if (f8Restore) f8Restore();
  }

  await assertDenyNoInvoke(
    'F9',
    'gate paused / cannot continue → no invokeCreate',
    makeCompleteInput(),
    { pg: makePausedGatePg() },
    (r) => (r.blocked_reasons || []).some((x) => x.startsWith('gate_')),
  );

  // ───────────────────────────────────────────────────────────────────────────
  section('G. Idempotency-first replay (13e)');

  const EXISTING_BOOKING = {
    booking_id: 'a1111111-1111-4111-8111-111111111111',
    booking_code: 'MB-REPLAY-TEST-001',
    guest_name: 'Bridge Guest',
    phone: '+34000000000',
    check_in: '2026-09-01',
    check_out: '2026-09-08',
    guest_count: 2,
    status: 'confirmed',
    client_slug: 'wolfhouse-somo',
  };
  const EXISTING_PAYMENT = {
    payment_id: 'b2222222-2222-4222-8222-222222222222',
    status: 'draft',
    payment_kind: 'deposit_only',
    amount_due_cents: 10000,
    checkout_url: null,
    stripe_checkout_session_id: null,
  };

  function makePgWithExistingBooking(existing, basePg) {
    const inner = basePg || makeMockPg();
    return {
      query: async (sql, params) => {
        const s = String(sql);
        if (/metadata->>'idempotency_key'/.test(s)) {
          return { rows: [existing.booking] };
        }
        if (/FROM payments p/i.test(s)) {
          return { rows: existing.payments || [] };
        }
        return inner.query(sql, params);
      },
    };
  }

  let gDryRunCalls = 0;
  let gInvokeCalls = 0;
  const origRunDryRun = dryRunLib.runLunaGuestBookingDryRun;
  dryRunLib.runLunaGuestBookingDryRun = async (input, ctx) => {
    gDryRunCalls++;
    return origRunDryRun(input, ctx);
  };

  try {
    const replayInput = makeCompleteInput({
      idempotency_key: 'phase13e-replay-existing-001',
      check_in: EXISTING_BOOKING.check_in,
      check_out: EXISTING_BOOKING.check_out,
      phone: EXISTING_BOOKING.phone,
    });
    const replay = await bridge.runLunaGuestBookingWriteBridge(replayInput, {
      pg: makePgWithExistingBooking({
        booking: EXISTING_BOOKING,
        payments: [EXISTING_PAYMENT],
      }),
      env: enabledEnv,
      invokeCreate: async () => {
        gInvokeCalls++;
        return { write_performed: true };
      },
    });

    if (replay.idempotent_replay === true) pass('G1', 'existing key returns idempotent_replay true');
    else fail('G1', 'idempotent_replay missing');

    if (gDryRunCalls === 0) pass('G2', 'replay skips runLunaGuestBookingDryRun');
    else fail('G2', `dry-run called ${gDryRunCalls} times on replay`);

    if (gInvokeCalls === 0 && replay.write_performed === false) {
      pass('G3', 'replay does not invoke create');
    } else {
      fail('G3', `invoke=${gInvokeCalls} write=${replay.write_performed}`);
    }

    if (replay.booking_id === EXISTING_BOOKING.booking_id
        && replay.booking_code === EXISTING_BOOKING.booking_code) {
      pass('G4', 'replay returns existing booking_id/code');
    } else {
      fail('G4', 'booking ids mismatch');
    }

    if (replay.creates_stripe_link === false && replay.sends_whatsapp === false
        && replay.calls_n8n === false && replay.write_performed === false) {
      pass('G5', 'replay safety flags preserved');
    } else {
      fail('G5', 'replay unsafe flags');
    }

    if (replay.payment_summary && replay.payment_summary.status === 'draft') {
      pass('G6', 'replay includes draft payment summary');
    } else {
      fail('G6', 'payment summary missing or not draft');
    }

    gDryRunCalls = 0;
    gInvokeCalls = 0;
    const conflict = await bridge.runLunaGuestBookingWriteBridge(
      makeCompleteInput({
        idempotency_key: 'phase13e-replay-existing-001',
        phone: '+39999999999',
        check_in: EXISTING_BOOKING.check_in,
        check_out: EXISTING_BOOKING.check_out,
      }),
      {
        pg: makePgWithExistingBooking({
          booking: EXISTING_BOOKING,
          payments: [EXISTING_PAYMENT],
        }),
        env: enabledEnv,
        invokeCreate: async () => {
          gInvokeCalls++;
          return { write_performed: true };
        },
      },
    );

    if (gDryRunCalls === 0 && gInvokeCalls === 0 && conflict.success === false
        && (conflict.blocked_reasons || []).includes('idempotency_phone_mismatch')) {
      pass('G7', 'idempotency conflict blocks without create');
    } else {
      fail('G7', `conflict path unexpected (dry=${gDryRunCalls} invoke=${gInvokeCalls})`);
    }
  } catch (e) {
    fail('G0', 'idempotency replay threw: ' + e.message);
  } finally {
    dryRunLib.runLunaGuestBookingDryRun = origRunDryRun;
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
