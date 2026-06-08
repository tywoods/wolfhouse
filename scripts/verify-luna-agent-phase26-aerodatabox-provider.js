/**
 * Phase 26i — Verifier for AeroDataBox flight lookup provider.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-aerodatabox-provider
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROVIDER = path.join(__dirname, 'lib', 'aerodatabox-flight-lookup.js');
const ROUTES = path.join(__dirname, 'lib', 'staff-booking-transfers-routes.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26i-AERODATABOX-FLIGHT-LOOKUP.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-aerodatabox-provider';

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-aerodatabox-provider.js  (Phase 26i)\n');

try {
  execSync(`node --check "${PROVIDER}"`, { stdio: 'pipe' });
  execSync(`node --check "${ROUTES}"`, { stdio: 'pipe' });
  pass('0', 'provider + routes pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

const providerSrc = readOrEmpty(PROVIDER);
const routesSrc = readOrEmpty(ROUTES);
const apiSrc = readOrEmpty(API);
const lookupHandler = routesSrc.match(/async function handlePostBookingTransferLookupFlight[\s\S]{0,3200}/)?.[0] || '';

section('A. Module exports');

for (const fn of [
  'resolveAeroDataBoxConfig',
  'getAeroDataBoxStatus',
  'normalizeFlightNumberForLookup',
  'buildAeroDataBoxFlightUrl',
  'lookupAeroDataBoxFlight',
]) {
  if (new RegExp(`function ${fn}|${fn}\\(`).test(providerSrc)) pass(`A.${fn}`, `${fn} present`);
  else fail(`A.${fn}`, `${fn} missing`);
}

section('B. Config + status');

const {
  resolveAeroDataBoxConfig,
  getAeroDataBoxStatus,
  normalizeFlightNumberForLookup,
  buildAeroDataBoxFlightUrl,
  buildAeroDataBoxAuthHeaders,
  lookupAeroDataBoxFlight,
  hashKeyFingerprint,
} = require('./lib/aerodatabox-flight-lookup');

const cfg = resolveAeroDataBoxConfig({ AERODATABOX_API_KEY: '  test-key-26i  ' });
if (cfg.api_key === 'test-key-26i' && cfg.key_source === 'AERODATABOX_API_KEY') {
  pass('B1', 'config resolves AERODATABOX_API_KEY');
} else fail('B1', 'config resolution');

const blank = resolveAeroDataBoxConfig({ AERODATABOX_API_KEY: '   ' });
if (!blank.api_key) pass('B2', 'whitespace key treated as missing');
else fail('B2', 'whitespace key');

const status = getAeroDataBoxStatus({ AERODATABOX_API_KEY: 'secret-aero-key' });
if (status.key_present && status.configured && status.provider === 'aerodatabox'
  && status.key_source === 'AERODATABOX_API_KEY') {
  pass('B3', 'status provider aerodatabox + key_present');
} else fail('B3', 'status flags');
if (status.key_fingerprint === hashKeyFingerprint('secret-aero-key')) pass('B4', 'key_fingerprint');
else fail('B4', 'fingerprint');
if (!JSON.stringify(status).includes('secret-aero-key')) pass('B5', 'status does not expose raw key');
else fail('B5', 'raw key leak');

section('C. URL + auth');

if (normalizeFlightNumberForLookup(' fr 1234 ') === 'FR1234') pass('C1', 'normalizeFlightNumberForLookup');
else fail('C1', 'flight number normalize');

const url = buildAeroDataBoxFlightUrl({
  flight_number: 'fr1234',
  flight_date: '2029-10-01',
  direction: 'arrival',
});
if (/prod\.api\.market\/api\/v1\/aedbx\/aerodatabox/.test(url)
  && /\/flights\/number\/FR1234\/2029-10-01\//.test(url)
  && /dateLocalRole=Arrival/.test(url)) {
  pass('C2', 'buildAeroDataBoxFlightUrl flight number + date window + role');
} else fail('C2', 'URL builder');

const headers = buildAeroDataBoxAuthHeaders('mock-sub-key');
if (headers['Ocp-Apim-Subscription-Key'] === 'mock-sub-key' && !url.includes('mock-sub-key')) {
  pass('C3', 'API.Market auth header separate from URL');
} else fail('C3', 'auth header');

section('D. Lookup (mocked fetch)');

(async function runAsync() {
  const missingKey = await lookupAeroDataBoxFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    env: {},
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }),
  });
  if (missingKey.success === false && missingKey.error === 'aerodatabox_not_configured') {
    pass('D1', 'missing key → aerodatabox_not_configured');
  } else fail('D1', 'missing key');

  const mockRow = {
    number: 'FR1234',
    status: 'Expected',
    airline: { name: 'Ryanair' },
    departure: {
      airport: { name: 'Dublin', iata: 'DUB' },
      scheduledTime: { utc: '2029-10-01T08:00:00Z' },
    },
    arrival: {
      airport: { name: 'Santander', iata: 'SDR' },
      scheduledTime: { utc: '2029-10-01T10:30:00Z' },
      terminal: 'T1',
      gate: 'A2',
    },
  };

  let capturedUrl = '';
  let capturedHeaders = null;
  const okRes = await lookupAeroDataBoxFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    direction: 'arrival',
    airport_code: 'SDR',
    env: { AERODATABOX_API_KEY: 'mock-key' },
    fetchImpl: async (u, opts) => {
      capturedUrl = u;
      capturedHeaders = opts.headers;
      return { ok: true, status: 200, text: async () => JSON.stringify([mockRow]) };
    },
  });
  if (okRes.success && okRes.provider === 'aerodatabox' && okRes.best_match
    && okRes.best_match.arrival_iata === 'SDR' && okRes.raw_payload_stored === false) {
    pass('D2', 'mocked success maps sanitized best_match');
  } else fail('D2', 'success shape');
  if (/FR1234/.test(capturedUrl) && /2029-10-01/.test(capturedUrl)) pass('D3', 'fetch uses flight number + date');
  else fail('D3', 'fetch URL');
  if (capturedHeaders && capturedHeaders['Ocp-Apim-Subscription-Key'] === 'mock-key') {
    pass('D4', 'fetch uses Ocp-Apim-Subscription-Key');
  } else fail('D4', 'fetch auth header');
  if (!JSON.stringify(okRes).includes('"departure":{')) pass('D5', 'no raw nested payload in result');
  else fail('D5', 'raw payload leak');

  const twoRows = [
    mockRow,
    {
      number: 'FR1234',
      status: 'Expected',
      airline: { name: 'Ryanair' },
      departure: {
        airport: { name: 'Santander', iata: 'SDR' },
        scheduledTime: { utc: '2029-10-04T14:00:00Z' },
      },
      arrival: {
        airport: { name: 'Dublin', iata: 'DUB' },
        scheduledTime: { utc: '2029-10-04T16:00:00Z' },
      },
    },
  ];
  const depPick = await lookupAeroDataBoxFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-04',
    direction: 'departure',
    airport_code: 'SDR',
    env: { AERODATABOX_API_KEY: 'mock-key' },
    fetchImpl: async () => ({
      ok: true, status: 200, text: async () => JSON.stringify(twoRows),
    }),
  });
  if (depPick.success && depPick.best_match && depPick.best_match.departure_iata === 'SDR') {
    pass('D6', 'departure + SDR prefers departure airport');
  } else fail('D6', 'departure match');

  const empty = await lookupAeroDataBoxFlight({
    flight_number: 'FR9999',
    flight_date: '2029-10-01',
    env: { AERODATABOX_API_KEY: 'mock-key' },
    fetchImpl: async () => ({ ok: true, status: 204, text: async () => '' }),
  });
  if (empty.success === false && empty.error === 'flight_not_found') pass('D7', '204 → flight_not_found');
  else fail('D7', 'flight_not_found');

  const authErr = await lookupAeroDataBoxFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    env: { AERODATABOX_API_KEY: 'mock-key' },
    fetchImpl: async () => ({
      ok: false, status: 401, text: async () => JSON.stringify({ message: 'Unauthorized' }),
    }),
  });
  if (authErr.success === false && authErr.error === 'aerodatabox_auth_error') {
    pass('D8', '401 → aerodatabox_auth_error');
  } else fail('D8', 'auth error');

  const quotaErr = await lookupAeroDataBoxFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    env: { AERODATABOX_API_KEY: 'mock-key' },
    fetchImpl: async () => ({
      ok: false, status: 403, text: async () => JSON.stringify({ message: 'quota exceeded' }),
    }),
  });
  if (quotaErr.success === false && quotaErr.error === 'aerodatabox_quota_or_plan_error') {
    pass('D9', '403 → aerodatabox_quota_or_plan_error');
  } else fail('D9', 'quota error');

  section('E. Route wiring');

  if (/lookupAeroDataBoxFlightWithDateRetry/.test(lookupHandler)) {
    pass('E1', 'lookup route uses AeroDataBox with date retry');
  } else fail('E1', 'lookup route provider');
  if (!/lookupAviationstackFlight/.test(routesSrc)) {
    pass('E2', 'Aviationstack not active in transfer routes');
  } else fail('E2', 'Aviationstack still active');
  if (/no_transfer_write:\s*true/.test(lookupHandler) && /no_payment_write:\s*true/.test(lookupHandler)) {
    pass('E3', 'lookup route no_transfer_write + no_payment_write');
  } else fail('E3', 'write flags');
  if (!/upsertBookingTransfer/.test(lookupHandler)) pass('E4', 'lookup route does not write transfers');
  else fail('E4', 'transfer write in lookup');

  if (/\/staff\/transfers\/flight-lookup\/status/.test(apiSrc)
    && /getAeroDataBoxStatus/.test(apiSrc)) {
    pass('E5', 'status route uses getAeroDataBoxStatus');
  } else fail('E5', 'status route');
  if (/\/transfers\/lookup-flight/.test(apiSrc) && /bcLookupFlight/.test(apiSrc)) {
    pass('E6', 'UI still calls lookup-flight route');
  } else fail('E6', 'UI lookup route');

  section('F. Docs + npm');

  const doc = readOrEmpty(DOC);
  if (/aerodatabox-api-key/.test(doc) && /AERODATABOX_API_KEY/.test(doc)) pass('F1', 'doc key/env');
  else fail('F1', 'doc config');
  if (/Aviationstack|function_access_restricted/i.test(doc)) pass('F2', 'doc explains switch');
  else fail('F2', 'doc why switch');
  if (/no_transfer_write|no transfer DB write/i.test(doc)) pass('F3', 'doc no transfer write');
  else fail('F3', 'doc safety');

  const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
  if (pkg.scripts && pkg.scripts[SCRIPT]) pass('F4', 'npm script registered');
  else fail('F4', 'npm script');

  section('G. Safety');

  if (!providerSrc.match(/\bstripe\b/i) && !providerSrc.includes('INSERT INTO payments')
    && !/upsertBookingTransfer|INSERT INTO booking_transfers/.test(providerSrc)) {
    pass('G1', 'provider no Stripe/payment/DB writes');
  } else fail('G1', 'provider safety');
  if (!routesSrc.includes('guest_message') && !/n8n|meta.*webhook/i.test(lookupHandler)) {
    pass('G2', 'no WhatsApp/Meta/n8n in lookup handler');
  } else fail('G2', 'messaging safety');

  console.log(`\n── Summary ──`);
  console.log(`  PASS: ${passes}`);
  console.log(`  FAIL: ${failures}`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
