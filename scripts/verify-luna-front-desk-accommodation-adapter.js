'use strict';

/**
 * verify:luna-front-desk-accommodation-adapter
 *
 * Strict parity: legacy Wolfhouse helpers vs accommodation vertical adapter.
 */

const {
  VERTICAL_IDS,
  VERTICAL_CHANNELS,
  resolveBusinessVertical,
  invokeVerticalOperation,
  accommodationVerticalAdapter,
  surfSchoolVerticalAdapter,
} = require('./lib/luna-front-desk-business-vertical');
const { calculateWolfhouseQuote } = require('./lib/wolfhouse-quote-calculator');
const { computePackagePricePreview } = require('./lib/booking-guests');
const {
  executeWolfhouseAccommodationListOfferings,
  executeWolfhouseAccommodationQuote,
  evaluateWolfhouseAccommodationDates,
  buildWolfhouseAccommodationCatalog,
  WOLFHOUSE_CLIENT_SLUG,
} = require('./lib/wolfhouse-accommodation-application');
const {
  runAvailabilityCheckDryRun,
  runLunaGuestBookingDryRun,
} = require('./lib/luna-guest-booking-dry-run');
const { GOLDEN_BED_ROWS } = require('./lib/luna-golden-offline-pg');

let pass = 0;
let fail = 0;
function assert(label, condition, detail) {
  if (condition) { console.log(`  PASS  ${label}`); pass += 1; return; }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  fail += 1;
}

const CHECK_IN = '2026-07-06';
const CHECK_OUT = '2026-07-13';
const SHORT_OUT = '2026-07-09';
const CLOSED_IN = '2026-01-10';
const CLOSED_OUT = '2026-01-17';
const GUESTS = 2;

function wolfhouseResolved() {
  return resolveBusinessVertical({ clientSlug: WOLFHOUSE_CLIENT_SLUG });
}

function makePg(opts = {}) {
  const beds = opts.beds || GOLDEN_BED_ROWS;
  const inserts = [];
  let committed = false;
  return {
    inserts,
    committed: () => committed,
    query: async (sql, params) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim();
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(s)) {
        if (/^COMMIT/i.test(s)) committed = true;
        return { rows: [] };
      }
      if (/inserted_booking_beds|is_duplicate/i.test(s)) {
        const bedCount = Array.isArray(params[12]) ? params[12].length : 1;
        inserts.push({ table: 'bookings', params: [...params] });
        return {
          rows: [{
            is_duplicate: false,
            is_blocked: false,
            booking_id: 'adapter-booking-1',
            booking_code: 'WH-ADAPTER-01',
            beds_inserted: bedCount,
            payments_inserted: 1,
            audit_event_id: 'audit-adapt-1',
          }],
        };
      }
      if (norm.includes('FROM rooms r') && norm.includes('LEFT JOIN beds bd')) {
        return { rows: beds };
      }
      if (norm.includes('FROM booking_beds bb') && norm.includes('assignment_start_date')) {
        return { rows: opts.blocks || [] };
      }
      if (/UPDATE bookings/i.test(s)) {
        inserts.push({ table: 'bookings_update', params: [...params] });
        return { rows: [] };
      }
      if (/UPDATE payments/i.test(s)) {
        inserts.push({ table: 'payments_update', params: [...params] });
        return { rows: [{ payment_id: 'pay-adapt-1' }] };
      }
      if (/FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-wh-1' }] };
      if (/SELECT client_id FROM bookings/i.test(s)) return { rows: [{ client_id: 'client-wh-1' }] };
      if (/FROM booking_beds/i.test(s) && /SELECT/i.test(s)) {
        return { rows: [{ bed_code: 'R1-B1', room_code: 'R1' }] };
      }
      if (/information_schema|to_regclass/i.test(s)) return { rows: [{ reg: 'booking_service_records' }] };
      if (/INSERT INTO/i.test(s)) {
        inserts.push({ sql: s.slice(0, 80) });
        return { rows: [{ id: 'write-blocked' }] };
      }
      return { rows: [] };
    },
  };
}

async function run() {
  console.log('\nverify:luna-front-desk-accommodation-adapter\n');
  const wh = wolfhouseResolved();
  assert('wolfhouse-somo resolves ok', wh.ok === true);
  assert('wolfhouse vertical is accommodation', wh.verticalId === VERTICAL_IDS.ACCOMMODATION);
  assert('wolfhouse alias resolves', resolveBusinessVertical({ clientSlug: 'wolfhouse' }).clientSlug === WOLFHOUSE_CLIENT_SLUG);
  assert('sunset still surf_school', resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'sunset-somo' }).verticalId === VERTICAL_IDS.SURF_SCHOOL);
  assert('unknown tenant fails closed', resolveBusinessVertical({ clientSlug: 'seadog' }).ok === false);

  console.log('\n[A] Catalog / package list parity');
  const directCatalog = buildWolfhouseAccommodationCatalog();
  const adapterCatalog = await accommodationVerticalAdapter.listOfferings(null, {
    resolved: wh,
    transportBody: {},
  });
  assert('adapter catalog ok', adapterCatalog.ok === true);
  assert('catalog offering count parity', adapterCatalog.body.offerings.length === directCatalog.offerings.length);
  assert('malibu package listed', (adapterCatalog.body.offerings || []).some((o) => o.package_code === 'malibu'));

  const listBody = { check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: GUESTS, room_type: 'shared' };
  const directList = executeWolfhouseAccommodationListOfferings(listBody);
  const adapterList = await accommodationVerticalAdapter.listOfferings(null, {
    resolved: wh,
    transportBody: listBody,
  });
  const legacyPreview = computePackagePricePreview({
    client_slug: WOLFHOUSE_CLIENT_SLUG,
    ...listBody,
  });
  assert('adapter dated list ok', adapterList.ok === true);
  assert('malibu total parity', adapterList.body.packages.malibu.total_cents === legacyPreview.packages.malibu.total_cents);
  assert('direct helper matches legacy preview', directList.body.packages.malibu.total_cents === legacyPreview.packages.malibu.total_cents);

  console.log('\n[B] Quote parity');
  const quoteBody = {
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: GUESTS,
    package_code: 'malibu',
    room_type: 'shared',
    payment_choice: 'deposit',
  };
  const directQuote = calculateWolfhouseQuote({
    client_slug: WOLFHOUSE_CLIENT_SLUG,
    ...quoteBody,
    add_ons: [],
  });
  const adapterQuote = await accommodationVerticalAdapter.quoteOffering(null, {
    resolved: wh,
    channel: VERTICAL_CHANNELS.MANUAL_STAFF,
    transportBody: quoteBody,
  });
  assert('adapter quote ok', adapterQuote.ok === true);
  assert('quote total parity', adapterQuote.body.quote.total_cents === directQuote.total_cents);
  assert('quote nights parity', adapterQuote.body.quote.nights === directQuote.nights);

  const appQuote = executeWolfhouseAccommodationQuote(quoteBody);
  assert('application quote matches direct', appQuote.body.quote.total_cents === directQuote.total_cents);

  console.log('\n[C] Invalid dates / package-night rules');
  const shortEvalDirect = evaluateWolfhouseAccommodationDates({
    check_in: CHECK_IN,
    check_out: SHORT_OUT,
    package_code: 'malibu',
  });
  const shortEvalAdapter = accommodationVerticalAdapter.evaluateDates({
    resolved: wh,
    transportBody: { check_in: CHECK_IN, check_out: SHORT_OUT, package_code: 'malibu' },
  });
  assert('short stay weekly package blocked (direct)', shortEvalDirect.ok === false);
  assert('short stay weekly package blocked (adapter)', shortEvalAdapter.ok === false);
  assert('evaluate reason parity', shortEvalDirect.reason === shortEvalAdapter.reason);

  const closedEval = accommodationVerticalAdapter.evaluateDates({
    resolved: wh,
    transportBody: { check_in: CLOSED_IN, check_out: CLOSED_OUT, package_code: 'accommodation_only' },
  });
  assert('closed season fails evaluateDates', closedEval.ok === false && closedEval.reason === 'closed_season');

  const badQuote = await accommodationVerticalAdapter.quoteOffering(null, {
    resolved: wh,
    transportBody: { check_in: CHECK_IN, check_out: SHORT_OUT, guest_count: 1, package_code: 'malibu' },
  });
  assert('short stay quote rejected', badQuote.ok === false && badQuote.status === 400);

  console.log('\n[D] Availability parity');
  const pg = makePg();
  const availFields = {
    client_slug: WOLFHOUSE_CLIENT_SLUG,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: GUESTS,
    room_type: 'shared',
  };
  const directAvail = await runAvailabilityCheckDryRun(availFields, pg);
  const adapterAvail = await accommodationVerticalAdapter.checkAvailability(pg, {
    resolved: wh,
    transportBody: availFields,
  });
  assert('adapter availability ok', adapterAvail.ok === true);
  assert('has_enough_beds parity', adapterAvail.body.has_enough_beds === directAvail.has_enough_beds);
  assert('selected_bed_codes parity', JSON.stringify(adapterAvail.body.selected_bed_codes) === JSON.stringify(directAvail.selected_bed_codes));

  console.log('\n[E] Create booking dry-run parity');
  const createBody = {
    dry_run: true,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: GUESTS,
    package_code: 'malibu',
    room_type: 'shared',
    guest_name: 'Adapter Guest',
    phone: '+34600000001',
    payment_choice: 'deposit',
  };
  const pgCreate = makePg();
  const directDry = await runLunaGuestBookingDryRun(createBody, { pg: pgCreate });
  const adapterDry = await accommodationVerticalAdapter.createBooking(pgCreate, {
    resolved: wh,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: createBody,
  });
  assert('adapter dry-run ok', adapterDry.ok === true);
  assert('dry-run safety flags', adapterDry.body.dry_run === true && adapterDry.body.creates_booking === false);
  assert('quote total dry-run parity',
    adapterDry.body.booking_preview.quote.total_cents === directDry.booking_preview.quote.total_cents);
  assert('dry-run zero inserts', pgCreate.inserts.length === 0);

  const pgLive = makePg();
  const liveCreate = await accommodationVerticalAdapter.createBooking(pgLive, {
    resolved: wh,
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: {
      ...createBody,
      dry_run: false,
      confirm: true,
      selected_bed_codes: adapterDry.body.booking_preview?.selected_bed_codes || ['R1-B1'],
    },
    actorHints: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
  });
  assert('live create ok', liveCreate.ok === true && liveCreate.status === 201);
  assert('live create has booking_id', !!(liveCreate.body && liveCreate.body.booking_id));

  console.log('\n[F] Cross-vertical transport rejection');
  const surfOnAcc = await accommodationVerticalAdapter.quoteOffering(null, {
    resolved: wh,
    transportBody: { offering_id: 'surf_pack_x', check_in: CHECK_IN, check_out: CHECK_OUT, guest_count: 1 },
  });
  assert('accommodation rejects offering_id', surfOnAcc.body.reason === 'surf_school_fields_not_supported');

  const sunset = resolveBusinessVertical({ clientSlug: 'sunset', locationId: 'sunset-somo' });
  const accOnSurf = await surfSchoolVerticalAdapter.quoteOffering(null, {
    resolved: sunset,
    transportBody: { check_in: CHECK_IN, check_out: CHECK_OUT, package_code: 'malibu', service_dates: [CHECK_IN] },
  });
  assert('surf-school rejects accommodation fields', accOnSurf.body.reason === 'accommodation_fields_not_supported');

  const wrongTenant = { ok: true, verticalId: VERTICAL_IDS.ACCOMMODATION, clientSlug: 'sunset', locationId: null };
  const tenantMismatch = await accommodationVerticalAdapter.listOfferings(null, { resolved: wrongTenant, transportBody: {} });
  assert('tenant mismatch blocked', tenantMismatch.body.reason === 'tenant_mismatch');

  console.log('\n[G] invokeVerticalOperation wiring');
  const invoked = await invokeVerticalOperation(wh, 'quoteOffering', null, {
    channel: VERTICAL_CHANNELS.LUNA_WHATSAPP,
    transportBody: quoteBody,
  });
  assert('invoke quote ok', invoked.ok === true);
  assert('invoke matches adapter quote', invoked.body.quote.total_cents === adapterQuote.body.quote.total_cents);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
