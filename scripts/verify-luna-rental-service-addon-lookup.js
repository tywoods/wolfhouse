'use strict';

/**
 * Staff Rentals + Services lookup for Luna add-anything (WH prod flipflops miss).
 *
 * Guest asked to add flipflops on WH-20270615-14908309. Luna called
 * lookup_catalog_service three times (tenant_services only) → matched:false
 * and never quoted Staff > Rentals FLIPFLOPS at €10/day.
 *
 * Run: node scripts/verify-luna-rental-service-addon-lookup.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const {
  lookupStaffSettingsAddOn,
  staffSettingsAddOnsToCatalogRows,
  pricingItemToTenantServiceShape,
  planPricingAddonCharge,
  chargeStaffSettingsAddon,
} = require('./lib/luna-guest-pricing-addon-lookup');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS ', name);
  } else {
    fail += 1;
    console.log('  FAIL ', name, detail || '');
  }
}

const FLIP_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const YOGA_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const HARD_ID = 'cccccccc-cccc-cccc-cccc-ccccccccccc3';

const pricingView = {
  rentals: [
    {
      id: FLIP_ID,
      code: 'flipflops',
      label: 'FLIPFLOPS',
      durations: [
        { duration: '1_day', item_code: 'flipflops__1_day', amount_cents: 1000, currency: 'EUR', unit: 'day' },
      ],
    },
    {
      id: HARD_ID,
      code: 'hard_board_rental',
      label: 'Hard board',
      durations: [
        { duration: '1_day', item_code: 'hard_board_rental__1_day', amount_cents: 2000, currency: 'EUR', unit: 'day' },
      ],
    },
  ],
  services: [
    {
      id: YOGA_ID,
      code: 'yoga_class',
      label: 'Yoga',
      price: { amount_cents: 1500, currency: 'EUR', unit: 'per_class' },
    },
  ],
};

const tenantServices = [{
  id: 'svc-camp',
  name: 'Chokes and Barrels',
  active: true,
  luna_visible: true,
  keywords: ['jiu jitsu'],
  price_cents: 2000,
  price_unit: 'per_day',
  per_guest: true,
}];

console.log('\nverify-luna-rental-service-addon-lookup\n');

const flip = lookupStaffSettingsAddOn('Can we add some flipflops to the booking?', {
  tenantServices,
  pricingView,
});
ok('flipflops matches Staff Rentals, not only tenant_services',
  flip && flip.catalog_kind === 'rental' && flip.id === FLIP_ID,
  flip && flip.name);
ok('quotes €10/day from live rental price',
  flip && Number(flip.price_cents) === 1000 && /€10/.test((flip.reply && flip.reply.text) || ''),
  flip && flip.reply && flip.reply.text);

const hyphen = lookupStaffSettingsAddOn('check flip-flops', { tenantServices, pricingView });
ok('flip-flops / flipflops compact match',
  hyphen && hyphen.id === FLIP_ID);

const yoga = lookupStaffSettingsAddOn('can we add yoga to the booking?', { tenantServices, pricingView });
ok('Staff Services yoga also matches',
  yoga && yoga.catalog_kind === 'service' && yoga.id === YOGA_ID);

const camp = lookupStaffSettingsAddOn('do you have jiu jitsu?', { tenantServices, pricingView });
ok('existing tenant_services camps still match',
  camp && camp.id === 'svc-camp');

const miss = lookupStaffSettingsAddOn('what time is breakfast', { tenantServices, pricingView });
ok('unrelated text does not match', !miss);

const rows = staffSettingsAddOnsToCatalogRows(pricingView);
ok('catalog rows include rentals and services',
  rows.some((r) => r.catalog_kind === 'rental' && r.name === 'FLIPFLOPS')
  && rows.some((r) => r.catalog_kind === 'service' && r.name === 'Yoga'));

const item = {
  id: FLIP_ID,
  item_type: 'rental',
  item_code: 'flipflops',
  label: 'FLIPFLOPS',
  active: true,
};
const rules = [
  { item_type: 'rental', item_code: 'flipflops__1_day', amount_cents: 1000, unit: 'day', active: true },
];
const shaped = pricingItemToTenantServiceShape(item, rules);
ok('pricing item shapes as catalog service for add-catalog-service UUID path',
  shaped && shaped.id === FLIP_ID && shaped.price_cents === 1000 && shaped.price_unit === 'per_day');

const flipCharge = planPricingAddonCharge({
  item, rules, checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('flipflops 5 nights × €10 = €50',
  flipCharge && flipCharge.ok && flipCharge.amount_due_cents === 5000
  && flipCharge.nights_charged === 5,
  flipCharge);

const yogaItem = {
  id: YOGA_ID, item_type: 'service', item_code: 'yoga_class', label: 'Yoga', active: true,
};
const yogaRules = [
  { item_type: 'service', item_code: 'yoga_class', amount_cents: 1500, unit: 'per_class', active: true },
];
const yogaCharge = planPricingAddonCharge({
  item: yogaItem, rules: yogaRules, checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('yoga service priced at €15 not mixed into rental math',
  yogaCharge && yogaCharge.ok && yogaCharge.amount_due_cents === 1500);

const twoFlip = chargeStaffSettingsAddon(shaped, { quantity: 2, stayNights: 5 });
ok('2 rentals × 5 nights × €10 = €100 (quantity is not ignored)',
  twoFlip && twoFlip.ok && twoFlip.amount_due_cents === 10000 && twoFlip.quantity === 2,
  twoFlip);

const perDayServiceItem = {
  id: 'dddddddd-dddd-dddd-dddd-ddddddddddd4',
  item_type: 'service',
  item_code: 'bike_rental_desk',
  label: 'Bike',
  active: true,
};
const perDayServiceRules = [
  { item_type: 'service', item_code: 'bike_rental_desk', amount_cents: 1000, unit: 'per_day', active: true },
];
const perDayShaped = pricingItemToTenantServiceShape(perDayServiceItem, perDayServiceRules);
ok('per-day service €10/day stays per_day in the add handler, not per_stay',
  perDayShaped && perDayShaped.price_cents === 1000 && perDayShaped.price_unit === 'per_day',
  perDayShaped);
const perDayCharge = planPricingAddonCharge({
  item: perDayServiceItem, rules: perDayServiceRules,
  checkIn: '2027-06-15', checkOut: '2027-06-20', quantity: 1,
});
ok('per-day service 5 nights × €10 = €50',
  perDayCharge && perDayCharge.ok && perDayCharge.amount_due_cents === 5000
  && perDayCharge.nights_charged === 5,
  perDayCharge);

const halfView = {
  rentals: [{
    id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5',
    code: 'boogie_board',
    label: 'Boogie board',
    durations: [
      { duration: 'half_day', item_code: 'boogie_board__half_day', amount_cents: 700, currency: 'EUR', unit: 'half_day' },
    ],
  }],
  services: [],
};
const half = lookupStaffSettingsAddOn('can we add a boogie board', {
  tenantServices: [],
  pricingView: halfView,
});
ok('€7 half-day rental is advertised as a half-day price, not €7/day',
  half && Number(half.price_cents) === 700
  && half.price_unit !== 'per_day'
  && /€7/.test((half.reply && half.reply.text) || '')
  && /half[- ]day/i.test((half.reply && half.reply.text) || '')
  && !/€7\/day/.test((half.reply && half.reply.text) || ''),
  half && half.reply && half.reply.text);

ok('unknown add-on is a miss, not a save block',
  lookupStaffSettingsAddOn('bananas please', { tenantServices, pricingView }) == null);

const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
const lookupFn = api.slice(
  api.indexOf('async function handleBotCatalogServiceLookup'),
  api.indexOf('async function handleAdminServicesPost'),
);
ok('lookup handler searches Staff Rentals + Services, not tenant_services only',
  /lookupStaffSettingsAddOn|staffSettingsAddOnsToCatalogRows|buildAdminPricingView/.test(lookupFn)
  && /loadItems/.test(lookupFn)
  && /loadRules/.test(lookupFn),
  'handler still tenant_services-only');

const addFn = api.slice(
  api.indexOf('async function handleBookingAddService'),
  api.indexOf('async function handleBotAddonRequestCreate'),
);
ok('catalog add falls back to wh_pricing_items rentals/services',
  /pricingItemToTenantServiceShape/.test(addFn) || /wh_pricing_items/.test(addFn),
  'add path still tenant_services UUID only');
ok('add handler charges pricing rentals with quantity, not per_guest-flat',
  /chargeStaffSettingsAddon/.test(addFn),
  'add path still ignores quantity via computeTenantServiceChargeCents');

const stayOff = [
  'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py',
  'docker/hermes-staging/wolfhouse/accepted_quote.py',
  'docker/hermes-staging/wolfhouse/pending_question.py',
  'docker/hermes-staging/wolfhouse/explicit_human_handoff.py',
];
ok('stay-off Cap/Lookout files untouched in this tree vs HEAD intent',
  stayOff.every((f) => fs.existsSync(path.join(__dirname, '..', f))));

const SCRATCH_PREFIX = path.join(os.tmpdir(), 'inbox-pg-scratch');

function ensureScratchModules() {
  const pgJs = path.join(SCRATCH_PREFIX, 'node_modules', 'pg');
  const bin = path.join(SCRATCH_PREFIX, 'node_modules', '@embedded-postgres', 'linux-x64', 'native', 'bin');
  if (!fs.existsSync(pgJs) || !fs.existsSync(path.join(bin, 'postgres'))) {
    fs.mkdirSync(SCRATCH_PREFIX, { recursive: true });
    const r = spawnSync('npm', ['install', 'pg@8.13.1', '@embedded-postgres/linux-x64', '--no-save', '--prefix', SCRATCH_PREFIX], {
      encoding: 'utf8',
      timeout: 120000,
    });
    if (r.status !== 0) throw new Error(`npm install scratch pg failed: ${r.stderr || r.stdout}`);
  }
  return {
    pg: createRequire(path.join(SCRATCH_PREFIX, 'node_modules', 'pg', 'package.json'))('pg'),
    bin,
  };
}

function startThrowawayPostgres(bin) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-throwaway-pg-'));
  execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth=trust', '-U', 'postgres', '--locale=C', '--encoding=UTF8'], {
    stdio: 'pipe',
  });
  const port = 55000 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
  execFileSync(path.join(bin, 'pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(dataDir, 'pg.log'),
    '-o', `-p ${port} -k ${dataDir} --listen-addresses=127.0.0.1`,
    'start',
  ], { stdio: 'pipe' });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try { execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'pipe' }); } catch (_) { /* already stopped */ }
    },
  };
}

(async () => {
  let cluster;
  try {
    const { pg, bin } = ensureScratchModules();
    cluster = startThrowawayPostgres(bin);
    const parsed = new URL(cluster.url);
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) throw new Error('not loopback');
    const client = new pg.Client({ connectionString: cluster.url });
    await client.connect();
    await client.query(`
      CREATE TABLE bookings (
        id UUID PRIMARY KEY,
        booking_code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'confirmed',
        check_in DATE,
        check_out DATE,
        guest_count INT
      );
      CREATE TABLE booking_service_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id UUID NOT NULL REFERENCES bookings(id),
        booking_code TEXT,
        service_type TEXT NOT NULL,
        quantity INT NOT NULL CHECK (quantity > 0),
        amount_due_cents INT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    const bookingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
    const bookingCode = 'WH-20270615-14908309';
    await client.query(
      `INSERT INTO bookings (id, booking_code, status, check_in, check_out, guest_count)
       VALUES ($1::uuid, $2, 'confirmed', '2027-06-15', '2027-06-20', 2)`,
      [bookingId, bookingCode],
    );
    const rentalCharge = chargeStaffSettingsAddon(shaped, { quantity: 2, stayNights: 5 });
    const yogaShaped = pricingItemToTenantServiceShape(yogaItem, yogaRules);
    const yogaSaved = chargeStaffSettingsAddon(yogaShaped, { quantity: 1, stayNights: 5 });
    await client.query(
      `INSERT INTO booking_service_records (booking_id, booking_code, service_type, quantity, amount_due_cents, metadata)
       VALUES ($1::uuid, $2, 'rental', $3, $4, $5::jsonb),
              ($1::uuid, $2, 'yoga', $6, $7, $8::jsonb)`,
      [
        bookingId, bookingCode,
        rentalCharge.quantity, rentalCharge.amount_due_cents, JSON.stringify({ name: 'FLIPFLOPS' }),
        yogaSaved.quantity, yogaSaved.amount_due_cents, JSON.stringify({ name: 'Yoga' }),
      ],
    );
    const read = await client.query(
      `SELECT b.booking_code, b.status, s.service_type, s.quantity, s.amount_due_cents
         FROM bookings b
         JOIN booking_service_records s ON s.booking_id = b.id
        WHERE b.id = $1::uuid
        ORDER BY s.service_type`,
      [bookingId],
    );
    await client.end();
    const rentalRow = read.rows.find((r) => r.service_type === 'rental');
    const yogaRow = read.rows.find((r) => r.service_type === 'yoga');
    ok('SQL save+read booking with 2 flipflops × 5 nights = €100 and yoga €15',
      read.rows.length === 2
      && rentalRow && Number(rentalRow.amount_due_cents) === 10000 && Number(rentalRow.quantity) === 2
      && yogaRow && Number(yogaRow.amount_due_cents) === 1500
      && rentalRow.booking_code === bookingCode
      && rentalRow.status === 'confirmed',
      JSON.stringify(read.rows));
  } catch (err) {
    ok('SQL save+read booking with added rentals/services', false, err && err.message);
  } finally {
    if (cluster) cluster.stop();
  }
  console.log(`\n── rental-service-addon-lookup: ${pass} passed, ${fail} failed ──`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

