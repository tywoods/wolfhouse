'use strict';

const assert = require('node:assert/strict');
const defaultApi = require('./index');
const v3Operations = require('./v3-operations');

const rooms = [
  { room_id: 'r10', room_code: 'R10', room_name: 'Room 10', room_type: 'shared', selling_mode: 'shared', capacity: 2, fill_priority: 1, room_sort_order: 1, gender_strategy: 'mixed', bed_id: 'b10a', bed_code: 'R10-B1', bed_label: '1', bed_number: 1, bed_active: true, bed_sellable: true },
  { room_id: 'r10', room_code: 'R10', room_name: 'Room 10', room_type: 'shared', selling_mode: 'shared', capacity: 2, fill_priority: 1, room_sort_order: 1, gender_strategy: 'mixed', bed_id: 'b10b', bed_code: 'R10-B2', bed_label: '2', bed_number: 2, bed_active: true, bed_sellable: true },
  { room_id: 'r7', room_code: 'R7', room_name: 'Room 7', room_type: 'shared', selling_mode: 'shared', capacity: 1, fill_priority: 2, room_sort_order: 2, gender_strategy: 'mixed', bed_id: 'b7a', bed_code: 'R7-B1', bed_label: '1', bed_number: 1, bed_active: true, bed_sellable: true },
];
const seasons = [{ id: 's1', code: 'summer', label: 'Summer', priority: 1, bookable: true, active: true, sort_order: 1, ranges: [{ start_month: 1, start_day: 1, end_month: 12, end_day: 31 }], source: 'db' }];
const items = [
  { id: 'i1', item_type: 'package', item_code: 'malibu', label: 'Malibu', metadata: { includes: ['stay', 'surf'], min_days: 7 }, active: true, sort_order: 1, source: 'db' },
  { id: 'i2', item_type: 'policy', item_code: 'package_min_nights', label: 'Minimum nights', metadata: { minimum_nights: 7 }, active: true, sort_order: 2, source: 'db' },
  { id: 'i3', item_type: 'rental', item_code: 'wetsuit_soft_top_combo', label: 'Wetsuit + Soft board combo', metadata: {}, active: true, sort_order: 3, source: 'db' },
];
const rules = [
  { id: 'p1', item_type: 'package', item_code: 'malibu', season_code: 'summer', unit: 'per_person_per_week', amount_cents: 50000, currency: 'EUR', active: true, source: 'db' },
  { id: 'd1', item_type: 'deposit', item_code: 'standard_package', season_code: null, unit: 'per_person', amount_cents: 10000, currency: 'EUR', active: true, source: 'db' },
  { id: 'd2', item_type: 'deposit', item_code: 'custom_or_short_stay', season_code: null, unit: 'per_person', amount_cents: 5000, currency: 'EUR', active: true, source: 'db' },
  { id: 'r1', item_type: 'rental', item_code: 'wetsuit_soft_top_combo', season_code: null, unit: 'per_day', amount_cents: 1500, currency: 'EUR', active: true, source: 'db' },
];

function staffPg({ blocks = [], pricingDown = false } = {}) {
  const observations = [];
  return {
    observations,
    async query(sql, params) {
      observations.push({ sql, params });
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)/.test(sql)) return { rows: [] };
      if (/FROM rooms r/.test(sql)) return { rows: rooms };
      if (/FROM booking_beds bb/.test(sql)) return { rows: blocks };
      if (/FROM luna_v3_hold_beds hb/.test(sql)) return { rows: [] };
      if (/FROM wh_pricing_seasons s/.test(sql)) {
        if (pricingDown) throw new Error('pricing unavailable');
        return { rows: seasons };
      }
      if (/FROM wh_pricing_rules/.test(sql)) return { rows: rules };
      if (/FROM wh_pricing_items/.test(sql)) return { rows: items };
      if (/FROM wh_pricing_transfer_rules/.test(sql)) return { rows: [] };
      if (/FROM luna_v3_sessions/.test(sql)) return { rows: [{ id: 'session-id', client_id: 'client-id', write_admitted: true }] };
      if (/INSERT INTO luna_v3_selections/.test(sql)) return { rows: [] };
      if (/INSERT INTO luna_v3_operations/.test(sql)) return { rows: [{ id: 'operation-id', request_fingerprint: params[3], receipt: null }] };
      if (/UPDATE luna_v3_operations/.test(sql)) return { rows: [] };
      throw new Error(`unexpected Staff query: ${sql.slice(0, 80)}`);
    },
  };
}

async function main(api = defaultApi) {
  assert.equal(
    v3Operations.nativeStaffReceiptHasTrustedProvenance({
      status: 'paid', amount_paid_cents: 1000, booking_guest_id: 'guest-1',
      metadata: { staff_portal: true, payment_scope: 'guest', booking_guest_id: 'guest-1', idempotency_key: 'missing-both' },
    }),
    false,
    'manual payment evidence rejects missing method and source',
  );
  assert.equal(
    v3Operations.nativeStaffReceiptHasTrustedProvenance({
      status: 'paid', amount_paid_cents: 1000, booking_guest_id: 'guest-1',
      metadata: { method: 'crypto', staff_portal: true, payment_scope: 'guest', booking_guest_id: 'guest-1', idempotency_key: 'unsupported-method' },
    }),
    false,
    'manual payment evidence rejects unsupported method with missing source',
  );
  const observations = {};
  const context = { tenantId: 'wolfhouse-somo', authenticated: true,
    sessionId: 'luna-v3:test', principalId: 'test-principal', writeAllowed: true };
  assert.deepEqual(Object.keys(api).sort(), ['checkAvailability', 'createOperations', 'findRooms', 'getPricingCatalog', 'quote',
    'holdBeds', 'book', 'getBooking', 'recoverOperation', 'releaseHold', 'handoffToHuman',
    'getPaymentStatus', 'sendPaymentLink', 'cancelUnpaid', 'readNotes', 'writeNote', 'saveTransferRequest'].sort());

  const pg = staffPg({ blocks: [{ bed_code: 'R7-B1' }] });
  const available = await api.checkAvailability(pg, { check_in: '2027-07-01', check_out: '2027-07-08', party_size: 2 }, context);
  assert.equal(available.availableCount, 2);
  assert.deepEqual(available.bedIds, ['R10-B1', 'R10-B2']);
  assert.equal(available.activeHoldInclusion, 'authoritative');
  assert(pg.observations.some((row) => /booking_beds/.test(row.sql)), 'uses Staff booking blocks query');

  const found = await api.findRooms(pg, { check_in: '2027-07-01', check_out: '2027-07-08', party_size: 2, preferences: { keep_together: true } }, context);
  assert.deepEqual(found.roomIds, ['R10']);
  assert.equal(found.selectedRoomId, null);
  assert.deepEqual(found.selectedBedIds, []);

  const catalog = await api.getPricingCatalog(pg, { check_in: '2027-07-01', check_out: '2027-07-08', package_ids: ['malibu'] }, context);
  assert.equal(catalog.ok, true);
  assert.equal(catalog.source, 'staff_pricing');
  assert.equal(catalog.items[0].metadata.includes[1], 'surf');
  assert.equal(catalog.rules.find((row) => row.item_code === 'malibu').amount_cents, 50000);

  const unavailable = await api.getPricingCatalog(staffPg({ pricingDown: true }), { check_in: '2027-07-01', check_out: '2027-07-08' }, context);
  assert.deepEqual(unavailable, { ok: false, status: 503, code: 'STAFF_PRICING_UNAVAILABLE' });

  await assert.rejects(() => api.quote(pg, {
    operation_key: 'quote-bad', check_in: '2027-07-01', check_out: '2027-07-08', guests: [{ name: 'A' }, { name: 'B' }],
    selection: { selected_bed_codes: ['R10-B1', 'R10-B2'], totalCents: 1 }, guest_packages: [], add_ons: [],
  }, context), /authority field|unknown field/);
  await assert.rejects(() => api.checkAvailability(pg, { check_in: '2027-07-01', check_out: '2027-07-08', party_size: 2, surprise: true }, context), /unknown field/);
  await assert.rejects(() => api.checkAvailability(pg, { check_in: '2027-07-01', check_out: '2027-07-08', party_size: 2 }), /trusted Wolfhouse context/);

  const quoted = await api.quote(staffPg(), {
    operation_key: 'quote-good', check_in: '2027-07-01', check_out: '2027-07-08', guests: [{ name: 'A' }, { name: 'B' }],
    selection: { selected_bed_codes: ['R10-B1', 'R10-B2'], room_type: 'shared', keep_together: true },
    package_id: 'malibu', guest_packages: [{ guest_number: 1, package_code: 'malibu' }, { guest_number: 2, package_code: 'malibu' }], add_ons: [],
  }, context);
  assert.equal(quoted.ok, true, JSON.stringify(quoted));
  assert.equal(quoted.source, 'staff_pricing');
  assert(Number.isSafeInteger(quoted.totalCents) && quoted.totalCents > 0);
  assert(Number.isSafeInteger(quoted.depositCents) && quoted.depositCents > 0);
  assert(Number.isSafeInteger(quoted.remainingCents));

  const shortStayRental = await api.quote(staffPg(), {
    operation_key: 'quote-short-rental', check_in: '2027-07-01', check_out: '2027-07-06', guests: [{ name: 'Tom' }],
    selection: { selected_bed_codes: ['R10-B1'], room_type: 'shared' },
    add_ons: [{ code: 'wetsuit_soft_top_combo', days: 3, quantity: 1 }],
  }, context);
  assert.equal(shortStayRental.ok, true, JSON.stringify(shortStayRental));
  assert.equal(shortStayRental.totalCents, 42000, 'accommodation-only 5-night stay plus three rental days');
  assert.equal(shortStayRental.depositCents, 5000, 'short stay uses Staff custom deposit tier');
  assert(shortStayRental.lineItems.some((row) => row.code === 'wetsuit_soft_top_combo' && row.total_cents === 4500));
  observations.staffComputedMoney = true;
  observations.toolCheckAvailability = true;
  observations.toolFindRooms = true;
  observations.toolGetPricingCatalog = true;
  console.log('cards 1-4 Staff service observations passed');
  return { observations };
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error); process.exit(1); });
}
module.exports = { main };
