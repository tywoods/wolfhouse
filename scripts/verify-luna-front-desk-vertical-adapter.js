'use strict';

/**
 * verify:luna-front-desk-vertical-adapter
 *
 * Contract tests for the surf-school vertical adapter boundary (Slice 6).
 */

const fs = require('fs');
const path = require('path');
const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  resolveBusinessVertical,
  getVerticalAdapter,
  invokeVerticalOperation,
  surfSchoolVerticalAdapter,
  accommodationVerticalAdapter,
} = require('./lib/luna-front-desk-business-vertical');
const {
  executeSunsetCatalogSync,
  buildSunsetCatalogCommand,
  CATALOG_CHANNELS,
} = require('./lib/luna-front-desk-catalog-service');
const {
  executeSunsetQuoteSync,
  buildSunsetQuoteCommand,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const {
  executeSunsetBookingCreate,
  buildSunsetBookingCreateCommand,
  BOOKING_CREATE_CHANNELS,
  resolveActorForChannel,
} = require('./lib/luna-front-desk-booking-create-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const PACK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TIER = '1_week';
const ITEM = packPriceItemCode(PACK_ID, TIER);
const AMOUNT = 19900;
const FRIDAY = '2026-07-17';
const SATURDAY = '2026-07-18';
const LOC = 'sunset-somo';

function adminCfg() {
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    surf_packs: [{
      pack_id: PACK_ID,
      label: 'Weekend Course',
      active: true,
      group_size: 2,
      weekly: 'sat_sun',
      schedules: ['0930_1130'],
      price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
    }],
    prices: [{
      id: 'price-1',
      category: 'package',
      offering_key: ITEM,
      item_code: ITEM,
      amount_cents: AMOUNT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
  };
}

function makePg(opts = {}) {
  const seats = opts.existingCourseSeats || {};
  const inserts = [];
  return {
    inserts,
    query: async (sql, params) => {
      const s = String(sql);
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) return { rows: [] };
      if (/^ROLLBACK/i.test(s)) return { rows: [] };
      if (/SELECT id FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-sunset' }] };
      if (/information_schema\.(tables|columns)/i.test(s)) return { rows: [{ '?column?': 1 }] };
      if (/to_regclass/i.test(s)) return { rows: [{ reg: 'tenant_price_rules' }] };
      if (/FROM tenant_surf_pack_rules/i.test(s)) {
        return {
          rows: [{
            id: PACK_ID,
            label: 'Weekend Course',
            config_json: {
              group_size: 2,
              weekly: 'sat_sun',
              schedules: ['0930_1130'],
              price_tiers: [{ key: TIER, label: '1 week', hours: 10, amount_cents: AMOUNT }],
            },
          }],
        };
      }
      if (/COALESCE\(SUM/i.test(s) && /booking_service_records/i.test(s)) {
        const key = `${params[2]}|${String(params[1]).slice(0, 10)}`;
        return { rows: [{ seats: seats[key] != null ? seats[key] : 0 }] };
      }
      if (/FROM tenant_price_rules/i.test(s)) {
        const itemCode = params[2];
        if (String(itemCode || '').startsWith('surf_pack_')) {
          return { rows: [{ id: 'price-1', amount_cents: AMOUNT, currency: 'EUR', item_type: 'package', item_code: itemCode, unit: 'day', location_id: LOC }] };
        }
        return { rows: [] };
      }
      if (/INSERT INTO bookings/i.test(s)) {
        inserts.push({ table: 'bookings' });
        return { rows: [{ id: 'booking-uuid-1', booking_code: 'SUNSET-VRT-01' }] };
      }
      if (/INSERT INTO booking_service_records/i.test(s)) {
        inserts.push({ table: 'booking_service_records', params: [...params] });
        return { rows: [{ service_record_id: 'sr-1', booking_id: 'booking-uuid-1', amount_due_cents: AMOUNT, metadata: {} }] };
      }
      if (/SELECT metadata FROM bookings/i.test(s)) return { rows: [{ metadata: { location_id: LOC, source: 'staff_manual_schedule' } }] };
      if (/SELECT id, service_type/i.test(s) && /FROM booking_service_records/i.test(s)) {
        return { rows: inserts.filter((i) => i.table === 'booking_service_records').map((row, idx) => ({
          id: `sr-${idx + 1}`,
          service_type: 'surf_lesson',
          service_date: row.params[5],
          quantity: row.params[6],
          amount_due_cents: 0,
          metadata: typeof row.params[9] === 'string' ? JSON.parse(row.params[9]) : row.params[9],
        })) };
      }
      if (/UPDATE booking_service_records/i.test(s) || /UPDATE bookings SET/i.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

async function run() {
  console.log('\nverify:luna-front-desk-vertical-adapter\n');
  process.env.SUNSET_ADMIN_DB_READ_ENABLED = 'true';
  const cfg = adminCfg();

  console.log('[A] Resolver — Sunset → surf_school only');
  const sunset = resolveBusinessVertical({ clientSlug: 'sunset', locationId: LOC });
  assert('sunset resolves ok', sunset.ok === true);
  assert('sunset vertical is surf_school', sunset.verticalId === VERTICAL_IDS.SURF_SCHOOL);
  assert('wolfhouse-somo resolves accommodation', resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' }).verticalId === VERTICAL_IDS.ACCOMMODATION);
  assert('wolfhouse alias resolves accommodation', resolveBusinessVertical({ clientSlug: 'wolfhouse' }).verticalId === VERTICAL_IDS.ACCOMMODATION);
  assert('unknown tenant fails', resolveBusinessVertical({ clientSlug: 'seadog' }).ok === false);
  assert('bad location fails', resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'not-a-loc' }).ok === false);
  assert('body tenant override ignored at resolve', resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'sunset-sardinero' }).locationId === 'sunset-sardinero');

  console.log('\n[B] Accommodation adapter delegates (not placeholder)');
  const wh = resolveBusinessVertical({ clientSlug: 'wolfhouse-somo' });
  const whCatalog = await accommodationVerticalAdapter.listOfferings(null, { resolved: wh, transportBody: {} });
  assert('accommodation listOfferings ok', whCatalog.ok === true);
  assert('accommodation catalog has malibu', (whCatalog.body.offerings || []).some((o) => o.package_code === 'malibu'));
  const whQuote = await accommodationVerticalAdapter.quoteOffering(null, {
    resolved: wh,
    transportBody: {
      check_in: '2026-07-06',
      check_out: '2026-07-13',
      guest_count: 1,
      package_code: 'malibu',
      room_type: 'shared',
      payment_choice: 'deposit',
    },
  });
  assert('accommodation quote ok', whQuote.ok === true && whQuote.body.quote.total_cents > 0);
  const whCreate = await accommodationVerticalAdapter.createBooking(null, {
    resolved: wh,
    transportBody: { dry_run: true, check_in: '2026-07-06', check_out: '2026-07-13', guest_count: 1, package_code: 'malibu', room_type: 'shared', guest_name: 'T', phone: '+34000000000', payment_choice: 'deposit' },
  });
  assert('accommodation create dry-run ok', whCreate.ok === true && whCreate.body.dry_run === true);

  console.log('\n[C] Catalog parity — direct vs adapter');
  const transport = { require_db: true, service_dates: [SATURDAY] };
  const directCatalog = executeSunsetCatalogSync(
    buildSunsetCatalogCommand({ channel: CATALOG_CHANNELS.LUNA_WHATSAPP, trustedLocationId: LOC, transportBody: transport }).command,
    { adminCfg: cfg },
  );
  const adapterCatalog = await surfSchoolVerticalAdapter.listOfferings(null, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: transport,
    adminCfg: cfg,
  });
  assert('adapter catalog ok', adapterCatalog.ok === true);
  const directOff = (directCatalog.body.offerings || []).find((o) => o.offering_id === ITEM);
  const adapterOff = (adapterCatalog.body.offerings || []).find((o) => o.offering_id === ITEM);
  assert('catalog offering_id parity', directOff && adapterOff && directOff.offering_id === adapterOff.offering_id);
  assert('catalog price parity', directOff.unit_amount_cents === adapterOff.unit_amount_cents);

  console.log('\n[D] Quote parity — manual vs Luna channels');
  const quoteBody = {
    offering_id: ITEM,
    course_id: PACK_ID,
    tier_key: TIER,
    service_dates: [SATURDAY],
    quantity: 1,
    require_db: true,
  };
  const directManual = executeSunsetQuoteSync(
    buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.MANUAL_STAFF, trustedLocationId: LOC, transportBody: quoteBody }).command,
    { adminCfg: cfg },
  );
  const adapterManual = await surfSchoolVerticalAdapter.quoteOffering(null, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    transportBody: quoteBody,
    adminCfg: cfg,
  });
  const adapterLuna = await surfSchoolVerticalAdapter.quoteOffering(null, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: { ...quoteBody, client_slug: 'wolfhouse', location_id: 'sunset-sardinero' },
    adminCfg: cfg,
  });
  assert('adapter manual quote ok', adapterManual.ok === true);
  assert('adapter luna quote ok', adapterLuna.ok === true);
  assert('quote total parity', adapterManual.body.total_cents === directManual.body.total_cents);
  assert('manual/luna quote totals match', adapterManual.body.total_cents === adapterLuna.body.total_cents);

  console.log('\n[E] Weekend/date errors identical through adapter');
  const friBody = { ...quoteBody, service_dates: [FRIDAY] };
  const directFri = executeSunsetQuoteSync(
    buildSunsetQuoteCommand({ channel: QUOTE_CHANNELS.MANUAL_STAFF, trustedLocationId: LOC, transportBody: friBody }).command,
    { adminCfg: cfg },
  );
  const adapterFri = await surfSchoolVerticalAdapter.quoteOffering(null, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    transportBody: friBody,
    adminCfg: cfg,
  });
  assert('direct weekday fails', directFri.ok === false);
  assert('adapter weekday fails', adapterFri.ok === false);
  assert('weekday reason parity', directFri.body.reason === adapterFri.body.reason);

  console.log('\n[F] evaluateDates via adapter');
  const offering = (directCatalog.body.offerings || []).find((o) => o.offering_id === ITEM);
  const evalSat = surfSchoolVerticalAdapter.evaluateDates({
    resolved: sunset,
    offering,
    serviceDates: [SATURDAY],
  });
  const evalFri = surfSchoolVerticalAdapter.evaluateDates({
    resolved: sunset,
    offering,
    serviceDates: [FRIDAY],
  });
  assert('Saturday evaluateDates ok', evalSat.ok === true);
  assert('Friday evaluateDates fails', evalFri.ok === false);

  console.log('\n[G] Cross-tenant adapter scope rejected');
  const wrongResolved = { ok: true, verticalId: VERTICAL_IDS.SURF_SCHOOL, clientSlug: 'wolfhouse', locationId: LOC };
  const cross = await surfSchoolVerticalAdapter.listOfferings(null, {
    resolved: wrongResolved,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: transport,
    adminCfg: cfg,
  });
  assert('cross-tenant list blocked', cross.ok === false && cross.body.reason === 'tenant_mismatch');

  console.log('\n[H] invokeVerticalOperation wiring');
  const invoked = await invokeVerticalOperation(sunset, 'listOfferings', null, {
    channel: VERTICAL_CHANNELS.SCHEDULE,
    transportBody: transport,
    adminCfg: cfg,
  });
  assert('invoke listOfferings ok', invoked.ok === true);
  assert('unknown vertical fails', getVerticalAdapter({ ok: true, verticalId: 'unknown' }) == null);

  console.log('\n[I] Create booking — attribution preserved, zero writes on quote/catalog');
  const pg = makePg();
  const pgCatalog = makePg();
  await surfSchoolVerticalAdapter.listOfferings(pgCatalog, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: transport,
    adminCfg: cfg,
  });
  assert('catalog via adapter zero booking inserts', pgCatalog.inserts.length === 0);

  const manualActor = resolveActorForChannel(BOOKING_CREATE_CHANNELS.MANUAL_STAFF, { email: 'staff@test.com' });
  const lunaActor = resolveActorForChannel(BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP, {});
  assert('manual actor staff path', manualActor && manualActor.email === 'staff@test.com');
  assert('luna actor bot path', lunaActor && lunaActor.source === 'agent_luna_whatsapp_bot');

  const createBody = {
    guest_name: 'Vertical Guest',
    payment_status: 'unpaid',
    service_dates: [SATURDAY],
    components: { course: { quantity: 1, course_id: PACK_ID, tier_key: TIER } },
  };
  const pgManual = makePg();
  const manualCreate = await surfSchoolVerticalAdapter.createBooking(pgManual, {
    resolved: sunset,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    transportBody: createBody,
    actorHints: { email: 'staff@test.com' },
  });
  assert('manual create ok', manualCreate.ok === true, JSON.stringify(manualCreate.body));

  console.log('\n[J] HTTP routes use vertical resolver (no direct service imports)');
  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert('staff API imports business vertical', apiSrc.includes('luna-front-desk-business-vertical'));
  assert('staff API uses resolveBusinessVertical', apiSrc.includes('resolveBusinessVertical'));
  assert('staff API uses invokeVerticalOperation', apiSrc.includes('invokeVerticalOperation'));
  assert('staff API no direct executeSunsetCatalog', !/executeSunsetCatalog\s*\(/.test(apiSrc));
  assert('staff API no direct executeSunsetQuote', !/executeSunsetQuote\s*\(/.test(apiSrc));
  assert('staff API no direct executeSunsetBookingCreate', !/executeSunsetBookingCreate\s*\(/.test(apiSrc));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
