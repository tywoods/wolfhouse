'use strict';
// Disposable disk-backed PGlite; real production route + SQL, no network or guest writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const { runMainAvailabilityReport, parseSessionInput } = require('./lib/main-availability-pg-sql');
const OUT = path.resolve(process.argv[2] || '../artifacts/staff-ui-polish-006/room-work');
const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R = '11111111-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { client_id: C, client_slug: 'wolfhouse-somo', role: 'operator', staff_user_id: C };
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(OUT, 'gender-pglite-'));
  let db = new PGlite(dir);
  const audit = [];
  let queue = Promise.resolve(), failReadback = false, changed = false;
  // One PGlite session, so serialize complete transactions like a pool of size one.
  // This proves simultaneous-request CAS, not multi-process PostgreSQL lock contention.
  const withPgClient = fn => {
    const work = queue.then(() => fn({ query: async (sql, args) => {
      if (String(sql).includes('room-fill-gender-update')) changed = true;
      if (failReadback && changed && String(sql).includes('room-fill-catalogue')) throw new Error('injected readback failure');
      return db.query(sql, args);
    } }));
    queue = work.catch(() => {}); return work;
  };
  const makeRoutes = () => createRoomFillRoutes({ sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async req => req.body, withPgClient, appendAuditLog: event => audit.push(event) });
  const get = async () => { const res = {}; await makeRoutes().handleRoomFillGet({}, {}, res, user); assert.equal(res.status, 200); return res.body; };
  const put = async (body, opts = {}) => {
    const res = {}; const r = makeRoutes();
    assert.equal(typeof r.handleRoomFillGenderPut, 'function', 'existing-room gender handler must exist');
    await r.handleRoomFillGenderPut(opts.roomId || R, opts.query || {}, { headers: { host: 'staff.invalid', origin: 'https://staff.invalid', 'content-type': 'application/json', ...opts.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, res, opts.user === undefined ? user : opts.user);
    return res;
  };
  try {
    await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY, slug text, settings jsonb DEFAULT '{}');
      CREATE TABLE rooms(id uuid PRIMARY KEY, client_id uuid REFERENCES clients, room_code text, name text, house text, capacity integer,
      room_type text, gender_strategy text, active boolean DEFAULT true, can_be_matrimonial boolean DEFAULT false, often_used_by_operator boolean DEFAULT false);
      CREATE TABLE beds(id uuid PRIMARY KEY, client_id uuid, room_id uuid REFERENCES rooms, bed_code text, bed_number integer, active boolean DEFAULT true, sellable boolean DEFAULT true);
      ALTER TABLE rooms ADD fill_priority integer DEFAULT 1, ADD private_priority integer DEFAULT 0;
      ALTER TABLE beds ADD bed_label text;
      CREATE TABLE bookings(id uuid PRIMARY KEY, client_id uuid, booking_code text, status text);
      CREATE TABLE booking_beds(id uuid PRIMARY KEY, bed_id uuid REFERENCES beds, booking_id uuid, client_id uuid, assignment_start_date date, assignment_end_date date);
      INSERT INTO clients VALUES ('${C}','wolfhouse-somo','{"unrelated":true}');
      INSERT INTO rooms(id,client_id,room_code,capacity,room_type,gender_strategy) VALUES ('${R}','${C}','R1',4,'mixed','Flexible');
      INSERT INTO beds(id,client_id,room_id,bed_code,bed_number) VALUES ('${B}','${C}','${R}','R1-B1',1);
      INSERT INTO bookings VALUES ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','${C}','OFFLINE-ONLY','confirmed');
      INSERT INTO booking_beds VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','${B}','dddddddd-dddd-4ddd-8ddd-dddddddddddd','${C}','2026-01-01','2026-01-02');`);
    const before = await get();
    const stable = async () => ({ beds: (await db.query('SELECT * FROM beds')).rows, assignments: (await db.query('SELECT * FROM booking_beds')).rows, settings: (await db.query('SELECT settings FROM clients')).rows });
    const baseline = await stable();
    const result = await put({ gender: 'female', expectedCatalogRevision: before.catalogRevision });
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.body.catalogue[0].genderLabel, 'Female');
    assert.equal(result.body.catalogue[0].genderEditable, true);
    assert.notEqual(result.body.catalogRevision, before.catalogRevision);
    assert.deepEqual(await stable(), baseline, 'IDs/assignments/settings untouched');
    assert.equal(audit.length, 1); assert.equal(audit[0].old.roomType, 'mixed'); assert.equal(audit[0].new.roomType, 'female_only');
    await db.close(); db = new PGlite(dir);
    const reopened = await get();
    assert.equal(reopened.catalogue[0].roomId, R); assert.deepEqual(reopened.catalogue[0].bedIds, [B]);
    assert.equal(reopened.catalogue[0].genderLabel, 'Female');
    const canonical = (await db.query('SELECT * FROM rooms WHERE id=$1', [R])).rows[0];
    assert.equal(canonical.room_type, 'female_only'); assert.equal(canonical.gender_strategy, 'Female preferred');
    const availability = gender => runMainAvailabilityReport(db, parseSessionInput({ check_in: '2027-01-01', check_out: '2027-01-02', guest_gender_group_type: gender }));
    assert.equal((await availability('male')).candidate_rooms.length, 0, 'ordinary eligibility consumes canonical edit');
    assert.equal((await availability('female')).candidate_rooms.length, 1);
    const retry = await put({ gender: 'female', expectedCatalogRevision: before.catalogRevision });
    assert.equal(retry.status, 200, 'lost-response unchanged retry returns truthful authoritative state');
    assert.equal(retry.body.unchanged, true); assert.equal(audit.length, 1);
    assert.equal(retry.body.catalogRevision, reopened.catalogRevision);
    const snapshot = async () => ({ stable: await stable(), rooms: (await db.query('SELECT * FROM rooms ORDER BY id')).rows, audit: clone(audit) });
    const clone = x => JSON.parse(JSON.stringify(x));
    const valid = { gender: 'male', expectedCatalogRevision: reopened.catalogRevision };
    for (const [name, body, opts, status] of [
      ['viewer', valid, { user: { ...user, role: 'viewer' } }, 403],
      ['unauthenticated', valid, { user: null }, 401],
      ['tenant spoof', valid, { user: { ...user, client_slug: 'sunset' } }, 403],
      ['query tenant', valid, { query: { client_id: C } }, 400],
      ['body tenant', { ...valid, client_id: C }, {}, 400],
      ['foreign origin', valid, { headers: { origin: 'https://other.invalid' } }, 403],
      ['opaque origin', valid, { headers: { origin: 'null' } }, 403],
      ['non-http origin', valid, { headers: { origin: 'ftp://staff.invalid' } }, 403],
      ['fetch cross-site', valid, { headers: { 'sec-fetch-site': 'cross-site', origin: undefined } }, 403],
      ['non-json content type', valid, { headers: { 'content-type': 'text/plain' } }, 415],
      ['malformed json', '{', {}, 400], ['primitive json', 'true', {}, 400],
      ['array json', [], {}, 400], ['null json', 'null', {}, 400],
      ['prototype gender', { ...valid, gender: 'toString' }, {}, 400],
      ['invalid gender', { ...valid, gender: 'Female' }, {}, 400],
      ['missing revision', { gender: 'male' }, {}, 400],
      ['invalid id', valid, { roomId: '../no' }, 400],
      ['missing room', valid, { roomId: '99999999-9999-4999-8999-999999999999' }, 404],
      ['stale revision', { ...valid, expectedCatalogRevision: before.catalogRevision }, {}, 409],
    ]) {
      const previous = await snapshot(); const response = await put(body, opts);
      assert.equal(response.status, status, name + ': ' + JSON.stringify(response));
      assert.deepEqual(await snapshot(), previous, name + ': zero mutations/audit');
    }
    for (const [type, matrimonial, operator] of [['private',false,false],['couple',false,false],['matrimonial_or_mixed',false,false],['operator',false,false],['unknown',false,false],['',false,false],['shared',false,false],['mixed',true,false],['mixed',false,true]]) {
      await db.query('UPDATE rooms SET room_type=$1, can_be_matrimonial=$2, often_used_by_operator=$3 WHERE id=$4', [type,matrimonial,operator,R]);
      const current = await get(); assert.equal(current.catalogue[0].genderEditable, false); assert.match(current.catalogue[0].genderEditNote, /Read-only/);
      const previous = await snapshot(); const response = await put({ gender: 'mixed', expectedCatalogRevision: current.catalogRevision });
      assert.equal(response.status, 422, type); assert.equal(response.body.error, 'room_gender_read_only');
      assert.deepEqual(await snapshot(), previous, 'special state unchanged: ' + type);
    }
    await db.query("UPDATE rooms SET room_type='female_only', gender_strategy='Female preferred', can_be_matrimonial=false, often_used_by_operator=false WHERE id=$1", [R]);
    const fresh = await get();
    let previous = await snapshot();
    const noop = await put({ gender: 'female', expectedCatalogRevision: fresh.catalogRevision });
    assert.equal(noop.status, 200); assert.equal(noop.body.unchanged, true); assert.deepEqual(await snapshot(), previous);
    changed = false; failReadback = true;
    const failed = await put({ gender: 'male', expectedCatalogRevision: fresh.catalogRevision });
    failReadback = false;
    assert.equal(failed.status, 503); assert.deepEqual(await snapshot(), previous, 'SQL update rolls back if authoritative readback fails');
    const concurrent = await Promise.all(['male','mixed'].map(gender => put({ gender, expectedCatalogRevision: fresh.catalogRevision })));
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200,409]);
    assert.equal(audit.length, 2, 'one mutation wins shared CAS');
    assert.deepEqual(await stable(), baseline);
    const winning = concurrent.find(r => r.status === 200).body;
    const conflictSave = {}; await makeRoutes().handleRoomFillPut({}, { headers: {}, body: JSON.stringify({ contractVersion: 1, fillMode: 'room', roomPriority: [R], roomPrioritySource: 'custom', expectedCatalogRevision: fresh.catalogRevision, expectedSettingsRevision: null }) }, conflictSave, user);
    assert.equal(conflictSave.status, 409, 'pre-edit placement revision is rejected');
    fs.writeFileSync(path.join(OUT, 'sql-results.json'), JSON.stringify({ passed: true, backend: 'disk-backed PGlite', directory: dir, before, reopened, winning, audit, preserved: await stable(), simultaneousStatuses: concurrent.map(r => r.status) }, null, 2));
    console.log('PASS strict role/tenant/origin/JSON/id/CAS denials; special read-only; no-op; readback rollback; simultaneous CAS; stale placement');
    console.log('PASS update → commit → disk DB reopen → GET; canonical eligibility; identity/assignment/settings preserved; old/new audit');
  } finally { await db.close(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
