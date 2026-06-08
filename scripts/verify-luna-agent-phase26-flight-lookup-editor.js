/**
 * Phase 26f — Verifier for Staff Portal flight lookup autofill.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-flight-lookup-editor
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const PROVIDER = path.join(__dirname, 'lib', 'aviationstack-flight-lookup.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26f-FLIGHT-LOOKUP-EDITOR.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-flight-lookup-editor';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
  'verify:luna-agent-phase26-aerodatabox-provider',
  'verify:luna-agent-phase26-transfer-editor',
  'verify:luna-agent-phase26-transfer-calendar-pebble',
  'verify:luna-agent-phase26-transfer-foundation',
];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-flight-lookup-editor.js  (Phase 26f)\n');

try {
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'routes + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. Lookup-flight API route');

const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);

if (/handlePostBookingTransferLookupFlight/.test(routesSrc)) pass('A1', 'lookup-flight handler exists');
else fail('A1', 'handler missing');
if (/BOOKING_TRANSFER_LOOKUP_RE/.test(routesSrc) && /lookup-flight/.test(routesSrc)) {
  pass('A2', 'lookup-flight route regex');
} else fail('A2', 'route regex');
if (/lookupAeroDataBoxFlight/.test(routesSrc)) pass('A3', 'imports lookupAeroDataBoxFlight');
else fail('A3', 'provider import missing');

const lookupHandler = (routesSrc.match(/async function handlePostBookingTransferLookupFlight[\s\S]*?(?=async function dispatchBookingTransferLookupRoute)/) || [''])[0];
if (lookupHandler && !/upsertBookingTransfer/.test(lookupHandler)) {
  pass('A4', 'lookup route does not call upsertBookingTransfer');
} else fail('A4', 'lookup route writes transfers');
if (/no_transfer_write:\s*true/.test(lookupHandler)) pass('A5', 'returns no_transfer_write true');
else fail('A5', 'no_transfer_write flag');
if (/missing_flight_number/.test(lookupHandler) && /defaultTransferLookupDate/.test(lookupHandler)) {
  pass('A6', 'validates flight_number; defaults lookup_date from booking');
} else fail('A6', 'validation/default missing');
if (/lookupAeroDataBoxFlightWithDateRetry/.test(routesSrc)) pass('A8', 'lookup uses date retry helper');
else fail('A8', 'date retry helper missing');
if (/diagnostic:/.test(lookupHandler) && /lookup_dates_tried/.test(lookupHandler)) {
  pass('A9', 'lookup failure returns diagnostic + lookup_dates_tried');
} else fail('A9', 'lookup diagnostic payload');

if (/dispatchBookingTransferLookupRoute/.test(routesSrc) && /BOOKING_TRANSFER_LOOKUP_RE/.test(apiSrc)) {
  pass('A7', 'staff-query-api wires lookup route before GET-only gate');
} else fail('A7', 'API wiring');

section('B. Suggested patch mapping (unit)');

const {
  buildSuggestedTransferPatch,
  sanitizeFlightLookupSummaryForStorage,
} = require('./lib/staff-booking-transfers-routes');

const arrivalPatch = buildSuggestedTransferPatch({
  clientSlug: 'wolfhouse-somo',
  direction: 'arrival',
  timezone: 'Europe/Madrid',
  requestedAirport: 'SDR',
  lookupResult: {
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    best_match: {
      flight_iata: 'FR1234',
      airline_name: 'Ryanair',
      flight_status: 'scheduled',
      arrival_iata: 'SDR',
      arrival_airport: 'Santander',
      arrival_estimated: '2029-10-01T16:25:00+00:00',
      arrival_scheduled: '2029-10-01T16:20:00+00:00',
      departure_iata: 'DUB',
    },
  },
});
if (arrivalPatch && arrivalPatch.airport_code === 'SDR' && arrivalPatch.scheduled_at) {
  pass('B1', 'arrival maps arrival_iata + estimated/scheduled');
} else fail('B1', 'arrival mapping');
if (arrivalPatch.flight_lookup_provider === 'aerodatabox' && arrivalPatch.flight_lookup_summary) {
  pass('B2', 'arrival includes sanitized flight_lookup_summary');
} else fail('B2', 'arrival summary');

const depPatch = buildSuggestedTransferPatch({
  clientSlug: 'wolfhouse-somo',
  direction: 'departure',
  timezone: 'Europe/Madrid',
  requestedAirport: 'SDR',
  lookupResult: {
    flight_number: 'FR5678',
    flight_date: '2029-10-04',
    best_match: {
      flight_iata: 'FR5678',
      flight_status: 'scheduled',
      departure_iata: 'SDR',
      departure_airport: 'Santander',
      departure_scheduled: '2029-10-04T10:00:00+00:00',
      arrival_iata: 'DUB',
    },
  },
});
if (depPatch && depPatch.airport_code === 'SDR' && depPatch.scheduled_at) {
  pass('B3', 'departure maps departure_iata + scheduled');
} else fail('B3', 'departure mapping');

const unknownAirport = buildSuggestedTransferPatch({
  clientSlug: 'wolfhouse-somo',
  direction: 'arrival',
  timezone: 'Europe/Madrid',
  lookupResult: {
    flight_number: 'XX999',
    flight_date: '2029-10-01',
    best_match: {
      flight_iata: 'XX999',
      flight_status: 'scheduled',
      arrival_iata: 'XXX',
      arrival_scheduled: '2029-10-01T12:00:00+00:00',
    },
  },
});
if (unknownAirport && unknownAirport.airport_code === 'XXX') pass('B4', 'unknown airport does not crash');
else fail('B4', 'unknown airport');

const sanitized = sanitizeFlightLookupSummaryForStorage({
  flight_iata: 'FR1',
  raw_payload: { secret: 'nope' },
  departure: { nested: true },
});
if (sanitized && sanitized.flight_iata === 'FR1' && !sanitized.raw_payload && !sanitized.departure) {
  pass('B5', 'sanitizeFlightLookupSummaryForStorage strips raw/extra keys');
} else fail('B5', 'summary sanitize');

section('C. Save route flight_lookup fields');

const postHandler = (routesSrc.match(/async function handlePostBookingTransfer[\s\S]*?(?=async function handlePostBookingTransferLookupFlight)/) || [''])[0];
if (/flight_lookup_provider/.test(postHandler) && /flight_lookup_summary/.test(postHandler)) {
  pass('C1', 'POST transfer accepts flight_lookup fields');
} else fail('C1', 'POST flight_lookup');
if (/sanitizeFlightLookupSummaryForStorage/.test(postHandler)) pass('C2', 'POST sanitizes summary on save');
else fail('C2', 'POST sanitize');
if (!/INSERT INTO payments|payment_intent/.test(postHandler)) pass('C3', 'POST has no payment writes');
else fail('C3', 'payment writes');

section('D. UI');

if (/Lookup flight/.test(apiSrc) && /bc-transfer-lookup/.test(apiSrc)) pass('D1', 'Lookup flight button in UI');
else fail('D1', 'button missing');
if (/\/transfers\/lookup-flight/.test(apiSrc) && /bcLookupFlight/.test(apiSrc)) {
  pass('D2', 'UI calls lookup-flight route');
} else fail('D2', 'UI route call');
if (/bcTransferApplyLookupPatch/.test(apiSrc) && /scheduled_at_local/.test(apiSrc)) {
  pass('D3', 'UI autofills airport/scheduled from suggested_transfer_patch');
} else fail('D3', 'autofill');
const lookupFnBody = apiSrc.match(/function bcLookupFlight\(direction\)[\s\S]{0,1800}/)?.[0] || '';
if (/bcLookupFlight/.test(apiSrc) && lookupFnBody && !/lookup_date:/.test(lookupFnBody)) {
  pass('D6', 'UI lookup POST omits lookup_date');
} else fail('D6', 'UI still sends lookup_date');
if (/Couldn\\u2019t find that flight|Enter the flight details manually/.test(apiSrc)) {
  pass('D7', 'UI shows safe manual-entry message on lookup failure');
} else fail('D7', 'safe lookup error message missing');
if (/bcTransferCollectPayload/.test(apiSrc) && /flight_lookup_summary/.test(apiSrc) && /bc-transfer-save/.test(apiSrc)) {
  pass('D4', 'save still uses existing transfer POST with lookup metadata');
} else fail('D4', 'save wiring');
if (!/Flight lookup coming next/.test(apiSrc)) pass('D5', 'placeholder replaced');
else fail('D5', 'old placeholder remains');

section('E. Mocked lookup route behavior');

(async function runAsync() {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: [{
        flight_status: 'scheduled',
        flight: { iata: 'IB1234' },
        airline: { name: 'Iberia' },
        departure: { iata: 'MAD', scheduled: '2029-10-01T14:00:00+00:00' },
        arrival: { iata: 'SDR', scheduled: '2029-10-01T15:30:00+00:00' },
      }],
    }),
  });

  process.env.AERODATABOX_API_KEY = 'mock-key-26f';

  const { lookupAeroDataBoxFlight } = require('./lib/aerodatabox-flight-lookup');
  const ok = await lookupAeroDataBoxFlight({
    flight_number: 'ib1234',
    flight_date: '2029-10-01',
    direction: 'arrival',
    airport_code: 'SDR',
    env: process.env,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify([{
        number: 'IB1234',
        status: 'Expected',
        airline: { name: 'Iberia' },
        departure: {
          airport: { name: 'Madrid', iata: 'MAD' },
          scheduledTime: { utc: '2029-10-01T14:00:00Z' },
        },
        arrival: {
          airport: { name: 'Santander', iata: 'SDR' },
          scheduledTime: { utc: '2029-10-01T15:30:00Z' },
        },
      }]),
    }),
  });
  if (ok.success && ok.raw_payload_stored === false) pass('E1', 'mocked provider returns sanitized result');
  else fail('E1', 'mocked lookup');

  const bad = await lookupAeroDataBoxFlight({
    flight_number: 'ZZ999',
    flight_date: '2029-10-01',
    env: process.env,
    fetchImpl: async () => ({ ok: true, status: 204, text: async () => '' }),
  });
  if (bad.success === false && bad.error === 'flight_not_found') pass('E2', 'no result returns flight_not_found');
  else fail('E2', 'flight_not_found');

  delete process.env.AERODATABOX_API_KEY;
  global.fetch = originalFetch;

  section('F. Docs + npm');

  const doc = readOrEmpty(DOC);
  const doc261 = readOrEmpty(path.join(ROOT, 'docs', 'PHASE-26f-1-TRANSFER-UI-CLEANUP.md'));
  if ((/lookup-flight/.test(doc) || /lookup-flight/.test(doc261))
    && (/check-in|check-out|booking date/i.test(doc) || /check-in|check-out/i.test(doc261))) {
    pass('F1', 'doc route + booking-date lookup default');
  } else fail('F1', 'doc route/dates');
  if (/no.*DB write|no_transfer_write|does not write/i.test(doc)) pass('F2', 'doc no lookup write');
  else fail('F2', 'doc write safety');
  if (/Lookup flight|autofill/i.test(doc)) pass('F3', 'doc UI autofill');
  else fail('F3', 'doc UI');

  const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
  if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F4', 'npm script registered');
  else fail('F4', 'npm script');

  section('G. Safety');

  if (!routesSrc.match(/\bstripe\b/i) && !routesSrc.includes('guest_message_sends')) {
    pass('G1', 'routes have no Stripe/WhatsApp writes');
  } else fail('G1', 'Stripe/WhatsApp in routes');
  if (!lookupHandler.includes('INSERT INTO booking_transfers')) pass('G2', 'lookup route no DB insert');
  else fail('G2', 'DB insert in lookup');

  for (const f of GUEST_UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (!/lookup-flight|bcLookupFlight/.test(src)) pass(`G.${base}`, `${base} unchanged`);
    else fail(`G.${base}`, `${base} touched`);
  }

  section('H. Downstream verifiers');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 180000 });
      pass('H.' + script, `${script} still passes`);
    } catch {
      fail('H.' + script, `${script} failed`);
    }
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
