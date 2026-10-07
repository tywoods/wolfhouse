'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createRoomFillRoutes } = require('./lib/staff-room-fill-routes');
const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const R = '11111111-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const user = { client_id: C, client_slug: 'wolfhouse-somo', role: 'operator', staff_user_id: C };
async function fixture(out) {
  fs.mkdirSync(out, { recursive: true });
  const dir = fs.mkdtempSync(path.join(out, 'selling-pglite-'));
  let db = new PGlite(dir), queue = Promise.resolve();
  const audit = [];
  const routes = createRoomFillRoutes({ sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    readBody: async req => req.body, appendAuditLog: e => audit.push(e),
    withPgClient: fn => { const work = queue.then(() => fn(db)); queue = work.catch(() => {}); return work; } });
  await db.exec(`CREATE TABLE clients(id uuid PRIMARY KEY, slug text, settings jsonb DEFAULT '{}');
    CREATE TABLE rooms(id uuid PRIMARY KEY, client_id uuid, room_code text, name text, house text, capacity int,
      room_type text, gender_strategy text, active boolean DEFAULT true, can_be_matrimonial boolean DEFAULT false, often_used_by_operator boolean DEFAULT false);
    CREATE TABLE beds(id uuid PRIMARY KEY, client_id uuid, room_id uuid, bed_code text, bed_number int, active boolean DEFAULT true, sellable boolean DEFAULT true);
    CREATE TABLE bookings(id uuid PRIMARY KEY, client_id uuid, status text);
    CREATE TABLE booking_beds(id uuid PRIMARY KEY, client_id uuid, booking_id uuid, bed_id uuid, assignment_start_date date, assignment_end_date date);
    INSERT INTO clients VALUES ('${C}', 'wolfhouse-somo', '{"unrelated":true}');
    INSERT INTO rooms(id,client_id,room_code,capacity,room_type,gender_strategy) VALUES ('${R}','${C}','R1',2,'female_only','Female preferred');
    INSERT INTO beds(id,client_id,room_id,bed_code,bed_number) VALUES ('${B}','${C}','${R}','R1-B1',1);`);
  const migration = path.join(__dirname, '../database/migrations/111_room_selling_mode.sql');
  if (fs.existsSync(migration)) await db.exec(fs.readFileSync(migration, 'utf8'));
  const get = async () => { const res = {}; await routes.handleRoomFillGet({}, {}, res, user); assert.equal(res.status,200,JSON.stringify(res)); return res.body; };
  const put = async (body, who = user) => { const res = {}; await routes.handleRoomFillGenderPut(R, {}, { headers: { host:'staff.invalid',origin:'https://staff.invalid','content-type':'application/json' }, body:JSON.stringify(body) }, res, who); return res; };
  return { get, put, audit, query:(...args) => db.query(...args), close:() => db.close(), reopen:async () => { await db.close(); db = new PGlite(dir); }, dir, routes };
}
async function main() {
  const out = path.resolve(process.argv[2] || '/tmp/room-selling-mode');
  const f = await fixture(out);
  try {
    const before = await f.get();
    const stable = async () => (await f.query('SELECT room_type,gender_strategy FROM rooms')).rows;
    const original = await stable();
    const saved = await f.put({ sellingMode:'private', expectedCatalogRevision:before.catalogRevision });
    assert.equal(saved.status,200,'existing Staff room save must accept sellingMode: '+JSON.stringify(saved));
    assert.equal(saved.body.catalogue[0].sellingMode,'private');
    assert.notEqual(saved.body.catalogRevision,before.catalogRevision);
    assert.deepEqual(await stable(),original,'selling mode never rewrites gender/type');
    await f.reopen();
    const reopened = await f.get();
    assert.equal(reopened.catalogue[0].sellingMode,'private');
    assert.equal((await f.query('SELECT selling_mode FROM rooms')).rows[0].selling_mode,'private');
    const stale = await f.put({ sellingMode:'shared', expectedCatalogRevision:before.catalogRevision });
    assert.equal(stale.status,409);
    const retry = await f.put({ sellingMode:'private', expectedCatalogRevision:before.catalogRevision });
    assert.equal(retry.status,200); assert.equal(retry.body.unchanged,true);
    for (const sellingMode of ['',null,'Private','toString','arbitrary']) {
      assert.equal((await f.put({ sellingMode,expectedCatalogRevision:reopened.catalogRevision })).status,400);
    }
    assert.equal((await f.put({ sellingMode:'shared',expectedCatalogRevision:reopened.catalogRevision },{...user,role:'viewer'})).status,403);
    await f.query("UPDATE rooms SET room_type='operator_surfweek', often_used_by_operator=true");
    const legacy = await f.get();
    assert.equal(legacy.catalogue[0].sellingMode,'private');
    assert.equal(legacy.catalogue[0].sellingModeEditable,false);
    assert.equal((await f.put({ sellingMode:'shared',expectedCatalogRevision:legacy.catalogRevision })).status,422);
    fs.writeFileSync(path.join(out,'persistence.json'),JSON.stringify({passed:true,before,reopened,audit:f.audit},null,2));
    console.log('PASS room selling mode route → SQL → COMMIT → disk reopen → GET; type/gender identity; CAS/retry/invalid/role/legacy protections');
  } finally { await f.close(); }
}
module.exports = { fixture,C,R,B,user };
if (require.main === module) main().catch(e => {console.error(e);process.exitCode=1;});
