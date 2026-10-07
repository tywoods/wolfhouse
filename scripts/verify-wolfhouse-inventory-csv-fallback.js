'use strict';

// Offline regression: node --test scripts/verify-wolfhouse-inventory-csv-fallback.js
// Optional CSV_PROOF_DIR writes observed SQL/handler results, including on failure.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PGlite } = require('@electric-sql/pglite');
const inventory = require('./lib/wolfhouse-inventory-source');
const queries = require('./lib/staff-bed-calendar-queries');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const { resolveRoomCategory } = require('./lib/staff-portal-room-label');
const { resolveBedCalendarRoomRows: resolve } = inventory;
const SLUG = 'wolfhouse-somo';
const CLIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';
const csvRows = inventory.csvInventoryToBedCalendarRows(inventory.loadWolfhouseInventoryFromCsv());

function canonicalRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    room_id: R3, room_code: 'R3', room_name: 'Canonical Room 3', house: 'Canonical house',
    room_type: 'female_only', capacity: count, room_sort_order: 83, fill_priority: 71,
    gender_strategy: 'Female preferred', can_be_matrimonial: false, often_used_by_operator: true,
    bed_id: `bbbbbbbb-bbbb-4bbb-8bbb-${String(i + 1).padStart(12, '0')}`,
    bed_code: `R3-B${i + 1}`, bed_label: `Canonical bed ${i + 1}`, bed_number: i + 1,
    bed_planning_label: `Canonical planning ${i + 1}`, bed_active: true, bed_sellable: i !== 0,
  }));
}

for (const count of [6, 2]) {
  test(`reduced CSV overlap preserves exactly ${count} canonical R3 beds and all metadata`, () => {
    assert.equal(csvRows.filter(row => row.room_code === 'R3').length, 4, 'fixture must overlap four CSV beds');
    const pgRows = canonicalRows(count);
    const before = structuredClone(pgRows);
    const resolved = resolve(SLUG, pgRows);
    const actual = resolved.filter(row => row.room_code === 'R3');
    assert.equal(actual.length, count, 'CSV must neither drop saved beds nor invent ghost beds');
    assert.deepEqual(actual, pgRows, 'canonical UUIDs, labels, restrictions and ordering must survive');
    assert.deepEqual(pgRows, before, 'resolver must not mutate canonical input');
    assert.deepEqual(resolved.filter(row => row.room_code !== 'R3'), csvRows.filter(row => row.room_code !== 'R3'));
  });
}

test('canonical room with no active beds must not acquire CSV beds', () => {
  const row = { ...canonicalRows(1)[0], bed_id: null, bed_code: null, bed_label: null,
    bed_number: null, bed_planning_label: null, bed_active: null, bed_sellable: null };
  assert.deepEqual(resolve(SLUG, [row]).filter(r => r.room_code === 'R3'), [row]);
});

test('CSV remains the fallback for entirely absent rooms; demo rooms stay excluded', () => {
  assert.deepEqual(resolve(SLUG, []), csvRows);
  const demo = { ...canonicalRows(1)[0], room_code: 'DEMO-R3', bed_code: 'DEMO-R3-B1' };
  assert.deepEqual(resolve(SLUG, [demo]), csvRows);
});

test('PG-only room survives alongside absent-room CSV fallback', () => {
  const rows = canonicalRows(2).map(row => ({ ...row, room_code: 'R11', bed_code: row.bed_code.replace('R3', 'R11') }));
  const resolved = resolve(SLUG, rows);
  assert.deepEqual(resolved.filter(row => row.room_code === 'R11'), rows);
  assert.deepEqual(resolved.filter(row => row.room_code !== 'R11'), csvRows);
});

test('complete canonical catalogue bypasses fallback at the existing threshold', () => {
  const rows = Array.from({ length: inventory.MIN_REAL_ROOMS }, (_, i) => ({
    ...canonicalRows(1)[0], room_code: `R${i + 1}`, bed_code: `R${i + 1}-B1`,
  }));
  const demo = { ...rows[0], room_code: 'DEMO-R1' };
  assert.deepEqual(resolve(SLUG, rows.concat(demo)), rows);
});

test('non-Wolfhouse inventory is returned unchanged, including demo rows', () => {
  const rows = canonicalRows(2).concat({ room_code: 'DEMO-R1', bed_id: null });
  assert.strictEqual(resolve('sunset', rows), rows);
  assert.strictEqual(resolve('another-client', rows), rows);
  assert.deepEqual(resolve('sunset', null), []);
});

// Same minimal schema used by the existing inventory SQL verifier; no live DB.
const verifier = fs.readFileSync(path.join(__dirname, 'verify-staff-room-fill-inventory.js'), 'utf8');
const schemaMatch = verifier.match(/const SCHEMA = `([\s\S]*?)`;/);
assert.ok(schemaMatch, 'existing inventory verifier schema must be available');
const schema = schemaMatch[1].replace('gender_strategy TEXT,', 'gender_strategy TEXT NOT NULL,');
const apiSource = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
function sourceFunction(name) {
  const start = apiSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `actual calendar function ${name} must exist`);
  const end = apiSource.indexOf('\n}', start);
  assert.ok(end > start, `actual calendar function ${name} must have a closing boundary`);
  return apiSource.slice(apiSource.slice(start - 6, start) === 'async ' ? start - 6 : start, end + 2);
}

async function fixture() {
  const db = new PGlite();
  await db.waitReady;
  try {
    await db.exec(schema);
    await db.query('INSERT INTO clients (id,slug,settings) VALUES ($1,$2,$3)', [CLIENT, SLUG, {
      other_setting: 'preserve',
      luna_room_fill_policy: { contractVersion: 1, fillMode: 'house', roomPriority: [R1, R2], roomPrioritySource: 'custom' },
    }]);
    for (const [id, number] of [[R1, 1], [R2, 2]]) {
      await db.query("INSERT INTO rooms(id,client_id,room_code,name,capacity,gender_strategy,room_type) VALUES($1,$2,$3,$4,1,'Flexible','mixed')",
        [id, CLIENT, `R${number}`, `Room ${number}`]);
      await db.query('INSERT INTO beds(client_id,room_id,bed_code,bed_number) VALUES($1,$2,$3,1)', [CLIENT, id, `R${number}-B1`]);
    }
    const user = { client_id: CLIENT, client_slug: SLUG, role: 'operator' };
    const sendJSON = (res, status, body) => Object.assign(res, { status, body });
    const routes = createRoomFillRoutes({
      withPgClient: fn => fn(db), readBody: async req => JSON.stringify(req.body), sendJSON, appendAuditLog() {},
    });
    async function call(method, body) {
      const res = {};
      await routes[method]({}, { body, headers: { host: 'staff.test', origin: 'http://staff.test' } }, res, user);
      return res;
    }
    // Execute unmodified production handler/functions. Inventory SELECT is real SQL.
    // Ancillary bookings/payments/transfers are explicitly empty fixtures; no HTTP/auth server.
    const emptyQueries = new Set([queries.getBedCalendarBlocksQuery(), queries.getBedCalendarSummaryQuery(), 'fixture-empty-accent']);
    const calendarPg = { query(sql, args) {
      if (emptyQueries.has(sql)) return Promise.resolve({ rows: [] });
      assert.equal(sql, queries.getBedCalendarRoomsQuery(), 'unexpected calendar SQL');
      return db.query(sql, args);
    } };
    const ctx = {
      Date, Math, Set, Object, Number, String, Array, DEFAULT_CLIENT: SLUG,
      SQL_INJECT_RE: /[;'"\\]/, DATE_RE: /^\d{4}-\d{2}-\d{2}$/, MAX_CALENDAR_DAYS: 90,
      assertStaffClientAccess: (principal, slug) => principal.client_slug === slug,
      send400: (res, error) => sendJSON(res, 400, { error }), sendJSON,
      withPgClient: fn => fn(calendarPg), ...queries, ...inventory, resolveRoomCategory,
      listBookingTransfersForCalendarRange: async () => [], appendAuditLog() {},
      buildTransferSummariesByBookingId: () => ({}), emptyTransferSummary: () => ({}),
      BOOKING_ACCENT_STAY_SQL: 'fixture-empty-accent', annotateCalendarBlocks: rows => rows,
    };
    vm.createContext(ctx);
    vm.runInContext(['parseCalendarDate', 'generateCalendarDays', 'buildRoomHierarchy', 'buildCalendarBlocks', 'handleBedCalendar']
      .map(sourceFunction).join('\n'), ctx);
    async function calendar() {
      const res = {};
      await ctx.handleBedCalendar({ client: SLUG, start: '2026-10-01', end: '2026-10-31' }, res, user);
      return JSON.parse(JSON.stringify(res));
    }
    return { db, call, calendar };
  } catch (err) {
    await db.close();
    throw err;
  }
}

for (const count of [6, 2]) {
  test(`actual create/SQL/calendar: R3 Female ${count} beds retain exact UUIDs without CSV ghosts`, async () => {
    const f = await fixture();
    try {
      const read = await f.call('handleRoomFillGet');
      assert.equal(read.status, 200);
      const request = {
        operationId: `csv-overlap-${count}-beds`, roomNumber: 3, bedCount: count, gender: 'female',
        expectedSettingsRevision: read.body.settingsRevision, expectedCatalogRevision: read.body.catalogRevision,
        fillMode: read.body.policy.fillMode, roomPriority: read.body.policy.roomPriority,
      };
      const created = await f.call('handleRoomFillCreate', request);
      assert.equal(created.status, 200);
      assert.equal(created.body.bedIds.length, count);
      const stored = (await f.db.query(queries.getBedCalendarRoomsQuery(), [SLUG])).rows;
      const canonical = stored.filter(row => row.room_code === 'R3');
      assert.equal(canonical.length, count);
      assert.equal(canonical[0].room_id, created.body.roomId);
      assert.deepEqual(canonical.map(row => row.bed_id).sort(), created.body.bedIds.slice().sort());
      assert.ok(canonical.every(row => row.capacity === count && row.room_type === 'female_only'
        && row.gender_strategy === 'Female preferred' && row.bed_active && row.bed_sellable));
      const settings = (await f.db.query('SELECT settings FROM clients WHERE id=$1', [CLIENT])).rows[0].settings;
      assert.equal(settings.other_setting, 'preserve');
      assert.ok(settings.luna_room_fill_policy.roomPriority.includes(created.body.roomId));
      const calendar = await f.calendar();
      assert.equal(calendar.status, 200);
      const room = calendar.body.rooms.find(row => row.room_code === 'R3');
      assert.ok(room);
      const report = { backend: 'PGlite', request, created, canonical, calendarRoom: room,
        missingBedIds: created.body.bedIds.filter(id => !room.beds.some(bed => bed.bed_id === id)),
        ghostBeds: room.beds.filter(bed => !created.body.bedIds.includes(bed.bed_id)) };
      if (process.env.CSV_PROOF_DIR) {
        fs.mkdirSync(process.env.CSV_PROOF_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.CSV_PROOF_DIR, `r3-${count}-beds.json`), JSON.stringify(report, null, 2) + '\n');
      }
      assert.equal(room.beds.length, count, 'calendar must preserve canonical bed count');
      assert.deepEqual(room.beds.map(bed => bed.bed_id).sort(), created.body.bedIds.slice().sort(), 'calendar must retain exact SQL UUIDs');
      assert.equal(new Set(room.beds.map(bed => bed.bed_id)).size, count);
      for (const key of ['room_name', 'house', 'room_type', 'capacity', 'fill_priority', 'gender_strategy', 'can_be_matrimonial', 'often_used_by_operator']) {
        assert.equal(room[key], canonical[0][key], `calendar preserves canonical ${key}`);
      }
      assert.equal(room.sort_order, canonical[0].room_sort_order);
      assert.deepEqual(resolve(SLUG, stored).filter(row => row.room_code === 'R3'), canonical);
      assert.deepEqual(resolve(SLUG, stored).filter(row => !['R1', 'R2', 'R3'].includes(row.room_code)),
        csvRows.filter(row => !['R1', 'R2', 'R3'].includes(row.room_code)), 'absent-room CSV fallback remains exact');
      assert.ok(calendar.body.rooms.some(row => row.room_code === 'R4' && row.beds.length > 0), 'actual handler retains absent CSV room');
      assert.deepEqual((await f.calendar()).body.rooms, calendar.body.rooms, 'calendar reload preserves UUIDs and metadata');
    } finally {
      await f.db.close();
    }
  });
}
