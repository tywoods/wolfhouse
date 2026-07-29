'use strict';
const assert = require('assert');
const fs = require('fs');
const {
  prepareGenericRentalsForCreate,
  buildGenericRentalAuthoritativeQuote,
  applyAuthoritativeQuoteAmounts,
  buildScheduleBookingIntentFingerprint,
} = require('./lib/sunset-schedule-booking-writes');

let passed = 0;
async function expect(name, fn) { await fn(); passed += 1; console.log(`PASS ${name}`); }
const catalog = [{ offering_key: 'kayak_rental', active: true, location_id: 'sunset-somo', excludes: [] }];
const loadCatalog = async () => catalog;
const goodRule = async ({ itemCode, duration, pgClient }) => {
  assert.strictEqual(pgClient, fakePg);
  return { status: 'found', amount_cents: 2500, currency: 'EUR', item_code: `${itemCode}__${duration}`, unit: 'session', location_id: 'sunset-somo' };
};
const fakePg = {};
const base = { clientSlug: 'sunset', locationId: 'sunset-somo', serviceDate: '2026-08-01', pgClient: fakePg, rentals: [{ offering_key: 'kayak_rental', duration_key: 'half_day', quantity: 2 }] };
(async () => {
  const previousGenericRentalCreate = process.env.GENERIC_RENTAL_CREATE_ENABLED;
  delete process.env.GENERIC_RENTAL_CREATE_ENABLED;
  await expect('feature flag defaults OFF and preserves canonical-only rejection', async () => {
    const got = await prepareGenericRentalsForCreate({ ...base, listOfferings: loadCatalog, loadRule: goodRule });
    assert.deepStrictEqual(got, { ok: false, reason: 'invalid_rental_offering' });
  });
  process.env.GENERIC_RENTAL_CREATE_ENABLED = 'true';
  await expect('active scoped kayak is resolver-priced and mapped exactly', async () => {
    const got = await prepareGenericRentalsForCreate({ ...base, listOfferings: loadCatalog, loadRule: goodRule });
    assert.strictEqual(got.ok, true); assert.strictEqual(got.records.length, 1);
    const r = got.records[0];
    assert.strictEqual(r.service_type, 'addon_service'); assert.strictEqual(r.quantity, 2);
    assert.strictEqual(r.amount_due_cents, 5000); assert.strictEqual(r.metadata.offering_key, 'kayak_rental');
    assert.deepStrictEqual({ duration: r.metadata.duration_key, location: r.metadata.location_id, item: r.metadata.item_code, unit: r.metadata.unit_cents }, { duration: 'half_day', location: 'sunset-somo', item: 'kayak_rental__half_day', unit: 2500 });
  });
  await expect('exact Admin multi-day package wins over repeating selected base package', async () => {
    const calls = [];
    const got = await prepareGenericRentalsForCreate({
      ...base, calendarDayCount: 3, bookingDurationKey: '3_days', listOfferings: loadCatalog,
      loadRule: async (args) => {
        calls.push(args.duration);
        if (args.duration === '3_days') return { status: 'found', amount_cents: 6000, currency: 'EUR', item_code: 'kayak_rental__3_days', unit: 'day', location_id: 'sunset-somo' };
        return goodRule(args);
      },
    });
    assert.strictEqual(got.ok, true);
    assert.deepStrictEqual(calls, ['3_days']);
    assert.strictEqual(got.records[0].amount_due_cents, 12000);
    assert.strictEqual(got.records[0].metadata.pricing_mode, 'exact_duration_package');
    assert.strictEqual(got.records[0].metadata.package_repeat_count, 1);
  });
  await expect('missing multi-day package repeats selected 4-hour package once per calendar day', async () => {
    const calls = [];
    const got = await prepareGenericRentalsForCreate({
      ...base, rentals: [{ offering_key: 'kayak_rental', duration_key: '4_hours', quantity: 2 }],
      calendarDayCount: 3, bookingDurationKey: '3_days', listOfferings: loadCatalog,
      loadRule: async (args) => {
        calls.push(args.duration);
        if (args.duration === '3_days') return { status: 'not_found' };
        return { status: 'found', amount_cents: 2500, currency: 'EUR', item_code: 'kayak_rental__4_hours', unit: 'session', location_id: 'sunset-somo' };
      },
    });
    assert.strictEqual(got.ok, true);
    assert.deepStrictEqual(calls, ['3_days', '4_hours']);
    assert.strictEqual(got.records[0].amount_due_cents, 15000);
    assert.strictEqual(got.records[0].metadata.duration_key, '4_hours');
    assert.strictEqual(got.records[0].metadata.pricing_mode, 'repeated_base_package');
    assert.strictEqual(got.records[0].metadata.package_repeat_count, 3);
    const quote = buildGenericRentalAuthoritativeQuote(got.records);
    assert.strictEqual(quote.total_cents, 15000);
    assert.strictEqual(quote.line_items[0].package_repeat_count, 3);
  });
  await expect('unknown and deactivated catalog offerings fail closed', async () => {
    for (const rows of [[], [{ ...catalog[0], active: false }]]) {
      const got = await prepareGenericRentalsForCreate({ ...base, listOfferings: async () => rows, loadRule: goodRule });
      assert.strictEqual(got.ok, false); assert.strictEqual(got.reason, 'rental_offering_not_active');
    }
  });
  await expect('missing and mismatched prices fail closed', async () => {
    for (const loadRule of [async () => ({ status: 'not_found' }), async () => ({ status: 'found', amount_cents: 2500, item_code: 'kayak_rental__full_day', unit: 'session' })]) {
      const got = await prepareGenericRentalsForCreate({ ...base, listOfferings: loadCatalog, loadRule });
      assert.strictEqual(got.ok, false); assert.ok(['price_not_found', 'price_scope_mismatch'].includes(got.reason));
    }
  });
  await expect('canonical rentals are untouched and do not query generic authority', async () => {
    let calls = 0; const got = await prepareGenericRentalsForCreate({ ...base, rentals: [{ offering_key: 'board_rental', duration_key: '1_day', quantity: 1 }], listOfferings: async () => { calls += 1; return []; }, loadRule: goodRule });
    assert.deepStrictEqual(got, { ok: true, records: [], genericRentals: [] }); assert.strictEqual(calls, 0);
  });
  await expect('resolver records become an authoritative generic-only quote', async () => {
    const prepared = await prepareGenericRentalsForCreate({ ...base, listOfferings: loadCatalog, loadRule: goodRule });
    const quote = buildGenericRentalAuthoritativeQuote(prepared.records);
    assert.strictEqual(quote.total_cents, 5000);
    assert.deepStrictEqual(quote.line_items.map((l) => ({ component: l.component, key: l.offering_id, item: l.offering_item_code, total: l.total_cents })), [
      { component: 'addon_service', key: 'kayak_rental', item: 'kayak_rental__half_day', total: 5000 },
    ]);
  });
  await expect('generic addon rows claim only their exact offering and item code', async () => {
    const updates = [];
    const pg = { query: async (_sql, args) => { updates.push(args); return { rowCount: 1 }; } };
    const rows = [
      { service_record_id: 'a', service_type: 'addon_service', metadata: { rental_offering: true, offering_key: 'kayak_rental', item_code: 'kayak_rental__half_day', unit_cents: 2500 } },
      { service_record_id: 'b', service_type: 'addon_service', metadata: { rental_offering: true, offering_key: 'bike_rental', item_code: 'bike_rental__full_day', unit_cents: 3000 } },
    ];
    const quote = buildGenericRentalAuthoritativeQuote([
      { ...rows[0], quantity: 2, amount_due_cents: 5000 },
      { ...rows[1], quantity: 1, amount_due_cents: 3000 },
    ]);
    const got = await applyAuthoritativeQuoteAmounts(pg, rows, quote, { clientSlug: 'sunset' });
    assert.deepStrictEqual(got, { ok: true, total_cents: 8000, applied_line_total_cents: 8000 });
    assert.deepStrictEqual(updates.map((x) => x[0]).sort((a, b) => a - b), [3000, 5000]);
  });
  await expect('duplicate generic offering-duration identities fail closed before price lookup', async () => {
    let priceCalls = 0;
    const got = await prepareGenericRentalsForCreate({
      ...base,
      rentals: [base.rentals[0], { ...base.rentals[0], quantity: 1 }],
      listOfferings: loadCatalog,
      loadRule: async (args) => { priceCalls += 1; return goodRule(args); },
    });
    assert.deepStrictEqual(got, { ok: false, reason: 'duplicate_rental_offering' });
    assert.strictEqual(priceCalls, 0);
  });
  await expect('generic rental intent changes produce a different idempotency fingerprint', async () => {
    const input = { guest_name: 'Smoke', guest_phone: '+346****0002', service_dates: ['2026-08-01'], components: {} };
    const one = buildScheduleBookingIntentFingerprint(input, 'sunset-somo', {
      rentals: [{ offering_key: 'kayak_rental', duration_key: 'half_day', quantity: 1 }],
    });
    const two = buildScheduleBookingIntentFingerprint(input, 'sunset-somo', {
      rentals: [{ offering_key: 'kayak_rental', duration_key: 'half_day', quantity: 2 }],
    });
    assert.notStrictEqual(one, two);
  });
  await expect('staff quote and create are wired for rental-only and mixed generic records', async () => {
    const apiSrc = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
    const writesSrc = fs.readFileSync(require.resolve('./lib/sunset-schedule-booking-writes'), 'utf8');
    const browserSrc = fs.readFileSync(require.resolve('./browser/sunset-schedule-portal-module'), 'utf8');
    assert.match(apiSrc, /handleSunsetScheduleBookingQuote[\s\S]*prepareGenericRentalsForCreate[\s\S]*hasClosedVerticalIntent[\s\S]*buildQuoteProvenance/);
    assert.match(writesSrc, /for \(const descriptor of genericPrep\.records\)[\s\S]*insertServiceRecord/);
    assert.match(writesSrc, /genericRentalRecords: genericPrep\.records/);
    assert.match(writesSrc, /buildScheduleBookingIntentFingerprint\(input, locationId, intentFpOpts\)/);
    assert.doesNotMatch(browserSrc, /known\.indexOf\(off\) < 0/);
  });
  if (previousGenericRentalCreate === undefined) delete process.env.GENERIC_RENTAL_CREATE_ENABLED;
  else process.env.GENERIC_RENTAL_CREATE_ENABLED = previousGenericRentalCreate;
  console.log(`verify:generic-rental-create-wiring — ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
