/**
 * Phase 26b — Verifier for booking_transfers foundation.
 *
 * Usage:
 *   npm run verify:luna-agent-phase26-transfer-foundation
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '017_booking_transfers.sql');
const CONFIG = path.join(__dirname, 'lib', 'client-transfer-config.js');
const HELPER = path.join(__dirname, 'lib', 'booking-transfers.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-26b-TRANSFER-FOUNDATION.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase26-transfer-foundation';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const GUEST_WEBHOOK = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
  path.join(ROOT, 'scripts', 'luna-meta-whatsapp-webhook.js'),
].find((p) => fs.existsSync(p));

const DOWNSTREAM = ['verify:luna-agent-phase26-transfer-design'];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase26-transfer-foundation.js  (Phase 26b)\n');

try {
  execSync(`node --check "${CONFIG}"`, { stdio: 'pipe' });
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  pass('0', 'config + helper pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. Migration');

const mig = readOrEmpty(MIGRATION);
if (mig.includes('booking_transfers')) pass('A1', 'migration creates booking_transfers');
else fail('A1', 'booking_transfers table missing');
if (/UNIQUE \(booking_id, direction\)/i.test(mig)) pass('A2', 'unique(booking_id, direction)');
else fail('A2', 'unique constraint missing');
if (/direction IN \('arrival', 'departure'\)/i.test(mig)) pass('A3', 'direction check');
else fail('A3', 'direction check missing');
if (/status IN \('requested', 'confirmed', 'cancelled', 'not_needed'\)/i.test(mig)) {
  pass('A4', 'status check');
} else fail('A4', 'status check missing');
if (/source IN \('staff', 'luna', 'owner', 'import', 'flight_lookup'\)/i.test(mig)) {
  pass('A5', 'source check');
} else fail('A5', 'source check missing');
if (/idx_booking_transfers_client_booking/i.test(mig)) pass('A6', 'index client_slug + booking_id');
else fail('A6', 'client booking index missing');
if (/idx_booking_transfers_client_lookup_date/i.test(mig)) pass('A7', 'index client_slug + lookup_date');
else fail('A7', 'lookup_date index missing');
if (/idx_booking_transfers_client_scheduled_at/i.test(mig)) pass('A8', 'index client_slug + scheduled_at');
else fail('A8', 'scheduled_at index missing');
if (/idx_booking_transfers_client_airport/i.test(mig)) pass('A9', 'index client_slug + airport_code');
else fail('A9', 'airport index missing');
if (/idx_booking_transfers_client_status/i.test(mig)) pass('A10', 'index client_slug + status');
else fail('A10', 'status index missing');
if (/flight_lookup_summary/i.test(mig) && !/flight_lookup_payload/i.test(mig)) {
  pass('A11', 'sanitized flight_lookup_summary only (no raw payload column)');
} else fail('A11', 'raw flight_lookup_payload present or summary missing');
if (/client_slug/i.test(mig) && !/wolfhouse-somo/i.test(mig)) {
  pass('A12', 'migration is generic (no Wolfhouse hard-code)');
} else if (/wolfhouse-somo/i.test(mig)) {
  fail('A12', 'migration hard-codes Wolfhouse');
} else {
  fail('A12', 'client_slug missing');
}

section('B. Config module');

const configSrc = readOrEmpty(CONFIG);
const requiredExports = [
  'getClientTransferConfig',
  'getClientAirports',
  'getClientAirportOption',
  'normalizeAirportCode',
  'getTransferRules',
];
for (const exp of requiredExports) {
  if (configSrc.includes(`function ${exp}`) || configSrc.includes(`${exp}(`)) {
    pass('B.' + exp, `${exp} exported`);
  } else fail('B.' + exp, `${exp} missing`);
}

const {
  getClientTransferConfig,
  getClientAirports,
  normalizeAirportCode,
} = require('./lib/client-transfer-config');

const airports = getClientAirports('wolfhouse-somo');
if (airports.some((a) => a.code === 'SDR') && airports.some((a) => a.code === 'BIO')) {
  pass('B.wh-airports', 'Wolfhouse SDR and BIO airports');
} else fail('B.wh-airports', 'Wolfhouse airports missing');

const unknown = getClientTransferConfig('future-surf-camp');
if (unknown.airports.length === 0 && unknown.rules.length === 0) {
  pass('B.unknown', 'unknown client returns empty config');
} else fail('B.unknown', 'unknown client not empty');

if (normalizeAirportCode('wolfhouse-somo', 'SDR') === 'SDR') pass('B.norm-sdr', 'normalize SDR');
else fail('B.norm-sdr', 'normalize SDR');
if (normalizeAirportCode('wolfhouse-somo', 'Santander') === 'SDR') pass('B.norm-santander', 'normalize Santander');
else fail('B.norm-santander', 'normalize Santander');
if (normalizeAirportCode('wolfhouse-somo', 'BIO') === 'BIO') pass('B.norm-bio', 'normalize BIO');
else fail('B.norm-bio', 'normalize BIO');
if (normalizeAirportCode('wolfhouse-somo', 'Bilbao') === 'BIO') pass('B.norm-bilbao', 'normalize Bilbao');
else fail('B.norm-bilbao', 'normalize Bilbao');

const helperSrcEarly = readOrEmpty(HELPER);
if (!helperSrcEarly.includes("'SDR'") && !helperSrcEarly.includes("'BIO'")) {
  pass('B.helper-generic', 'booking-transfers.js has no hard-coded airport codes');
} else {
  fail('B.helper-generic', 'booking-transfers hard-codes airport codes');
}

section('C. Helper — normalization + lookup date');

const {
  normalizeTransferDirection,
  normalizeTransferStatus,
  normalizeFlightNumber,
  defaultTransferLookupDate,
  priceBookingTransfer,
  buildBookingTransferUpsertPayload,
  upsertBookingTransfer,
  listBookingTransfersForBooking,
  listBookingTransfersForCalendarRange,
} = require('./lib/booking-transfers');

try {
  if (normalizeTransferDirection('arrival') === 'arrival') pass('C1', 'normalizeTransferDirection arrival');
  else fail('C1', 'normalizeTransferDirection arrival');
  if (normalizeTransferStatus('confirmed') === 'confirmed') pass('C2', 'normalizeTransferStatus');
  else fail('C2', 'normalizeTransferStatus');
  if (normalizeFlightNumber(' fr 1234 ') === 'FR1234') pass('C3', 'normalizeFlightNumber trim/uppercase');
  else fail('C3', 'normalizeFlightNumber');

  const booking = { check_in: '2026-07-01', check_out: '2026-07-08', guest_count: 4, package_code: 'malibu' };
  if (defaultTransferLookupDate({ direction: 'arrival', booking }) === '2026-07-01') {
    pass('C4', 'lookup date default check-in for arrival');
  } else fail('C4', 'arrival lookup date');
  if (defaultTransferLookupDate({ direction: 'departure', booking }) === '2026-07-08') {
    pass('C5', 'lookup date default check-out for departure');
  } else fail('C5', 'departure lookup date');
} catch (e) {
  fail('C.norm', e.message);
}

section('D. Pricing helper');

const pkgBooking = { package_code: 'malibu', guest_count: 2 };
const noPkgBooking = { package_code: null, guest_count: 2 };

const sdrPkg = priceBookingTransfer({ client_slug: 'wolfhouse-somo', booking: pkgBooking, transfer: { airport_code: 'SDR' } });
if (sdrPkg.available && sdrPkg.included_in_package && sdrPkg.price_cents === 0) {
  pass('D1', 'SDR package included → 0');
} else fail('D1', 'SDR package included');

const sdrNoPkg = priceBookingTransfer({ client_slug: 'wolfhouse-somo', booking: noPkgBooking, transfer: { airport_code: 'SDR' } });
if (sdrNoPkg.available && sdrNoPkg.price_cents === 2500) pass('D2', 'SDR no package → 2500');
else fail('D2', 'SDR no package');

const bio4 = priceBookingTransfer({
  client_slug: 'wolfhouse-somo',
  booking: { package_code: 'malibu', guest_count: 4 },
  transfer: { airport_code: 'BIO' },
});
if (bio4.available && bio4.price_cents === 6000) pass('D3', 'BIO package 4 guests → 6000');
else fail('D3', 'BIO 4 guests');

const bio3 = priceBookingTransfer({
  client_slug: 'wolfhouse-somo',
  booking: { package_code: 'malibu', guest_count: 3 },
  transfer: { airport_code: 'BIO' },
});
if (!bio3.available && bio3.error_code === 'bilbao_min_group') pass('D4', 'BIO 3 guests → bilbao_min_group');
else fail('D4', 'BIO min group');

const bioNoPkg = priceBookingTransfer({
  client_slug: 'wolfhouse-somo',
  booking: noPkgBooking,
  transfer: { airport_code: 'BIO' },
});
if (!bioNoPkg.available && bioNoPkg.error_code === 'bilbao_package_required') {
  pass('D5', 'BIO no package → bilbao_package_required');
} else fail('D5', 'BIO no package');

const unknownAir = priceBookingTransfer({
  client_slug: 'wolfhouse-somo',
  booking: pkgBooking,
  transfer: { airport_code: 'MAD' },
});
if (!unknownAir.available && unknownAir.error_code === 'airport_not_supported') {
  pass('D6', 'unknown airport → airport_not_supported');
} else fail('D6', 'unknown airport');

section('E. Upsert + list (mock pg)');

function mockPg(seed = []) {
  const rows = [...seed];
  return {
    rows,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO booking_transfers/i.test(norm)) {
        const [
          clientSlug, bookingId, direction, status,
          airportCode, airportLabel, flightNumber, lookupDate, scheduledAt,
          pickupLocation, dropoffLocation, guestCount,
          priceCents, currency, includedInPackage, pricingNote, notes,
          source, flightLookupProvider, flightLookupStatus, flightLookupSummary,
        ] = params;
        const idx = rows.findIndex((r) => r.booking_id === bookingId && r.direction === direction);
        const row = {
          id: idx >= 0 ? rows[idx].id : `id-${rows.length + 1}`,
          client_slug: clientSlug,
          booking_id: bookingId,
          direction,
          status,
          airport_code: airportCode,
          airport_label: airportLabel,
          flight_number: flightNumber,
          lookup_date: lookupDate,
          scheduled_at: scheduledAt,
          pickup_location: pickupLocation,
          dropoff_location: dropoffLocation,
          guest_count: guestCount,
          price_cents: priceCents,
          currency,
          included_in_package: includedInPackage,
          pricing_note: pricingNote,
          notes,
          source,
          flight_lookup_provider: flightLookupProvider,
          flight_lookup_status: flightLookupStatus,
          flight_lookup_summary: flightLookupSummary,
        };
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
        return { rows: [row] };
      }
      if (/FROM booking_transfers/i.test(norm) && /booking_id = \$2/i.test(norm)) {
        const [clientSlug, bookingId] = params;
        return {
          rows: rows.filter((r) => r.client_slug === clientSlug && r.booking_id === bookingId),
        };
      }
      if (/FROM booking_transfers/i.test(norm) && /BETWEEN/i.test(norm)) {
        const [clientSlug] = params;
        return { rows: rows.filter((r) => r.client_slug === clientSlug) };
      }
      throw new Error(`unexpected sql: ${norm.slice(0, 80)}`);
    },
  };
}

(async function runAsync() {
  const pg = mockPg();
  const booking = { check_in: '2026-07-01', check_out: '2026-07-08', guest_count: 4, package_code: 'malibu' };
  const bookingId = '11111111-1111-1111-1111-111111111111';

  await upsertBookingTransfer(pg, {
    client_slug: 'wolfhouse-somo',
    booking_id: bookingId,
    direction: 'arrival',
    booking,
    transfer: { airport_code: 'SDR', flight_number: 'fr1234' },
  });
  await upsertBookingTransfer(pg, {
    client_slug: 'wolfhouse-somo',
    booking_id: bookingId,
    direction: 'departure',
    booking,
    transfer: { airport_code: 'SDR' },
  });
  if (pg.rows.length === 2) pass('E1', 'arrival + departure rows for same booking');
  else fail('E1', 'expected 2 transfer rows');

  await upsertBookingTransfer(pg, {
    client_slug: 'wolfhouse-somo',
    booking_id: bookingId,
    direction: 'arrival',
    booking,
    transfer: { airport_code: 'SDR', notes: 'updated' },
  });
  if (pg.rows.length === 2 && pg.rows.find((r) => r.direction === 'arrival').notes === 'updated') {
    pass('E2', 'upsert on conflict updates same direction');
  } else fail('E2', 'upsert conflict update');

  const listed = await listBookingTransfersForBooking(pg, {
    client_slug: 'wolfhouse-somo',
    booking_id: bookingId,
  });
  if (listed.length === 2) pass('E3', 'listBookingTransfersForBooking client scoped');
  else fail('E3', 'list for booking');

  const other = await listBookingTransfersForBooking(pg, {
    client_slug: 'other-client',
    booking_id: bookingId,
  });
  if (other.length === 0) pass('E4', 'list does not cross clients');
  else fail('E4', 'cross-client list leak');

  const cal = await listBookingTransfersForCalendarRange(pg, {
    client_slug: 'wolfhouse-somo',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
  });
  if (cal.length === 2) pass('E5', 'listBookingTransfersForCalendarRange');
  else fail('E5', 'calendar range list');

  const payload = buildBookingTransferUpsertPayload({
    client_slug: 'wolfhouse-somo',
    booking,
    transferInput: { direction: 'arrival', airport_code: 'Santander' },
  });
  if (payload.airport_code === 'SDR' && payload.lookup_date === '2026-07-01') {
    pass('E6', 'buildBookingTransferUpsertPayload defaults');
  } else fail('E6', 'build payload');

  section('F. Docs');

  const doc = readOrEmpty(DOC);
  if (doc.includes('booking_transfers')) pass('F1', 'doc describes table');
  else fail('F1', 'doc table');
  if (/config-first|config module|client-transfer-config/i.test(doc)) pass('F2', 'config-first design');
  else fail('F2', 'config-first');
  if (/no UI|no Aviationstack|no Stripe/i.test(doc)) pass('F3', 'out of scope noted');
  else fail('F3', 'out of scope');

  section('G. Safety — no Stripe/payment/WhatsApp/guest AI');

  const helperSrc = readOrEmpty(HELPER);
  if (!helperSrc.match(/\bstripe\b/i) && !helperSrc.match(/\bn8n\b/i)) {
    pass('G1', 'helper has no Stripe/n8n imports');
  } else fail('G1', 'helper touches Stripe/n8n');
  if (!helperSrc.includes('payment_intent') && !helperSrc.includes('createPayment')) {
    pass('G2', 'no payment write helpers');
  } else fail('G2', 'payment writes in helper');

  for (const f of GUEST_UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (!src) {
      fail('G.' + base, `${base} missing`);
      continue;
    }
    if (!src.includes('booking-transfers') && !/booking_transfers/i.test(src)) {
      pass('G.' + base, `${base} unchanged`);
    } else fail('G.' + base, `${base} touched unexpectedly`);
  }
  if (GUEST_WEBHOOK) {
    const whSrc = readOrEmpty(GUEST_WEBHOOK);
    if (!whSrc.includes('booking-transfers') && !/booking_transfers/i.test(whSrc)) {
      pass('G.webhook', 'Meta webhook unchanged');
    } else fail('G.webhook', 'Meta webhook touched');
  } else {
    pass('G.webhook', 'Meta webhook file not in repo (skip)');
  }

  section('H. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  const rel = 'scripts/verify-luna-agent-phase26-transfer-foundation.js';
  if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) pass('H1', `${SCRIPT} registered`);
  else fail('H1', `${SCRIPT} missing`);

  section('I. Downstream design verifier');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
      pass('I.' + script, `${script} still passes`);
    } catch {
      fail('I.' + script, `${script} failed`);
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  fail('async', err.message);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
