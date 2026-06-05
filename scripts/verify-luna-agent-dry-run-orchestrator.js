/**
 * Phase 12b — Verifier for Luna guest booking dry-run orchestrator.
 *
 * Usage:
 *   npm run verify:luna-agent-dry-run-orchestrator
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT      = path.join(__dirname, '..');
const LIB_FILE  = path.join(__dirname, 'lib', 'luna-guest-booking-dry-run.js');
const PKG_FILE  = path.join(ROOT, 'package.json');

let passes   = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t)    { console.log(`\n── ${t} ──`); }

function readOrEmpty(filePath) {
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; }
  catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
section('A. Module presence and syntax');

if (!fs.existsSync(LIB_FILE)) {
  fail('A1', 'luna-guest-booking-dry-run.js missing');
  process.exit(1);
}
pass('A1', 'luna-guest-booking-dry-run.js exists');

try {
  execSync(`node --check "${LIB_FILE}"`, { stdio: 'pipe' });
  pass('A2', 'orchestrator lib passes node --check');
} catch (e) {
  fail('A2', 'orchestrator lib syntax error');
}

try {
  execSync(`node --check "${__filename}"`, { stdio: 'pipe' });
  pass('A3', 'verifier passes node --check');
} catch (e) {
  fail('A3', 'verifier syntax error');
}

const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
if (pkg.scripts && pkg.scripts['verify:luna-agent-dry-run-orchestrator']) {
  pass('A4', 'package.json has verify:luna-agent-dry-run-orchestrator');
} else {
  fail('A4', 'package.json missing verify:luna-agent-dry-run-orchestrator script');
}

const libSrc = readOrEmpty(LIB_FILE);

// ─────────────────────────────────────────────────────────────────────────────
section('B. Exports and anchor route references');

let lib;
try {
  lib = require('./lib/luna-guest-booking-dry-run');
  pass('B1', 'orchestrator module loads');
} catch (e) {
  fail('B1', 'orchestrator module failed to load: ' + e.message);
  process.exit(1);
}

if (typeof lib.runLunaGuestBookingDryRun === 'function') {
  pass('B2', 'exports runLunaGuestBookingDryRun');
} else {
  fail('B2', 'runLunaGuestBookingDryRun not exported');
}

if (lib.DRY_RUN_ANCHOR_ROUTES && lib.DRY_RUN_ANCHOR_ROUTES.gate) {
  pass('B3', 'DRY_RUN_ANCHOR_ROUTES.gate defined');
} else {
  fail('B3', 'gate anchor route missing');
}

if (lib.DRY_RUN_ANCHOR_ROUTES.booking_preview.includes('booking-preview')) {
  pass('B4', 'booking preview anchor route referenced');
} else {
  fail('B4', 'booking preview anchor missing');
}

if (lib.DRY_RUN_ANCHOR_ROUTES.availability.includes('availability-check')) {
  pass('B5', 'availability anchor route referenced');
} else {
  fail('B5', 'availability anchor missing');
}

if (lib.DRY_RUN_ANCHOR_ROUTES.addon_preview.includes('addon-request-preview')) {
  pass('B6', 'add-on preview anchor route referenced');
} else {
  fail('B6', 'add-on preview anchor missing');
}

if (libSrc.includes('calculateWolfhouseQuote')) {
  pass('B7', 'reuses calculateWolfhouseQuote (booking-preview engine)');
} else {
  fail('B7', 'calculateWolfhouseQuote not referenced');
}

if (libSrc.includes('getPauseState')) {
  pass('B8', 'reuses getPauseState (guest automation gate)');
} else {
  fail('B8', 'getPauseState not referenced');
}

if (libSrc.includes('getBedCalendarRoomsQuery') && libSrc.includes('getBedCalendarBlocksQuery')) {
  pass('B9', 'reuses bed calendar queries (availability-check)');
} else {
  fail('B9', 'bed calendar queries not referenced');
}

// ─────────────────────────────────────────────────────────────────────────────
section('C. Static safety scan (no live side effects)');

const stripped = libSrc
  .replace(/\/\/[^\n]*/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '');

if (!/\bINSERT\s+INTO\b/i.test(stripped)) pass('C1', 'no INSERT SQL');
else fail('C1', 'INSERT SQL found');

if (!/\bUPDATE\s+\w/i.test(stripped)) pass('C2', 'no UPDATE SQL');
else fail('C2', 'UPDATE SQL found');

if (!/\bDELETE\s+FROM\b/i.test(stripped)) pass('C3', 'no DELETE SQL');
else fail('C3', 'DELETE SQL found');

if (!/api\.stripe\.com|checkout\.sessions\.create|require\s*\(\s*['"]stripe['"]/.test(libSrc)) {
  pass('C4', 'no Stripe checkout/payment-link creation');
} else {
  fail('C4', 'Stripe call pattern found');
}

if (!/graph\.facebook\.com|twilio\.com/i.test(libSrc)) {
  pass('C5', 'no WhatsApp send calls');
} else {
  fail('C5', 'WhatsApp send pattern found');
}

const libCodeOnly = libSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

if (!/require\s*\(\s*['"]n8n|n8n\.io|fetch\s*\([^)]*n8n|CallMcpTool|n8n-nodes/i.test(libCodeOnly)) {
  pass('C6', 'no n8n activation/calls');
} else {
  fail('C6', 'n8n activation pattern found');
}

if (!/handleStripeWebhook|stripe\.webhooks|constructEvent/.test(libCodeOnly)) {
  pass('C7', 'no webhook invocation');
} else {
  fail('C7', 'webhook invocation found');
}

if (!/require\s*\(\s*['"]\.\.\/staff-query-api['"]|require\s*\(\s*['"]\.\/staff-query-api['"]/.test(libSrc)) {
  pass('C8', 'does not import staff-query-api (no live route dispatch)');
} else {
  fail('C8', 'imports staff-query-api');
}

if (libSrc.includes('FORBIDDEN_CONTEXT_KEYS') && libSrc.includes('assertDryRunContext')) {
  pass('C9', 'live route delegation guard present');
} else {
  fail('C9', 'live route guard missing');
}

if (!/deploy|migration|ALTER\s+TABLE/i.test(libSrc)) {
  pass('C10', 'no migrations/deploy code');
} else {
  fail('C10', 'migration/deploy pattern found');
}

// ─────────────────────────────────────────────────────────────────────────────
section('D. Runtime dry-run smoke (no DB)');

(async () => {
  try {
    const out = await lib.runLunaGuestBookingDryRun({
      client_slug:  'wolfhouse-somo',
      guest_name:   'Dry Run Guest',
      check_in:     '2026-09-01',
      check_out:    '2026-09-08',
      guest_count:  2,
      package_code: 'malibu',
      room_type:    'shared',
      phone:        '+34000000000',
      payment_choice: 'deposit',
      language:     'en',
    }, {});

    if (out.dry_run === true) pass('D1', 'output dry_run: true');
    else fail('D1', 'dry_run not true');

    if (out.creates_booking === false) pass('D2', 'creates_booking: false');
    else fail('D2', 'creates_booking not false');

    if (out.creates_payment === false) pass('D3', 'creates_payment: false');
    else fail('D3', 'creates_payment not false');

    if (out.creates_stripe_link === false) pass('D4', 'creates_stripe_link: false');
    else fail('D4', 'creates_stripe_link not false');

    if (out.sends_whatsapp === false) pass('D5', 'sends_whatsapp: false');
    else fail('D5', 'sends_whatsapp not false');

    if (out.calls_n8n === false) pass('D6', 'calls_n8n: false');
    else fail('D6', 'calls_n8n not false');

    if (Array.isArray(out.planned_actions) && out.planned_actions.length > 0) {
      pass('D7', 'planned_actions returned (' + out.planned_actions.length + ')');
    } else {
      fail('D7', 'planned_actions missing or empty');
    }

    if (out.booking_preview && out.booking_preview.quote && out.booking_preview.quote.success) {
      pass('D8', 'booking preview quote succeeded');
    } else {
      fail('D8', 'booking preview quote missing or failed');
    }

    if (out.gate && out.gate.can_continue_guest_automation === true) {
      pass('D9', 'gate present (default_active without pg)');
    } else {
      fail('D9', 'gate missing or blocked unexpectedly');
    }

    if (typeof out.reply_draft === 'string' && out.reply_draft.length > 0) {
      pass('D10', 'reply_draft present');
    } else {
      fail('D10', 'reply_draft missing');
    }

    if (out.next_action) pass('D11', 'next_action: ' + out.next_action);
    else fail('D11', 'next_action missing');
  } catch (e) {
    fail('D0', 'runtime smoke threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('E. Add-on preview path when add-ons present');

  try {
    const addonOut = await lib.runLunaGuestBookingDryRun({
      client_slug: 'wolfhouse-somo',
      addon_request: {
        booking_code: 'WH-TEST',
        service_type: 'yoga',
        service_date: '2026-09-03',
        quantity: 1,
      },
    }, {});

    if (addonOut.addon_preview && addonOut.addon_preview.service_type === 'yoga') {
      pass('E1', 'addon_preview populated for addon_request');
    } else {
      fail('E1', 'addon_preview missing for addon_request');
    }

    if (addonOut.addon_preview.anchor_route && addonOut.addon_preview.anchor_route.includes('addon-request-preview')) {
      pass('E2', 'addon_preview references addon-request-preview anchor');
    } else {
      fail('E2', 'addon anchor route missing on addon_preview');
    }
  } catch (e) {
    fail('E0', 'addon smoke threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('F. Forbidden context delegation guard');

  try {
    let threw = false;
    try {
      await lib.runLunaGuestBookingDryRun({}, { createBooking: () => {} });
    } catch (err) {
      threw = /forbids context\.createBooking/.test(err.message);
    }
    if (threw) pass('F1', 'rejects forbidden context.createBooking');
    else fail('F1', 'did not reject context.createBooking');
  } catch (e) {
    fail('F0', 'forbidden context test threw: ' + e.message);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section('G. Missing-fields smoke');

  try {
    const sparse = await lib.runLunaGuestBookingDryRun({ client_slug: 'wolfhouse-somo' }, {});
    if (sparse.planned_actions.includes('ask_missing_details')) {
      pass('G1', 'sparse input plans ask_missing_details');
    } else {
      fail('G1', 'sparse input did not plan ask_missing_details');
    }
    if (sparse.next_action === 'ask_missing_details') {
      pass('G2', 'sparse next_action ask_missing_details');
    } else {
      fail('G2', 'sparse next_action unexpected: ' + sparse.next_action);
    }
  } catch (e) {
    fail('G0', 'sparse smoke threw: ' + e.message);
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
