/**
 * Phase 13c — Verifier for Luna gated booking write bridge.
 *
 * No successful DB writes — uses mocks/stubs for eligible path.
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

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
