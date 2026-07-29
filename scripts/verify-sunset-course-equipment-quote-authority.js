'use strict';

/**
 * Stage 4A — course-owned multi-item equipment quote authority.
 * Exercises real luna-front-desk-quote-service Group + Private paths
 * (offering_id + components/schedule) — not helper-only pricing.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildSunsetQuoteCommand,
  executeSunsetQuoteSync,
  QUOTE_CHANNELS,
} = require('./lib/luna-front-desk-quote-service');
const { packPriceItemCode } = require('./lib/sunset-admin-price-identity');

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_TIER = '2_days';
const GROUP_ITEM = packPriceItemCode(GROUP_ID, GROUP_TIER);
const GROUP_UNIT = 4000;
const PRIVATE_UNIT = 6000;
const FIXED_NOW = new Date('2026-07-28T12:00:00Z');

const RENTALS_SOMO = [
  { offering_key: 'softboard', label: 'Softboard', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'carbon_fins', label: 'Carbon Fins', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'same_label_a', label: 'Twin Label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'same_label_b', label: 'Twin Label', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'no_price_row', label: 'No Standalone Price', active: true, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'inactive_rental', label: 'Inactive', active: false, client_slug: 'sunset', location_id: 'sunset-somo' },
  { offering_key: 'foreign_location', label: 'Sardinero Only', active: true, client_slug: 'sunset', location_id: 'sunset-sardinero' },
  { offering_key: 'foreign_tenant', label: 'Foreign Tenant', active: true, client_slug: 'other', location_id: 'sunset-somo' },
];
const RENTALS_SARDINERO = RENTALS_SOMO.map((row) => ({
  ...row,
  location_id: row.location_id === 'sunset-somo' ? 'sunset-sardinero'
    : row.location_id === 'sunset-sardinero' ? 'sunset-somo'
      : row.location_id,
}));

const SOMO_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 1000 },
  { offering_key: 'carbon_fins', equipment_price_cents: 200, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_a', equipment_price_cents: 111, all_day_surcharge_cents: 0 },
  { offering_key: 'same_label_b', equipment_price_cents: 222, all_day_surcharge_cents: 0 },
  { offering_key: 'no_price_row', equipment_price_cents: 333, all_day_surcharge_cents: 0 },
];
const SARDINERO_OPTIONS = [
  { offering_key: 'softboard', equipment_price_cents: 700, all_day_surcharge_cents: 300 },
  { offering_key: 'carbon_fins', equipment_price_cents: 250, all_day_surcharge_cents: 50 },
];

function adminCfg(locationId, opts = {}) {
  const options = locationId === 'sunset-sardinero' ? SARDINERO_OPTIONS : SOMO_OPTIONS;
  const rentals = locationId === 'sunset-sardinero' ? RENTALS_SARDINERO : RENTALS_SOMO;
  return {
    ok: true,
    source: 'db',
    currency: 'EUR',
    rental_offerings: rentals,
    surf_packs: [{
      pack_id: GROUP_ID,
      label: 'Verifier Group',
      active: true,
      group_size: 8,
      weekly: 'daily',
      schedules: ['0930_1130'],
      equipment_options: opts.groupOptions || options,
      price_tiers: [{ key: GROUP_TIER, label: '2 days', hours: 4, amount_cents: GROUP_UNIT }],
    }],
    prices: [{
      id: 'price-group',
      category: 'package',
      offering_key: GROUP_ITEM,
      item_code: GROUP_ITEM,
      amount_cents: GROUP_UNIT,
      unit: 'day',
      active: true,
      currency: 'EUR',
    }],
    private_lesson: {
      id: 'private-verify',
      enabled: true,
      label: 'Private Course',
      amount_cents: PRIVATE_UNIT,
      currency: 'EUR',
      price_basis: 'per_session',
      default_duration_minutes: 120,
      equipment_options: opts.privateOptions || options,
    },
  };
}

function quote(body, locationId, channel = QUOTE_CHANNELS.MANUAL_STAFF, cfg) {
  const built = buildSunsetQuoteCommand({
    channel,
    transportBody: body,
    trustedLocationId: locationId,
    now: FIXED_NOW,
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  return executeSunsetQuoteSync(built.command, { adminCfg: cfg || adminCfg(locationId) });
}

function groupComponentsBody(equipment, quantity = 4, dates = ['2026-09-01', '2026-09-02']) {
  return {
    guest_name: 'Quote Guest',
    date_from: dates[0],
    date_to: dates[dates.length - 1],
    service_dates: dates,
    payment_status: 'unpaid',
    components: { course: { course_id: GROUP_ID, tier_key: GROUP_TIER, quantity } },
    ...(equipment === undefined ? {} : { course_equipment: equipment }),
  };
}

function privateComponentsBody(equipment, surfers = 3, date = '2026-09-01') {
  return {
    guest_name: 'Private Guest',
    date_from: date,
    date_to: date,
    service_dates: [date],
    payment_status: 'unpaid',
    components: {
      private_lesson: {
        enabled: true,
        surfer_count: surfers,
        quantity: 1,
        sessions: [{ date, start: '10:00', end: '12:00' }],
      },
    },
    ...(equipment === undefined ? {} : { course_equipment: equipment }),
  };
}

function equipmentLines(body) {
  return (body.line_items || []).filter((line) => line.course_equipment === true);
}

function assertLineShape(line, expected) {
  assert.strictEqual(line.offering_key, expected.offering_key);
  assert.strictEqual(line.label, expected.label);
  assert.strictEqual(line.course_equipment_mode, expected.mode);
  assert.strictEqual(line.quantity, expected.quantity);
  assert.strictEqual(line.base_unit_cents, expected.base);
  assert.strictEqual(line.all_day_surcharge_unit_cents, expected.surcharge);
  assert.strictEqual(line.unit_amount_cents, expected.base + (expected.mode === 'all_day' ? expected.surcharge : 0));
  assert.strictEqual(line.total_cents, line.unit_amount_cents * expected.quantity);
  assert.strictEqual(line.billing_unit, 'person_per_course');
  assert.ok(!('component' in line) || !['surfboard', 'wetsuit'].includes(line.component),
    'must not hardcode Surfboard/Wetsuit components');
  assert.ok(!line.service_date, 'must not charge per course day');
}

// ── Group components (schedule quote path) ──────────────────────────
{
  const selection = [
    { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'all_day', quantity: 1 },
  ];
  const result = quote(groupComponentsBody(selection, 4), 'sunset-somo');
  assert.equal(result.ok, true, JSON.stringify(result.body));
  // Group 2-day unit × 4 surfers + equipment once (not × days): 16000 + 2*500 + 1*(200+0)
  assert.strictEqual(result.body.total_cents, 16000 + 1000 + 200, JSON.stringify(result.body));
  const lines = equipmentLines(result.body);
  assert.strictEqual(lines.length, 2);
  assertLineShape(lines.find((l) => l.offering_key === 'softboard'), {
    offering_key: 'softboard', label: 'Softboard', mode: 'during_course', quantity: 2, base: 500, surcharge: 1000,
  });
  assertLineShape(lines.find((l) => l.offering_key === 'carbon_fins'), {
    offering_key: 'carbon_fins', label: 'Carbon Fins', mode: 'all_day', quantity: 1, base: 200, surcharge: 0,
  });
  assert.deepStrictEqual(result.body.course_equipment, selection);
  assert.deepStrictEqual(result.body.quote_provenance.course_equipment, selection);
  // Multi-day booking must not multiply equipment by day count.
  assert.ok(lines.every((l) => !l.service_date));
  assert.ok(!JSON.stringify(result.body).includes('equipment_included'));
  assert.ok(!/admin_location_course_equipment|shared location|Surfboard|Wetsuit/.test(
    lines.map((l) => `${l.price_source}|${l.label}|${l.component || ''}`).join('|'),
  ));
}

// Zero selections
{
  const result = quote(groupComponentsBody([], 2), 'sunset-somo');
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.strictEqual(equipmentLines(result.body).length, 0);
  assert.deepStrictEqual(result.body.course_equipment, []);
  assert.strictEqual(result.body.total_cents, GROUP_UNIT * 2);
}

// Quantities 1 / 2 / 4 + 0 surcharge always selectable
{
  for (const qty of [1, 2, 4]) {
    const selection = [{ offering_key: 'carbon_fins', mode: 'all_day', quantity: qty }];
    const result = quote(groupComponentsBody(selection, 4), 'sunset-somo');
    assert.equal(result.ok, true, JSON.stringify(result.body));
    const line = equipmentLines(result.body)[0];
    assert.strictEqual(line.total_cents, qty * 200);
    assert.strictEqual(line.all_day_surcharge_unit_cents, 0);
  }
}

// Same-label distinct keys
{
  const selection = [
    { offering_key: 'same_label_a', mode: 'during_course', quantity: 1 },
    { offering_key: 'same_label_b', mode: 'during_course', quantity: 1 },
  ];
  const result = quote(groupComponentsBody(selection, 2), 'sunset-somo');
  assert.equal(result.ok, true, JSON.stringify(result.body));
  const lines = equipmentLines(result.body);
  assert.strictEqual(lines.find((l) => l.offering_key === 'same_label_a').total_cents, 111);
  assert.strictEqual(lines.find((l) => l.offering_key === 'same_label_b').total_cents, 222);
  assert.strictEqual(lines[0].label, 'Twin Label');
  assert.strictEqual(lines[1].label, 'Twin Label');
}

// No standalone rental price row still valid when active + configured
{
  const selection = [{ offering_key: 'no_price_row', mode: 'during_course', quantity: 1 }];
  const result = quote(groupComponentsBody(selection, 1), 'sunset-somo');
  assert.equal(result.ok, true, JSON.stringify(result.body));
  assert.strictEqual(equipmentLines(result.body)[0].total_cents, 333);
}

// Fail closed: duplicate / empty / invalid mode / qty / not configured / inactive / foreign
{
  const cases = [
    [{ offering_key: 'softboard', mode: 'during_course', quantity: 1 }, { offering_key: 'softboard', mode: 'all_day', quantity: 1 }],
    [{ offering_key: '', mode: 'during_course', quantity: 1 }],
    [{ offering_key: 'softboard', mode: 'half_day', quantity: 1 }],
    [{ offering_key: 'softboard', mode: 'during_course', quantity: 0 }],
    [{ offering_key: 'softboard', mode: 'during_course', quantity: 5 }],
    [{ offering_key: 'not_configured', mode: 'during_course', quantity: 1 }],
    [{ offering_key: 'inactive_rental', mode: 'during_course', quantity: 1 }],
    [{ offering_key: 'foreign_location', mode: 'during_course', quantity: 1 }],
    [{ offering_key: 'foreign_tenant', mode: 'during_course', quantity: 1 }],
    { mode: 'during_course', quantity: 1 }, // legacy singleton
  ];
  for (const equipment of cases) {
    const result = quote(groupComponentsBody(equipment, 4), 'sunset-somo');
    assert.equal(result.ok, false, JSON.stringify({ equipment, body: result.body }));
    assert.equal(result.body.reason, 'invalid_course_equipment', JSON.stringify(result.body));
  }
}

// Overflow fail closed
{
  const cfg = adminCfg('sunset-somo', {
    groupOptions: [{
      offering_key: 'softboard',
      equipment_price_cents: Number.MAX_SAFE_INTEGER,
      all_day_surcharge_cents: 1,
    }],
  });
  const result = quote(
    groupComponentsBody([{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }], 1),
    'sunset-somo',
    QUOTE_CHANNELS.MANUAL_STAFF,
    cfg,
  );
  assert.equal(result.ok, false);
  assert.equal(result.body.reason, 'invalid_course_equipment');
}

// Somo vs Sardinero isolation (server owns location cents)
{
  const selection = [{ offering_key: 'softboard', mode: 'all_day', quantity: 1 }];
  const somo = quote(groupComponentsBody(selection, 1), 'sunset-somo');
  const sard = quote(groupComponentsBody(selection, 1), 'sunset-sardinero');
  assert.equal(somo.ok, true, JSON.stringify(somo.body));
  assert.equal(sard.ok, true, JSON.stringify(sard.body));
  assert.strictEqual(equipmentLines(somo.body)[0].total_cents, 1500);
  assert.strictEqual(equipmentLines(sard.body)[0].total_cents, 1000);
  assert.notEqual(equipmentLines(somo.body)[0].total_cents, equipmentLines(sard.body)[0].total_cents);
}

// Never trust client cents / labels
{
  const poisoned = [{
    offering_key: 'softboard',
    mode: 'during_course',
    quantity: 1,
    equipment_price_cents: 1,
    label: 'Client Lie',
    total_cents: 1,
  }];
  const result = quote(groupComponentsBody(poisoned, 1), 'sunset-somo');
  assert.equal(result.ok, false, 'unknown selection fields must fail closed');
}

// ── Private components path ─────────────────────────────────────────
{
  const selection = [
    { offering_key: 'softboard', mode: 'during_course', quantity: 2 },
    { offering_key: 'carbon_fins', mode: 'all_day', quantity: 3 },
  ];
  const result = quote(privateComponentsBody(selection, 3), 'sunset-somo');
  assert.equal(result.ok, true, JSON.stringify(result.body));
  // private unit × 3 surfers + 2*500 + 3*200
  assert.strictEqual(result.body.total_cents, PRIVATE_UNIT * 3 + 1000 + 600, JSON.stringify(result.body));
  const lines = equipmentLines(result.body);
  assert.strictEqual(lines.length, 2);
  assertLineShape(lines.find((l) => l.offering_key === 'softboard'), {
    offering_key: 'softboard', label: 'Softboard', mode: 'during_course', quantity: 2, base: 500, surcharge: 1000,
  });
  assert.deepStrictEqual(result.body.course_equipment, selection);
}

// ── Offering_id Group + Private (Luna/staff offering quote) ──────────
{
  const selection = [{ offering_key: 'softboard', mode: 'all_day', quantity: 2 }];
  const groupOffering = quote({
    offering_id: GROUP_ITEM,
    course_id: GROUP_ID,
    quantity: 2,
    service_dates: ['2026-09-01', '2026-09-02'],
    course_equipment: selection,
  }, 'sunset-somo', QUOTE_CHANNELS.LUNA_WHATSAPP);
  assert.equal(groupOffering.ok, true, JSON.stringify(groupOffering.body));
  // once per course: 2 * 1500 equipment, not ×2 days
  assert.strictEqual(equipmentLines(groupOffering.body)[0].total_cents, 3000);
  assert.strictEqual(groupOffering.body.total_cents, GROUP_UNIT * 2 + 3000);

  const privateOffering = quote({
    offering_id: 'private_lesson__session',
    quantity: 2,
    service_dates: ['2026-09-01'],
    course_equipment: selection,
  }, 'sunset-somo', QUOTE_CHANNELS.LUNA_WHATSAPP);
  assert.equal(privateOffering.ok, true, JSON.stringify(privateOffering.body));
  assert.strictEqual(equipmentLines(privateOffering.body)[0].total_cents, 3000);
  assert.strictEqual(privateOffering.body.total_cents, PRIVATE_UNIT * 2 + 3000);
}

// Deactivated / removed from course options fail closed at quote time
{
  const cfg = adminCfg('sunset-somo', {
    groupOptions: [{ offering_key: 'softboard', equipment_price_cents: 500, all_day_surcharge_cents: 0 }],
  });
  const result = quote(
    groupComponentsBody([{ offering_key: 'carbon_fins', mode: 'during_course', quantity: 1 }], 1),
    'sunset-somo',
    QUOTE_CHANNELS.MANUAL_STAFF,
    cfg,
  );
  assert.equal(result.ok, false);
  assert.equal(result.body.reason, 'invalid_course_equipment');
}

// No legacy fallbacks on current quote path
{
  const src = fs.readFileSync(path.join(__dirname, 'lib/luna-front-desk-quote-service.js'), 'utf8');
  assert.ok(!/getCourseEquipmentPricing/.test(src), 'quote must not load shared location equipment pricing');
  assert.ok(!/equipment_included !== true/.test(src), 'quote must not gate on equipment_included');
  assert.ok(!/selection\.mode ===/.test(src), 'quote must not use singleton selection.mode');
  assert.ok(!/COMPONENTS|surfboard_cents|wetsuit_cents/.test(src), 'quote must not hardcode Surfboard/Wetsuit pricing');
  // schedule HTTP boundary still routes into the shared quote service
  const api = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.ok(/handleSunsetScheduleBookingQuote/.test(api));
  assert.ok(/quoteOffering|executeSunsetQuote|luna-front-desk-quote-service/.test(api));
}

console.log('verify:sunset-course-equipment-quote-authority — ALL CHECKS PASSED');
