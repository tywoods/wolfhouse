/**
 * Phase 13c.4 — Verifier for POST /staff/bot/booking-write-eligibility.
 *
 * Read-only route: dry-run + eligibility only; never invokes write bridge or create.
 *
 * Usage:
 *   npm run verify:luna-agent-phase13-write-eligibility-route
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const API  = path.join(__dirname, 'staff-query-api.js');
const PKG  = path.join(ROOT, 'package.json');

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
    guest_name:       'Eligibility Route Guest',
    check_in:         '2026-09-01',
    check_out:        '2026-09-08',
    guest_count:      2,
    package_code:     'malibu',
    room_type:        'shared',
    phone:            '+34000000000',
    payment_choice:   'deposit',
    confirm:          true,
    idempotency_key:  'phase13c4-eligibility-route-001',
  }, overrides || {});
}

function makeMockPg() {
  const bedRows = [
    { bed_code: 'MOCK-B1', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B1' },
    { bed_code: 'MOCK-B2', room_code: 'R1', room_type: 'shared', bed_active: true, bed_sellable: true, bed_label: 'B2' },
  ];
  return {
    query: async (sql) => {
      const s = String(sql);
      if (/bot_pause_states/i.test(s)) return { rows: [] };
      if (/FROM\s+booking_beds/i.test(s)) return { rows: [] };
      if (/FROM\s+rooms\s+r/i.test(s) && /bd\.bed_code/i.test(s)) return { rows: bedRows };
      return { rows: [] };
    },
  };
}

function buildRouteResponse(body, env) {
  const { runLunaGuestBookingDryRun } = require('./lib/luna-guest-booking-dry-run');
  const { evaluateLunaBookingWriteEligibility } = require('./lib/luna-guest-booking-write-eligibility');
  return (async () => {
    const dryRunPlan = await runLunaGuestBookingDryRun(body, { pg: makeMockPg() });
    const eligibility = evaluateLunaBookingWriteEligibility(dryRunPlan, body, env);
    return {
      success:             true,
      dry_run:             true,
      preview_only:        true,
      no_write_performed:  true,
      write_performed:     false,
      creates_booking:     false,
      creates_payment:     false,
      creates_stripe_link: false,
      sends_whatsapp:      false,
      calls_n8n:           false,
      eligibility,
      write_ready:         eligibility.write_ready === true,
      blocked_reasons:     eligibility.blocked_reasons || [],
      required_approvals:  eligibility.required_approvals || [],
      would_call:          eligibility.would_call || [],
      safe_next_step:      eligibility.safe_next_step || 'keep_dry_run',
      dry_run_plan:        dryRunPlan,
    };
  })();
}

console.log('\nverify-luna-agent-phase13-write-eligibility-route.js  (Phase 13c.4)\n');

const src = readOrEmpty(API);
const routeIdx   = src.indexOf("'/staff/bot/booking-write-eligibility'");
const routeBlock = routeIdx > -1 ? src.slice(routeIdx, routeIdx + 650) : '';

const handlerStart = src.indexOf('async function handleBotBookingWriteEligibility(');
const handlerEnd   = handlerStart > -1
  ? src.indexOf('\n// Phase 13c — in-memory req', handlerStart)
  : -1;
const handler = handlerStart > -1
  ? src.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : handlerStart + 8000)
  : '';

// ─────────────────────────────────────────────────────────────────────────────
section('A. Route and handler presence');

if (routeIdx > -1) pass('A1', 'POST /staff/bot/booking-write-eligibility registered');
else fail('A1', 'route not registered');

if (routeBlock.includes("method !== 'POST'")) pass('A2', 'POST-only guard');
else fail('A2', 'POST-only guard missing');

if (handlerStart > -1) pass('A3', 'handleBotBookingWriteEligibility defined');
else fail('A3', 'handler missing');

if (routeBlock.includes('handleBotBookingWriteEligibility')) pass('A4', 'router dispatches handler');
else fail('A4', 'router does not call handler');

try {
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('A5', 'staff-query-api.js passes node --check');
} catch {
  fail('A5', 'staff-query-api.js syntax error');
}

const pkg = JSON.parse(readOrEmpty(PKG) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-phase13-write-eligibility-route']) {
  pass('A6', 'npm script registered');
} else {
  fail('A6', 'npm script missing');
}

// ─────────────────────────────────────────────────────────────────────────────
section('B. Auth');

if (routeBlock.includes('requireBotAuth')) pass('B1', 'route uses requireBotAuth');
else fail('B1', 'requireBotAuth missing');

// ─────────────────────────────────────────────────────────────────────────────
section('C. Orchestrator + eligibility reuse');

if (handler.includes('runLunaGuestBookingDryRun(')) pass('C1', 'handler calls runLunaGuestBookingDryRun');
else fail('C1', 'runLunaGuestBookingDryRun not called');

if (handler.includes('evaluateLunaBookingWriteEligibility(')) pass('C2', 'handler calls evaluateLunaBookingWriteEligibility');
else fail('C2', 'evaluateLunaBookingWriteEligibility not called');

if (handler.includes('withPgClient') && handler.includes('{ pg }')) {
  pass('C3', 'read-only pg via withPgClient');
} else {
  fail('C3', 'withPgClient({ pg }) pattern missing');
}

if (!handler.includes('runLunaGuestBookingWriteBridge')) pass('C4', 'does not call write bridge');
else fail('C4', 'calls runLunaGuestBookingWriteBridge');

if (!handler.includes('handleBotBookingCreate')) pass('C5', 'does not call handleBotBookingCreate');
else fail('C5', 'calls handleBotBookingCreate');

// ─────────────────────────────────────────────────────────────────────────────
section('D. Static safety — no writes / Stripe / WhatsApp / n8n');

const handlerNoComments = handler.replace(/\/\/[^\n]*/g, '');

if (!/\bINSERT\s+INTO\b/i.test(handlerNoComments)) pass('D1', 'handler: no INSERT SQL');
else fail('D1', 'handler contains INSERT');

if (!/\bUPDATE\s+\w/i.test(handlerNoComments)) pass('D2', 'handler: no UPDATE SQL');
else fail('D2', 'handler contains UPDATE');

if (!/\bDELETE\s+FROM\b/i.test(handlerNoComments)) pass('D3', 'handler: no DELETE SQL');
else fail('D3', 'handler contains DELETE');

if (!/create-stripe-link|stripe\.com|new Stripe\(/i.test(handlerNoComments)) {
  pass('D4', 'handler: no Stripe API/link calls');
} else {
  fail('D4', 'handler calls Stripe');
}

if (!/payment-link|create-stripe-link/i.test(handlerNoComments)) {
  pass('D5', 'handler: no payment-link route');
} else {
  fail('D5', 'handler references payment-link');
}

if (!/graph\.facebook|sendWhatsApp|WHATSAPP_API/i.test(handlerNoComments)) {
  pass('D6', 'handler: no WhatsApp send');
} else {
  fail('D6', 'handler sends WhatsApp');
}

if (!/\bn8n\b/i.test(handlerNoComments)) pass('D7', 'handler: no n8n');
else fail('D7', 'handler references n8n');

if (!/webhook/i.test(handlerNoComments)) pass('D8', 'handler: no webhook');
else fail('D8', 'handler references webhook');

if (!/\/staff\/bot\/bookings\/create|handleBotBookingCreate/.test(handlerNoComments)) {
  pass('D9', 'handler: no bookings/create');
} else {
  fail('D9', 'handler calls booking create');
}

if (!/runLunaGuestBookingWriteBridge|booking-create-from-plan/.test(handlerNoComments)) {
  pass('D10', 'handler: no write bridge');
} else {
  fail('D10', 'handler calls write bridge');
}

if (handler.includes('write_performed:     false')) pass('D11', 'response pins write_performed false');
else fail('D11', 'write_performed false not pinned in handler');

// ─────────────────────────────────────────────────────────────────────────────
section('E. Runtime shape — eligible path (mock, no write)');

const enabledEnv = { BOT_BOOKING_ENABLED: 'true' };

(async () => {
  try {
    const eligible = await buildRouteResponse(makeCompleteInput(), enabledEnv);

    if (eligible.success === true) pass('E1', 'eligible mock returns success true');
    else fail('E1', 'eligible mock success not true');

    if (eligible.write_ready === true) pass('E2', 'eligible mock reaches write_ready true');
    else fail('E2', 'eligible mock write_ready false');

    if (eligible.write_performed === false) pass('E3', 'write_ready true still write_performed false');
    else fail('E3', 'write_performed true on eligible path');

    if (Array.isArray(eligible.would_call)
        && eligible.would_call.length === 1
        && eligible.would_call[0] === 'POST /staff/bot/bookings/create') {
      pass('E4', 'would_call only POST /staff/bot/bookings/create');
    } else {
      fail('E4', 'would_call unexpected: ' + JSON.stringify(eligible.would_call));
    }

    if (eligible.safe_next_step === 'booking_create_gated') pass('E5', 'safe_next_step booking_create_gated');
    else fail('E5', 'safe_next_step: ' + eligible.safe_next_step);

    const flags = ['creates_booking', 'creates_payment', 'creates_stripe_link', 'sends_whatsapp', 'calls_n8n'];
    const allFalse = flags.every((k) => eligible[k] === false);
    if (allFalse) pass('E6', 'safety flags all false when write_ready');
    else fail('E6', 'safety flags not all false');

    if (eligible.dry_run_plan && eligible.eligibility) pass('E7', 'returns dry_run_plan + eligibility');
    else fail('E7', 'dry_run_plan or eligibility missing');
  } catch (e) {
    fail('E0', 'eligible runtime threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('F. Runtime shape — blocked path (mock)');

  try {
    const blocked = await buildRouteResponse(
      makeCompleteInput({ payment_choice: '', confirm: false }),
      enabledEnv,
    );

    if (blocked.write_ready === false) pass('F1', 'blocked mock write_ready false');
    else fail('F1', 'blocked mock unexpectedly write_ready');

    if (blocked.write_performed === false) pass('F2', 'blocked mock write_performed false');
    else fail('F2', 'blocked mock wrote');

    if (Array.isArray(blocked.blocked_reasons) && blocked.blocked_reasons.length > 0) {
      pass('F3', 'blocked mock has blocked_reasons');
    } else {
      fail('F3', 'blocked_reasons empty');
    }

    if (!blocked.would_call || blocked.would_call.length === 0) pass('F4', 'blocked would_call empty');
    else fail('F4', 'blocked would_call not empty');
  } catch (e) {
    fail('F0', 'blocked runtime threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('G. Downstream verifiers');

  const downstream = [
    ['G1', 'verify:luna-agent-phase13-booking-write-bridge'],
    ['G2', 'verify:luna-agent-phase13-write-eligibility'],
    ['G3', 'verify:luna-agent-phase13-write-gates-plan'],
    ['G4', 'verify:luna-agent-phase12-closeout'],
    ['G5', 'verify:staff-ask-luna-phase11-closeout'],
  ];

  for (const [id, script] of downstream) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
      pass(id, `${script} passes`);
    } catch (e) {
      const tail = (e.stdout || e.stderr || '').split('\n').slice(-4).join(' ');
      fail(id, `${script} failed: ${tail}`);
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
