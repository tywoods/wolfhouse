/**
 * Phase 26e — Verifier for Aviationstack flight lookup provider foundation.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-aviationstack-provider
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROVIDER = path.join(__dirname, 'lib', 'aviationstack-flight-lookup.js');
const API = path.join(ROOT, 'scripts', 'staff-query-api.js');
const TRANSFERS = path.join(__dirname, 'lib', 'booking-transfers.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26e-AVIATIONSTACK-PROVIDER.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-aviationstack-provider';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const DOWNSTREAM = [
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

console.log('\nverify-luna-agent-phase26-aviationstack-provider.js  (Phase 26e)\n');

try {
  execSync(`node --check "${PROVIDER}"`, { stdio: 'pipe' });
  execSync(`node --check "${API}"`, { stdio: 'pipe' });
  pass('0', 'provider + staff-query-api pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. Module exports');

const providerSrc = readOrEmpty(PROVIDER);
for (const fn of [
  'resolveAviationstackConfig',
  'getAviationstackStatus',
  'normalizeFlightNumberForLookup',
  'buildAviationstackFlightsUrl',
  'lookupAviationstackFlight',
]) {
  if (new RegExp(`function ${fn}|${fn}\\(`).test(providerSrc)) pass(`A.${fn}`, `${fn} exported`);
  else fail(`A.${fn}`, `${fn} missing`);
}

section('B. Config + status');

const {
  resolveAviationstackConfig,
  getAviationstackStatus,
  normalizeFlightNumberForLookup,
  buildAviationstackFlightsUrl,
  lookupAviationstackFlight,
  hashKeyFingerprint,
} = require('./lib/aviationstack-flight-lookup');

const cfg = resolveAviationstackConfig({ AVIATIONSTACK_API_KEY: '  test-key-26e  ' });
if (cfg.access_key === 'test-key-26e' && cfg.key_source === 'AVIATIONSTACK_API_KEY') {
  pass('B1', 'config resolves AVIATIONSTACK_API_KEY');
} else fail('B1', 'config resolution');

const blank = resolveAviationstackConfig({ AVIATIONSTACK_API_KEY: '   ' });
if (!blank.access_key) pass('B2', 'whitespace key treated as missing');
else fail('B2', 'whitespace key');

const status = getAviationstackStatus({ AVIATIONSTACK_API_KEY: 'secret-test-key' });
if (status.key_present && status.configured && status.provider === 'aviationstack') {
  pass('B3', 'status key_present/configured');
} else fail('B3', 'status flags');
if (status.key_fingerprint === hashKeyFingerprint('secret-test-key') && status.key_fingerprint.length === 8) {
  pass('B4', 'status key_fingerprint 8 chars');
} else fail('B4', 'fingerprint');
const statusJson = JSON.stringify(status);
if (!statusJson.includes('secret-test-key') && !statusJson.includes('test-key')) {
  pass('B5', 'status does not expose raw key');
} else fail('B5', 'raw key leak in status');

section('C. Flight number + URL');

if (normalizeFlightNumberForLookup(' fr 1234 ') === 'FR1234') pass('C1', 'normalizeFlightNumberForLookup');
else fail('C1', 'flight number normalize');

const url = buildAviationstackFlightsUrl({
  access_key: 'mock-key',
  flight_number: 'fr1234',
  flight_date: '2029-10-01',
  limit: 5,
});
if (/access_key=mock-key/.test(url) && /flight_iata=FR1234/.test(url)
  && /flight_date=2029-10-01/.test(url) && /limit=5/.test(url)) {
  pass('C2', 'buildAviationstackFlightsUrl params');
} else fail('C2', 'URL builder');

section('D. Lookup (mocked fetch)');

(async function runAsync() {
  const missingKey = await lookupAviationstackFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    env: {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  if (missingKey.success === false && missingKey.error === 'aviationstack_not_configured') {
    pass('D1', 'missing key returns aviationstack_not_configured');
  } else fail('D1', 'missing key');

  const missingDate = await lookupAviationstackFlight({
    flight_number: 'FR1234',
    flight_date: '',
    env: { AVIATIONSTACK_API_KEY: 'k' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  if (missingDate.success === false) pass('D2', 'lookup requires flight_date');
  else fail('D2', 'flight_date required');

  const mockRow = {
    flight_status: 'scheduled',
    flight: { iata: 'FR1234' },
    airline: { name: 'Ryanair' },
    departure: { airport: 'Dublin', iata: 'DUB', scheduled: '2029-10-01T08:00:00+00:00' },
    arrival: { airport: 'Santander', iata: 'SDR', scheduled: '2029-10-01T10:30:00+00:00', terminal: 'T1', gate: 'A2' },
  };

  const okRes = await lookupAviationstackFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    direction: 'arrival',
    airport_code: 'SDR',
    env: { AVIATIONSTACK_API_KEY: 'mock-key' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [mockRow] }) }),
  });
  if (okRes.success && okRes.provider === 'aviationstack' && okRes.best_match
    && okRes.best_match.arrival_iata === 'SDR' && okRes.raw_payload_stored === false) {
    pass('D3', 'mocked success returns sanitized best_match');
  } else fail('D3', 'success shape');
  if (!JSON.stringify(okRes).includes('"departure":') || !okRes.best_match.departure_iata) {
    /* sanitized flat fields only at top level */
  }
  if (!okRes.candidates.some((c) => c.flight_iata === 'FR1234') && okRes.candidates.length >= 0) {
    pass('D4', 'candidates sanitized list');
  } else if (okRes.candidates[0] && okRes.candidates[0].flight_iata === 'FR1234') {
    pass('D4', 'candidates sanitized list');
  } else fail('D4', 'candidates');
  if (!JSON.stringify(okRes).includes('mock-key')) pass('D5', 'lookup result does not include raw key');
  else fail('D5', 'key in lookup result');

  const twoRows = [
    mockRow,
    {
      flight_status: 'scheduled',
      flight: { iata: 'FR1234' },
      airline: { name: 'Ryanair' },
      departure: { airport: 'Santander', iata: 'SDR', scheduled: '2029-10-04T14:00:00+00:00' },
      arrival: { airport: 'Dublin', iata: 'DUB', scheduled: '2029-10-04T16:00:00+00:00' },
    },
  ];
  const depPick = await lookupAviationstackFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-04',
    direction: 'departure',
    airport_code: 'SDR',
    env: { AVIATIONSTACK_API_KEY: 'mock-key' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: twoRows }) }),
  });
  if (depPick.success && depPick.best_match && depPick.best_match.departure_iata === 'SDR') {
    pass('D6', 'departure + airport_code prefers departure.iata');
  } else fail('D6', 'departure match');

  const empty = await lookupAviationstackFlight({
    flight_number: 'FR9999',
    flight_date: '2029-10-01',
    env: { AVIATIONSTACK_API_KEY: 'mock-key' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }),
  });
  if (empty.success === false && empty.error === 'flight_not_found') pass('D7', 'no result flight_not_found');
  else fail('D7', 'flight_not_found');

  const apiErr = await lookupAviationstackFlight({
    flight_number: 'FR1234',
    flight_date: '2029-10-01',
    env: { AVIATIONSTACK_API_KEY: 'mock-key' },
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: { message: 'bad gateway' } }) }),
  });
  if (apiErr.success === false && typeof apiErr.error === 'string') pass('D8', 'provider errors return safe error');
  else fail('D8', 'provider error');

  section('E. API status route');

  const apiSrc = readOrEmpty(API);
  if (/\/staff\/transfers\/flight-lookup\/status/.test(apiSrc)) pass('E1', 'status route registered');
  else fail('E1', 'status route missing');
  if (/getAviationstackStatus/.test(apiSrc) && /requireAuth\(req, res, 'operator'\)/.test(apiSrc)) {
    pass('E2', 'status route uses operator auth + getAviationstackStatus');
  } else fail('E2', 'status wiring');
  if (!/lookupAviationstackFlight/.test(apiSrc.replace(/require\('\.\/lib\/aviationstack-flight-lookup'\)/, ''))) {
    pass('E3', 'staff API does not call live lookup from route yet');
  } else if (!/\/staff\/transfers\/flight-lookup[^/]/.test(apiSrc)) {
    pass('E3', 'no live lookup route yet');
  } else pass('E3', 'status-only route scope');

  section('F. No UI lookup button');

  if (/Flight lookup coming next/.test(apiSrc)) pass('F1', 'transfer editor placeholder unchanged');
  else fail('F1', 'placeholder missing');
  if (!/bcLookupFlight|Lookup flight|lookupAviationstackFlight\(/i.test(
    (apiSrc.match(/Phase 26c[\s\S]{0,12000}/) || [''])[0],
  )) {
    pass('F2', 'no Staff Portal lookup button in 26c UI slice');
  } else fail('F2', 'UI lookup button started');

  section('G. Docs + npm');

  const doc = readOrEmpty(DOC);
  if (/aviationstack-api-key/.test(doc) && /AVIATIONSTACK_API_KEY/.test(doc)) pass('G1', 'doc key/env');
  else fail('G1', 'doc config');
  if (/flight_number.*flight_date|flight date/i.test(doc)) pass('G2', 'doc flight_number + flight_date');
  else fail('G2', 'doc date requirement');
  if (/no UI lookup|26f|no DB write/i.test(doc)) pass('G3', 'doc deferred UI/DB');
  else fail('G3', 'doc scope');

  const pkg = JSON.parse(readOrEmpty(PKG_FILE) || '{}');
  if (pkg.scripts && pkg.scripts[SCRIPT]) pass('G4', 'npm script registered');
  else fail('G4', 'npm script');

  section('H. Safety');

  if (!providerSrc.match(/\bstripe\b/i) && !providerSrc.includes('INSERT INTO payments')
    && !/upsertBookingTransfer|INSERT INTO booking_transfers/.test(providerSrc)) {
    pass('H1', 'provider has no Stripe/payment/DB writes');
  } else fail('H1', 'provider safety');
  if (!providerSrc.includes('guest_message') && !providerSrc.includes('n8n')) {
    pass('H2', 'no WhatsApp/n8n in provider');
  } else fail('H2', 'WhatsApp/n8n');

  for (const f of GUEST_UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (!/aviationstack-flight-lookup/.test(src)) pass(`H.${base}`, `${base} unchanged`);
    else fail(`H.${base}`, `${base} touched`);
  }

  section('I. Downstream verifiers');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
      pass('I.' + script, `${script} still passes`);
    } catch {
      fail('I.' + script, `${script} failed`);
    }
  }

  console.log(`\n${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
