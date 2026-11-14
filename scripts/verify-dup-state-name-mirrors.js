#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { createNameFixture } = require('./fixtures/dup-state-lookout-sql');
const { propagateBookingLeadName } = require('./lib/staff-booking-name-propagate');

async function requiredEdit(testCase) {
  const f = await createNameFixture();
  const warnings = [];
  const warn = console.warn;
  try {
    if (testCase !== 'missing_guest_rooms') await f.legacyRooms();
    if (testCase.startsWith('trigger_')) await f.failMirror(testCase.slice(8));
    console.warn = (...args) => warnings.push(args.join(' '));
    const result = await f.edit([{ booking_guest_id: f.guests[0].id, guest_name: 'Lead Corrected' }]);
    console.warn = warn;
    assert.equal(result.status, 200, `${testCase}: required handler must commit`);
    assert.equal(result.body.success, true);
    // Independent SELECTs, outside the handler transaction (not returned dictionaries).
    const booking = (await f.db.query('SELECT * FROM bookings')).rows;
    const guests = (await f.db.query('SELECT * FROM booking_guests ORDER BY guest_number')).rows;
    const beds = (await f.db.query('SELECT * FROM booking_beds ORDER BY bed_code')).rows;
    assert.equal(booking.length, 1);
    assert.equal(guests.length, 2);
    assert.equal(beds.length, 2);
    assert.equal(booking[0].guest_name, 'Lead Corrected');
    assert.equal(guests[0].guest_name, 'Lead Corrected');
    assert.equal(guests[1].guest_name, 'Companion Before');
    assert.equal(booking[0].total_amount_cents, f.booking.total_amount_cents);
    assert.equal(booking[0].deposit_required_cents, f.booking.deposit_required_cents);
    assert.equal(f.sqlErrors.includes('25P02'), false, 'no aborted-transaction cascade');
    assert.equal(f.calls.filter(sql => sql === 'ROLLBACK').length, 0);
    assert.equal(f.calls.filter(sql => sql === 'COMMIT').length, 2, 'create + required name edit commit');
    assert.ok(result.body.saved_at);
    if (testCase === 'healthy') {
      assert.equal(warnings.length, 0);
      assert.equal(beds[0].guest_name, 'Lead Corrected');
      const legacy = (await f.db.query('SELECT * FROM guest_rooms ORDER BY guest_number')).rows;
      assert.equal(legacy[0].guest_name, 'Lead Corrected');
      assert.equal(f.sqlErrors.length, 0);
    } else {
      assert.equal(warnings.length, 1, 'optional failure must be surfaced, not swallowed');
      assert.match(warnings[0], /booking_name_mirror_failed/);
      assert.match(warnings[0], testCase === 'missing_guest_rooms' ? /42P01/ : /P0001/);
      assert.equal(f.sqlErrors.length, 1, 'only the injected SQL error');
      assert.ok(f.calls.some(sql => sql.startsWith('ROLLBACK TO SAVEPOINT ')));
      // Later independent mirrors still run after one optional mirror fails.
      if (testCase !== 'trigger_metadata') {
        assert.equal(booking[0].metadata.booking_guests[0].guest_name, 'Lead Corrected');
      }
    }
    console.log(`PASS ${testCase}: real create + required name handler COMMIT + independent SELECT`);
  } finally { console.warn = warn; await f.db.close(); }
}

async function main() {
  for (const testCase of ['missing_guest_rooms', 'healthy', 'trigger_guest_rooms',
    'trigger_booking_beds', 'trigger_metadata', 'trigger_booking_guests']) {
    await requiredEdit(testCase);
  }
  // Existing nontransactional consumer remains supported; it must not gain a BEGIN/COMMIT.
  const f = await createNameFixture();
  const warnings = [], warn = console.warn;
  try {
    const before = f.calls.length;
    console.warn = (...args) => warnings.push(args.join(' '));
    const out = await propagateBookingLeadName(f.pg, { bookingId: f.booking.id,
      clientId: f.booking.client_id, oldName: 'Lead Before', newName: 'Auto Corrected' });
    console.warn = warn;
    assert.equal(out.ok, false);
    assert.deepEqual(out.mirror_errors, [{ mirror: 'guest_rooms', code: '42P01' }]);
    assert.equal(warnings.length, 1);
    assert.equal(f.calls.slice(before).some(sql => /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)), false);
    assert.equal((await f.db.query('SELECT guest_name FROM booking_guests WHERE guest_number=1')).rows[0].guest_name,
      'Auto Corrected');
    assert.equal((await f.db.query('SELECT metadata FROM bookings')).rows[0].metadata.booking_guests[0].guest_name,
      'Auto Corrected');
    console.log('PASS autocommit: explicit mirror error; no caller transaction ownership change');
  } finally { console.warn = warn; await f.db.close(); }
  const required = await createNameFixture();
  try {
    await required.legacyRooms();
    await required.failMirror('required_guest');
    const result = await required.edit([{ booking_guest_id: required.guests[0].id,
      guest_name: 'Lead Corrected' }]);
    assert.equal(result.status, 500, 'a real required write error must not be labelled success');
    assert.equal((await required.db.query('SELECT guest_name FROM bookings')).rows[0].guest_name,
      'Lead Before');
    assert.equal((await required.db.query('SELECT guest_name FROM booking_guests WHERE guest_number=1')).rows[0].guest_name,
      'Lead Before');
    assert.deepEqual(required.sqlErrors, ['P0001']);
    assert.equal(required.calls.filter(sql => sql === 'ROLLBACK').length, 1);
    console.log('PASS required-write inverse: real SQL error remains truthful; no partial required name edit');
  } finally { await required.db.close(); }
  console.log('PASS C22: 8 SQL cases; no network, provider, guest send or live database');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
