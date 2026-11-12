'use strict';
// Isolated, in-memory PostgreSQL (PGlite). No DSN/env/network or live data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { runAvailabilityBedSelection, validateExplicitBedSelection } = require('./lib/luna-bed-allocator');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const migrationPath = path.join(__dirname, '../database/migrations/135_remove_operator_room_designation.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL);
      INSERT INTO clients(slug) VALUES ('wolfhouse-somo'), ('sunset'), ('unrelated-school'), ('wolfhouse-somo-copy');`);
    // Use actual original room/bed DDL, applying migration 003's column rename.
    const init = read('database/migrations/001_init.sql');
    await db.exec(init.match(/CREATE OR REPLACE FUNCTION set_updated_at\(\)[\s\S]*?\$\$ LANGUAGE plpgsql;/)[0]);
    for (const table of ['rooms', 'beds']) {
      const ddl = init.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\n\\);`))[0];
      await db.exec(ddl.replaceAll('hostel_id', 'client_id').replaceAll('REFERENCES hostels', 'REFERENCES clients'));
      await db.exec(init.match(new RegExp(`CREATE TRIGGER ${table}_updated_at[\\s\\S]*?set_updated_at\\(\\);`))[0]);
    }
    await db.exec(read('database/migrations/111_room_selling_mode.sql'));
    const seed = read('database/seeds/001_wolfhouse_seed.sql');
    await db.exec(seed.split('\n').filter(line => /^INSERT INTO (rooms|beds) /.test(line)).join('\n'));
    await db.exec(read('database/migrations/020_wolfhouse_room_gender_metadata.sql'));
    // Synthetic selling policy (not a claim about live R7 configuration).
    await db.exec(`UPDATE rooms SET selling_mode='private_optional' WHERE room_code='R7';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, capacity, often_used_by_operator)
        SELECT id, 'CONTROL', 'operator_surfweek', 'Flexible', 2, true FROM clients WHERE slug NOT IN ('wolfhouse-somo','sunset');
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, capacity, often_used_by_operator)
        SELECT id, 'S-SHARED', 'flexible', 'Flexible', 2, true FROM clients WHERE slug='sunset';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, capacity, can_be_matrimonial, often_used_by_operator)
        SELECT id, 'S-PRIVATE', 'operator_surfweek', 'Private', 4, true, true FROM clients WHERE slug='sunset';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, capacity, can_be_matrimonial, often_used_by_operator)
        SELECT id, 'S-JOINED', 'flexible', 'Flexible', 4, true, true FROM clients WHERE slug='sunset';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, often_used_by_operator)
        SELECT id, 'S-FEMALE', 'flexible', 'Female preferred', true FROM clients WHERE slug='sunset';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, often_used_by_operator)
        SELECT id, 'S-MALE', 'operator_surfweek', 'Male preferred', true FROM clients WHERE slug='sunset';
      INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, often_used_by_operator)
        SELECT id, 'S-FLAG', 'female_only', 'Female preferred', true FROM clients WHERE slug='sunset';`);
    // Populated unrelated-data sentinels; migration may not write any of them.
    const untouchedTables = ['clients', 'beds', 'bookings', 'guests', 'payments', 'contacts', 'booking_beds', 'blocks'];
    for (const table of untouchedTables.slice(2)) await db.exec(`CREATE TABLE ${table} (id int PRIMARY KEY, payload jsonb);
      INSERT INTO ${table} VALUES (1, '{"assignment_type":"operator_block","from":"2027-04-15","until":"2027-04-20"}');`);
    const snapshot = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows;
    const untouchedBefore = await Promise.all(untouchedTables.map(snapshot));
    const before = (await db.query('SELECT * FROM rooms ORDER BY room_code')).rows;
    if (migration) await db.exec(migration);
    const after = (await db.query('SELECT * FROM rooms ORDER BY room_code')).rows;
    for (const code of ['R7', 'R9', 'R10']) {
      const row = after.find(r => r.room_code === code);
      assert.equal(row.room_type, 'mixed', `${code} must become ordinary mixed inventory`);
      assert.equal(row.often_used_by_operator, false);
    }
    const expected = { 'S-SHARED': 'mixed', 'S-PRIVATE': 'matrimonial_private_couple',
      'S-JOINED': 'matrimonial_or_mixed', 'S-FEMALE': 'female_only', 'S-MALE': 'male_only', 'S-FLAG': 'female_only' };
    for (const [code, type] of Object.entries(expected)) {
      assert.equal(after.find(r => r.room_code === code).room_type, type);
      assert.equal(after.find(r => r.room_code === code).often_used_by_operator, false);
    }
    for (const row of before) {
      const actual = after.find(r => r.id === row.id);
      const changes = ['R7', 'R9', 'R10', ...Object.keys(expected)].includes(row.room_code);
      assert.deepEqual(actual, changes ? { ...row, room_type: expected[row.room_code] || 'mixed',
        often_used_by_operator: false, updated_at: actual.updated_at } : row,
        'only type, designation flag and standard updated_at trigger may change');
    }
    assert.deepEqual(await Promise.all(untouchedTables.map(snapshot)), untouchedBefore, 'unrelated data invariant');
    await db.exec(migration);
    assert.deepEqual((await db.query('SELECT * FROM rooms ORDER BY room_code')).rows, after, 'idempotent');
    console.log('SOURCE/FIXTURE ONLY (not live):');
    for (const row of before.filter(r => /^R\d+$/.test(r.room_code))) {
      const actual = after.find(r => r.id === row.id);
      console.log(`${row.room_code}: ${row.room_type}/${row.often_used_by_operator} -> ${actual.room_type}/${actual.often_used_by_operator}; capacity=${row.capacity}; selling_mode=${row.selling_mode} (fixture)`);
    }
    const bedRows = (await db.query(`SELECT b.bed_code, b.active bed_active, b.sellable bed_sellable,
      r.room_code, r.room_type, r.gender_strategy, r.selling_mode, r.capacity, r.can_be_matrimonial
      FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_code='R7' ORDER BY b.bed_code`)).rows;
    for (const blocked of [false, true]) {
      const blockRows = blocked ? [{ bed_code: 'R7-B4', room_code: 'R7', assignment_type: 'operator_block' }] : [];
      const selected = runAvailabilityBedSelection({ bedRows, blockRows, guestCount: 3, roomPreference: 'private' });
      assert.deepEqual(selected.selected_bed_codes, blocked ? [] : ['R7-B1','R7-B2','R7-B3']);
      assert.equal(validateExplicitBedSelection({ bedRows, blockRows, guestCount: 3,
        selectedBedCodes: ['R7-B1','R7-B2','R7-B3'], body: { room_preference: 'private' } }).ok, !blocked);
    }
    console.log('PASS PostgreSQL migration: source inventory, tenant boundaries, semantic types (no capacity heuristic), metadata-only updates, unrelated invariance, replay and migrated private allocation/date blocks');
    await db.exec(`INSERT INTO rooms(client_id, room_code, room_type, gender_strategy, often_used_by_operator)
      SELECT id, 'AMBIGUOUS', 'flexible', 'Unreviewed custom strategy', true FROM clients WHERE slug='sunset';
      UPDATE rooms SET often_used_by_operator=true WHERE room_code='R1';`);
    const beforeAmbiguous = await snapshot('rooms');
    await assert.rejects(db.exec(migration), /ambiguous room eligibility/i,
      'unknown strategies must stop the migration rather than guess shared/private from capacity');
    await db.exec('ROLLBACK');
    assert.deepEqual(await snapshot('rooms'), beforeAmbiguous, 'ambiguity rolls back every room update');
    console.log('PASS ambiguous metadata fails closed with atomic rollback');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
