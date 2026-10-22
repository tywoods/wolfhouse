'use strict';
// Synthetic inventory, real allocator. No live Staff, guest, or payment calls.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chooseBeds, chooseBedsCapacityOnly } = require('./lib/luna-bed-allocator');

function room(code, capacity, free, category, rank) {
  return {
    room_code: code, room_type: category, capacity,
    fill_policy: { roomId: code, capacity, unavailable: Array(10).fill(capacity - free.length), rank, mode: 'house' },
    beds: Array.from({ length: capacity }, (_, i) => ({ bed_code: `${code}-B${i + 1}`, available: free.includes(i + 1) })),
  };
}
function coupleRooms() {
  return [
    room('R1', 6, [], 'mixed', 3),
    room('R3', 4, [], 'matrimonial_or_mixed', 4),
    room('R7', 4, [2, 3, 4], 'operator_surfweek', 0),
    room('R9', 6, [3, 4, 5, 6], 'operator_surfweek', 1),
    room('R10', 6, [2, 3, 4, 5, 6], 'operator_surfweek', 2),
  ];
}

test('Ty Nov 5–15 two-person mixed/shared choice stays together before house overflow', () => {
  const rooms = coupleRooms();
  const before = JSON.stringify(rooms);
  const capacity = chooseBedsCapacityOnly({ rooms, guestCount: 2, roomPreference: 'shared' });
  assert.deepEqual(capacity.selected_bed_codes, ['R10-B2', 'R10-B3']);
  const selected = chooseBeds({ rooms, guestCount: 2, groupGender: 'unknown', roomPreference: 'mixed' });
  assert.equal(selected.split, false, JSON.stringify(selected));
  assert.deepEqual(selected.selected_bed_codes, ['R10-B2', 'R10-B3']);
  assert.equal(JSON.stringify(rooms), before, 'selection must not mutate inventory');
});

test('keep_together refuses split-only inventory independently of gender or room category', () => {
  const rooms = [room('R1', 2, [2], 'mixed', 0), room('R3', 2, [2], 'mixed', 1)];
  for (const select of [chooseBeds, chooseBedsCapacityOnly]) {
    const options = { rooms, guestCount: 2, roomPreference: 'mixed', groupGender: 'unknown' };
    assert.equal(select(options).split, true, 'without a hard requirement an alternative split can be offered');
    const selected = select({ ...options, keepTogether: true });
    assert.equal(selected.reason, 'same_room_unavailable');
    assert.deepEqual(selected.selected_bed_codes, [], 'refused split is not a bookable selection');
    assert.equal(selected.needs_clarification, true);
    assert.equal(select({ ...options, keepTogether: false }).split, true);
  }
});

const availabilityService = require('./lib/luna-front-desk-accommodation-availability-service');
function inventory(rooms, extra = {}, blockRows = [], assignmentMode = false) {
  const rows = rooms.flatMap(r => r.beds.map(b => ({
    ...r, ...b, bed_active: true, bed_sellable: true,
  })));
  const blocks = [...blockRows, ...rows.filter(b => !b.available).map(b => ({ bed_code: b.bed_code, room_code: b.room_code }))];
  const built = availabilityService.buildWolfhouseAvailabilityCommand({
    channel: 'bot_http', trustedClientSlug: 'wolfhouse-somo', assignmentMode,
    transportBody: { check_in: '2026-11-05', check_out: '2026-11-15', guest_count: 2,
      room_type: 'shared', room_preference: 'mixed', ...extra },
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  const result = availabilityService.computeWolfhouseAvailabilityInventory(rows, blocks, built.command,
    new Map(rooms.map(r => [r.room_code, r.fill_policy])));
  return availabilityService.buildCanonicalAvailabilityBody(built.command, result, null);
}

test('Staff availability preserves stay-together, discloses split-only stock and never calls it gender intake', () => {
  for (const assignment of [false, true]) {
    const together = inventory(coupleRooms(), { keep_together: true }, [], assignment);
    assert.equal(together.keep_together, true);
    assert.equal(together.allocation_split, false);
    assert.deepEqual(together.selected_bed_codes, ['R10-B2', 'R10-B3']);
    assert.equal(together.group_gender, 'unknown');
    const split = inventory([room('R1', 2, [2], 'mixed', 0), room('R3', 2, [2], 'mixed', 1)],
      { keep_together: true }, [], assignment);
    assert.deepEqual(split.selected_bed_codes, []);
    assert.equal(split.allocation_reason, 'same_room_unavailable');
    assert.equal(split.domain_next_action, 'explain_split_or_alternate_dates');
    assert.ok(split.warnings.includes('group_split_across_rooms_required'));
    assert.ok(split.blockers.includes('same_room_unavailable'));
  }
});

test('Staff exact-bed recheck refuses stale, blocked, private, or incompatible beds, preserving accepted order', () => {
  const selection = { keep_together: true, selected_bed_codes: ['R7-B3', 'R7-B2'] };
  assert.deepEqual(inventory(coupleRooms(), selection).selected_bed_codes, selection.selected_bed_codes);
  for (const block of [
    { bed_code: 'R7-B2', room_code: 'R7', assignment_type: 'guest' },
    { bed_code: 'R7-B4', room_code: 'R7', assignment_type: 'operator_block' },
  ]) {
    const result = inventory(coupleRooms(), selection, [block]);
    assert.deepEqual(result.selected_bed_codes, []);
    assert.equal(result.exact_bed_eligibility.eligible, false);
    assert.ok(result.blockers.includes('availability_changed'));
  }
  const refused = inventory(coupleRooms(), { ...selection, selected_bed_codes: ['R7-B2', 'R10-B2'] });
  assert.deepEqual(refused.selected_bed_codes, []);
  assert.ok(refused.blockers.includes('same_room_unavailable'));
  for (const category of ['female_only', 'male_only', 'matrimonial_private_couple']) {
    const rooms = [room('R7', 2, [1,2], category, 0)];
    const result = inventory(rooms, { keep_together: true, guests: [{ name: 'Emma' }, { name: 'Marco' }],
      selected_bed_codes: ['R7-B1', 'R7-B2'] });
    assert.equal(result.exact_bed_eligibility.eligible, false, category);
  }
});

const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const createService = require('./lib/luna-front-desk-accommodation-booking-create-service');
const deny = () => { throw new Error('Network forbidden: offline keep-together proof'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const transport of ['node:http', 'node:https']) {
  require(transport).request = deny; require(transport).get = deny;
}
globalThis.fetch = deny;
const party = {
  check_in: '2026-11-05', check_out: '2026-11-15', guest_count: 2,
  room_type: 'shared', room_preference: 'mixed', keep_together: true,
  package_code: 'package_none', confirm: true, guest_name: 'Offline Together A',
  guests: [{ name: 'Offline Together A' }, { name: 'Offline Together B' }],
  phone: '+999****2107', payment_choice: 'full',
};
async function dbFixture() {
  const db = new PGlite();
  await seedOfflineBookingDb(db, party);
  await db.exec(`ALTER TABLE clients ADD settings jsonb DEFAULT '{}';
    UPDATE rooms SET active = room_code IN ('R7','R10');
    UPDATE rooms SET room_type='operator_surfweek',gender_strategy='Flexible',capacity=2,
      can_be_matrimonial=false,often_used_by_operator=true,selling_mode='shared' WHERE active;
    UPDATE beds SET active=bed_number IN (2,3) WHERE room_id IN (SELECT id FROM rooms WHERE active);`);
  const routes = require('./lib/staff-room-fill-routes').createRoomFillRoutes({
    withPgClient: fn => fn(db), readBody: async req => JSON.stringify(req.body),
    appendAuditLog: () => {}, sendJSON: (_res, status, body) => ({ status, body }),
  });
  const user = { ...(await db.query("SELECT id AS client_id,slug AS client_slug FROM clients WHERE slug='wolfhouse-somo'")).rows[0], role: 'operator', staff_user_id: 'offline' };
  const current = await routes.handleRoomFillGet({}, {}, {}, user);
  assert.equal(current.status, 200);
  const saved = await routes.handleRoomFillPut({}, { headers: { host: 'staff.invalid', origin: 'https://staff.invalid' },
    body: { contractVersion: 1, fillMode: 'house', roomPrioritySource: 'custom',
      roomPriority: current.body.catalogue.map(room => room.roomId),
      expectedSettingsRevision: current.body.settingsRevision, expectedCatalogRevision: current.body.catalogRevision } }, {}, user);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  return db;
}
async function build(db, extra = {}) {
  return createService.buildWolfhouseBookingCreateCommand({ channel: 'luna_whatsapp',
    trustedClientSlug: 'wolfhouse-somo', transportBody: { ...party, ...extra }, pgClient: db });
}
async function snapshot(db) {
  const counts = {};
  for (const table of ['bookings', 'booking_guests', 'booking_beds', 'payments'])
    counts[table] = (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return counts;
}

test('real offline SQL: Ty dates commit both named occupants into one shared room', async () => {
  const db = await dbFixture();
  try {
    const built = await build(db);
    assert.equal(built.ok, true, JSON.stringify(built));
    const result = await createService.executeWolfhouseBookingCreate(db, built.command,
      { stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const occupants = (await db.query('SELECT guest_name,assigned_bed_code FROM booking_guests WHERE booking_id=$1 ORDER BY guest_number', [result.body.booking_id])).rows;
    assert.deepEqual(occupants.map(row => row.guest_name), party.guests.map(row => row.name));
    const rooms = new Set(occupants.map(row => row.assigned_bed_code.split('-')[0]));
    assert.equal(rooms.size, 1, JSON.stringify(occupants));
    assert.ok(['R7', 'R10'].includes([...rooms][0]));
    console.log('OFFLINE_SYNTHETIC_SQL', JSON.stringify(occupants));
  } finally { await db.close(); }
});

test('real offline SQL: refused split and stale accepted beds create no rows', async () => {
  const db = await dbFixture();
  try {
    const before = await snapshot(db);
    const explicit = await build(db, { selected_bed_codes: ['R7-B2', 'R10-B2'] });
    assert.equal(explicit.ok, false);
    assert.equal(explicit.body.reason_code, 'same_room_unavailable');
    assert.deepEqual(await snapshot(db), before);
    const together = await build(db, { selected_bed_codes: ['R7-B3', 'R7-B2'] });
    assert.equal(together.ok, true, JSON.stringify(together));
    await db.exec("UPDATE beds SET active=false WHERE bed_code='R7-B2'");
    const stale = await createService.executeWolfhouseBookingCreate(db, together.command,
      { stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(stale.ok, false);
    assert.deepEqual(await snapshot(db), before);
    await db.exec("UPDATE beds SET active=false WHERE bed_code='R10-B2'");
    const noSameRoom = await build(db);
    assert.equal(noSameRoom.ok, false, JSON.stringify(noSameRoom));
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test('invalid keep-together types cannot admit exact-bed create or replay; zero SQL writes', async () => {
  const db = await dbFixture();
  try {
    const before = await snapshot(db);
    for (const bad of [null, 'true', 'false', 0, 1, [], {}]) {
      const result = await build(db, { keep_together: bad, selected_bed_codes: ['R7-B2', 'R10-B2'] });
      assert.equal(result.ok, false, JSON.stringify({ bad, result }));
      assert.equal(result.body.reason_code, 'invalid_keep_together');
      assert.deepEqual(await snapshot(db), before);
    }
  } finally { await db.close(); }
});

test('Staff offer identity binds keep-together independently of selected beds', () => {
  const base = { client_slug: 'wolfhouse-somo', check_in: '2026-11-05', check_out: '2026-11-15',
    guest_count: 2, room_type: 'shared', room_preference: 'mixed',
    guest_bed_assignments: [{guest_index: 0, bed_code: 'R7-B2'}, {guest_index: 1, bed_code: 'R7-B3'}],
    room_arrangement: [{ bed_code: 'R7-B2', room_code: 'R7' }, { bed_code: 'R7-B3', room_code: 'R7' }],
    availability_checked: true, total_cents: 80000, currency: 'EUR' };
  const together = availabilityService.buildWolfhouseOfferRevision({ ...base, keep_together: true });
  const separable = availabilityService.buildWolfhouseOfferRevision({ ...base, keep_together: false });
  assert.equal(together.keep_together, true);
  assert.equal(availabilityService.compareAcceptedWolfhouseOffer(together, separable).ok, false);
});

test('locked room membership rejects a split introduced after preflight without offer identity', async () => {
  for (const explicit of [false, true]) {
    const db = await dbFixture();
    try {
      const before = await snapshot(db);
      const built = await build(db, explicit ? { selected_bed_codes: ['R7-B2', 'R7-B3'] } : {});
      assert.equal(built.ok, true, JSON.stringify(built));
      let injected = false;
      const pg = { query: async (sql, args) => {
        const result = await db.query(sql, args);
        if (sql === 'BEGIN') {
          // Deterministic race injection after the unlocked checks. All room
          // membership and locked reads still come from the real SQL database.
          await db.query("UPDATE beds SET room_id=(SELECT id FROM rooms WHERE room_code='R10') WHERE bed_code='R7-B3'");
          injected = true;
        }
        return result;
      }};
      const result = await createService.executeWolfhouseBookingCreate(pg, built.command,
        { stripeConfig: { stripeLinksEnabled: false } });
      assert.equal(injected, true);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.body.reason_code, 'same_room_unavailable');
      assert.deepEqual(await snapshot(db), before);
    } finally { await db.close(); }
  }
});

test('retry fingerprint binds keep-together and rejects changed-constraint recovery', async () => {
  const unchanged = { ...party, selected_bed_codes: ['R7-B2', 'R7-B3'], idempotency_key: 'offline-keep-retry' };
  assert.notEqual(createService.wolfhouseOperationFingerprint(unchanged),
    createService.wolfhouseOperationFingerprint({ ...unchanged, keep_together: false }));
  const db = await dbFixture();
  try {
    const built = await build(db, unchanged);
    assert.equal(built.ok, true, JSON.stringify(built));
    const first = await createService.executeWolfhouseBookingCreate(db, built.command,
      { stripeConfig: { stripeLinksEnabled: false } });
    assert.equal(first.ok, true, JSON.stringify(first));
    const before = await snapshot(db);
    const retry = await build(db, unchanged);
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.recovered, true);
    assert.equal(retry.body.booking_id, first.body.booking_id);
    for (const bad of [null, 'true', 'false', 0, 1, [], {}]) {
      const invalidRetry = await build(db, { ...unchanged, keep_together: bad });
      assert.equal(invalidRetry.ok, false);
      assert.equal(invalidRetry.body.reason_code, 'invalid_keep_together');
      assert.deepEqual(await snapshot(db), before);
    }
    const changed = await build(db, { ...unchanged, keep_together: false });
    assert.equal(changed.ok, false, JSON.stringify(changed));
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
});

test('ordinary quote HTTP handler carries keep-together into the checked offer', async () => {
  const db = await dbFixture();
  try {
    const vm = require('node:vm');
    const fs = require('node:fs');
    const context = {};
    for (const lib of ['bot-booking-package-normalize', 'staff-manual-booking-payment',
      'staff-manual-booking-create-sql', 'staff-booking-portal-policy', 'wolfhouse-room-options',
      'wolfhouse-quote-calculator', 'guest-addon-pricing', 'bot-quote-included-items',
      'wolfhouse-package-night-rules', 'booking-guests', 'staff-bed-calendar-queries'])
      Object.assign(context, require('./lib/' + lib));
    let requestBody = { ...party, selected_bed_codes: ['R7-B2', 'R7-B3'] };
    Object.assign(context, availabilityService, createService, {
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true, DEFAULT_CLIENT: 'wolfhouse-somo',
      appendAuditLog() {}, readBody: async () => JSON.stringify(requestBody),
      resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
      loadWolfhouseQuoteConfigWithOverlay: () => createService.loadBookingQuoteConfigWithOverlay(db),
      withPgClient: fn => fn(db), sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
    });
    const source = fs.readFileSync(require.resolve('./staff-query-api'), 'utf8');
    const start = source.indexOf('const BOT_BOOKING_REQUIRED_FIELDS = [');
    const preview = source.indexOf('async function handleBotBookingPreview(req, res, user, authMode) {');
    assert.ok(start >= 0 && preview > start);
    vm.createContext(context);
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', preview) + 2), context);
    const result = await context.handleBotBookingPreview({}, {}, null, 'offline');
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.offer_revision?.keep_together, true, JSON.stringify(result));
    requestBody = { ...party, selected_bed_codes: ['R7-B2', 'R10-B2'] };
    const refused = await context.handleBotBookingPreview({}, {}, null, 'offline');
    assert.equal(refused.body.offer_revision, null, JSON.stringify(refused));
  } finally { await db.close(); }
});

module.exports = { room, coupleRooms };
