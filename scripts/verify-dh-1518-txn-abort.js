#!/usr/bin/env node
'use strict';

/**
 * DH-1518-TXN-ABORT-ROOT: an optional confirmation-owed write must not
 * abort the open booking transaction when the table is missing (42P01).
 * Missing table inside a txn must still allow the later payment UPDATE.
 */

const path = require('path');
const owed = require('./lib/staff-booking-confirmation-owed');

const BOOKING = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return;
  }
  fail += 1;
  console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

function makeTxnPg(opts) {
  const missing = opts && opts.missingTable;
  let aborted = false;
  let inTxn = false;
  const savepoints = [];
  const calls = [];
  return {
    calls,
    get aborted() { return aborted; },
    async query(sql) {
      const s = String(sql).trim();
      calls.push(s);
      if (/^BEGIN$/i.test(s)) {
        inTxn = true;
        aborted = false;
        return { rows: [] };
      }
      if (/^COMMIT$/i.test(s)) {
        if (aborted) {
          const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
          err.code = '25P02';
          throw err;
        }
        inTxn = false;
        return { rows: [] };
      }
      if (/^ROLLBACK TO SAVEPOINT\b/i.test(s)) {
        aborted = false;
        return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(s)) {
        aborted = false;
        inTxn = false;
        savepoints.length = 0;
        return { rows: [] };
      }
      if (/^SAVEPOINT\b/i.test(s)) {
        if (!inTxn) {
          const err = new Error('SAVEPOINT can only be used in transaction blocks');
          err.code = '25P01';
          throw err;
        }
        savepoints.push(s);
        return { rows: [] };
      }
      if (/^RELEASE SAVEPOINT\b/i.test(s)) {
        return { rows: [] };
      }
      if (aborted) {
        const err = new Error('current transaction is aborted, commands ignored until end of transaction block');
        err.code = '25P02';
        throw err;
      }
      if (missing && /booking_confirmation_(owed|delivery_events)/i.test(s)
        && /INSERT|UPDATE|SELECT/i.test(s)) {
        const err = new Error('relation "booking_confirmation_owed" does not exist');
        err.code = '42P01';
        if (inTxn) aborted = true;
        throw err;
      }
      if (/UPDATE payments/i.test(s)) {
        return { rows: [{ payment_id: 'pay-1' }] };
      }
      return { rows: [] };
    },
  };
}

async function main() {
  console.log('\n[DH-1518] optional owed write must not abort booking txn');

  const pg = makeTxnPg({ missingTable: true });
  await pg.query('BEGIN');
  const recorded = await owed.recordConfirmationOwed(pg, {
    booking_id: BOOKING,
    client_id: CLIENT_ID,
  });
  ok('missing owed table reports table_missing, does not throw',
    recorded && recorded.ok === false && recorded.reason === 'table_missing',
    JSON.stringify(recorded));

  let pay;
  let payErr = null;
  try {
    pay = await pg.query(
      'UPDATE payments SET amount_due_cents = 18000 WHERE booking_id = $1 RETURNING id AS payment_id',
      [BOOKING],
    );
  } catch (err) {
    payErr = err;
  }
  ok('missing table inside a txn still books: later payment UPDATE succeeds',
    !payErr && pay && pay.rows[0] && pay.rows[0].payment_id === 'pay-1' && pg.aborted === false,
    payErr ? `code=${payErr.code} ${payErr.message}` : JSON.stringify(pay));

  ok('optional write used SAVEPOINT so 42P01 could be rolled back',
    pg.calls.some((c) => /^SAVEPOINT\b/i.test(c))
    && pg.calls.some((c) => /^ROLLBACK TO SAVEPOINT\b/i.test(c)),
    pg.calls.join(' | '));

  await pg.query('COMMIT');
  ok('booking txn COMMIT succeeds after missing optional table',
    pg.aborted === false);

  const idle = makeTxnPg({ missingTable: true });
  const idleRecorded = await owed.recordConfirmationOwed(idle, {
    booking_id: BOOKING,
    client_id: CLIENT_ID,
  });
  ok('autocommit missing table is table_missing and does not require a txn',
    idleRecorded && idleRecorded.reason === 'table_missing',
    JSON.stringify(idleRecorded));

  const fs = require('fs');
  const createSrc = fs.readFileSync(
    path.join(__dirname, 'lib/luna-front-desk-accommodation-booking-create-service.js'),
    'utf8',
  );
  ok('booking create records confirmation owed (still best-effort)',
    /recordConfirmationOwed/.test(createSrc));

  console.log(`\nverify:dh-1518-txn-abort — ${fail ? 'FAILED' : 'ALL CHECKS PASSED'} (${pass} pass${fail ? `, ${fail} fail` : ''})`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
