#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const lib = require('./lib/staff-portal-booking-cancel');
const api = fs.readFileSync(path.join(root, 'scripts/staff-query-api.js'), 'utf8');

assert.equal(
  lib.explainStaffBookingCancelError({ message: 'cancelled_booking_has_collectible_payment' }),
  'This booking still has an open unpaid payment or payment link. Cancel cannot finish until those unpaid rows are closed.',
);

assert.equal(
  lib.explainStaffBookingCancelError({ message: 'weird_sql' }),
  'Could not cancel this booking: weird_sql',
);

const queries = [];
const fakePg = {
  async query(sql) {
    queries.push({ sql: String(sql) });
    if (/AS client_id/.test(sql)) return { rows: [{ client_id: 'client-1' }] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ c: 0 }] };
    if (/UPDATE payments/.test(sql)) {
      return { rowCount: 3, rows: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] };
    }
    return { rows: [], rowCount: 0 };
  },
};

Promise.resolve()
  .then(() => lib.neutralizeUnpaidCollectiblePayments(fakePg, {
    clientSlug: 'wolfhouse-somo',
    bookingId: '68ea258c-6709-42a3-b984-b3892c619ae9',
  }))
  .then((out) => {
    assert.equal(out.ok, true);
    assert.equal(out.captured_count, 0);
    assert.ok(out.neutralized_count >= 1);
    const upd = queries.find((q) => /UPDATE payments/.test(q.sql));
    assert.ok(upd, 'must update unpaid payment rows');
    assert.match(upd.sql, /status='cancelled'::payment_record_status/);
    assert.match(upd.sql, /checkout_url=NULL/);
    assert.match(upd.sql, /stripe_checkout_session_id=NULL/);
    const portal = api.slice(
      api.indexOf('async function handleBookingCancel'),
      api.indexOf('async function handleBotBookingCancel'),
    );
    assert.doesNotMatch(portal, /error: 'cancel failed'/);
    assert.match(portal, /neutralizeUnpaidCollectiblePayments/);
    assert.match(portal, /explainStaffBookingCancelError/);
    assert.match(api, /data\.detail/);
    console.log('ok staff portal unpaid cancel explains and closes collectible drafts');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
