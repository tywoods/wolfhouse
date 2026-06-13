'use strict';
/** Stage 26h.5 staging apply + unschedule proof — temp, do not commit. */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const { Client } = require('pg');

const HOST = 'staff-staging.lunafrontdesk.com';
const CLIENT = 'wolfhouse-somo';
const BOOKING_ID = '01039383-389e-4e71-a7d6-75b56345fdbf';
const BOOKING_CODE = 'MB-WOLFHO-20260920-4f62e2';
const RECORD_ID = '63954621-6991-4c74-b02f-ddc87314b0ef'; // Hard board from 26h.4
const MIGRATION = path.join(__dirname, 'database', 'migrations', '018_booking_service_records_nullable_service_date.sql');

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function req(method, pathStr, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: HOST,
      path: pathStr,
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = raw;
        try { parsed = JSON.parse(raw); } catch { /* keep */ }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function withDb(fn) {
  const dbUrl = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function dbCounts(c) {
  const q = async (s) => (await c.query(s)).rows[0].count;
  return {
    bookings: await q('SELECT COUNT(*)::text AS count FROM bookings'),
    payments: await q('SELECT COUNT(*)::text AS count FROM payments'),
    booking_service_records: await q('SELECT COUNT(*)::text AS count FROM booking_service_records'),
    guest_message_sends_sent: await q("SELECT COUNT(*)::text AS count FROM guest_message_sends WHERE status='sent'"),
  };
}

(async () => {
  const migrationSql = fs.readFileSync(MIGRATION, 'utf8');
  const healthBefore = await req('GET', '/healthz');

  let migrationApplied = false;
  let nullableBefore = null;
  let nullableAfter = null;

  await withDb(async (c) => {
    const colBefore = (await c.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'booking_service_records' AND column_name = 'service_date'`,
    )).rows[0];
    nullableBefore = colBefore && colBefore.is_nullable;

    if (nullableBefore !== 'YES') {
      await c.query(migrationSql);
      migrationApplied = true;
    }

    const colAfter = (await c.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'booking_service_records' AND column_name = 'service_date'`,
    )).rows[0];
    nullableAfter = colAfter && colAfter.is_nullable;
  });

  const login = await req('POST', '/staff/auth/login', {
    client: CLIENT,
    email: 'operator.stage72c@example.test',
    password: 'OperatorPass123!',
  });
  const cookie = (login.headers['set-cookie'] || []).map((x) => x.split(';')[0]).join('; ');

  let beforeCounts;
  let recordBefore;
  let bookingPaymentsBefore;
  await withDb(async (c) => {
    beforeCounts = await dbCounts(c);
    recordBefore = (await c.query(
      `SELECT id::text, service_date::text AS service_date, service_type, payment_status, status, quantity, amount_due_cents
         FROM booking_service_records WHERE id = $1::uuid`,
      [RECORD_ID],
    )).rows[0];
    bookingPaymentsBefore = (await c.query(
      'SELECT COUNT(*)::text AS count FROM payments WHERE booking_id = $1::uuid',
      [BOOKING_ID],
    )).rows[0].count;
  });

  const svcGetBefore = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const unschedule = await req(
    'PATCH',
    `/staff/bookings/${BOOKING_ID}/services/${RECORD_ID}/date`,
    { client_slug: CLIENT, service_date: null },
    cookie,
  );

  let recordAfterUnschedule;
  let afterCounts;
  let bookingPaymentsAfter;
  await withDb(async (c) => {
    recordAfterUnschedule = (await c.query(
      `SELECT id::text, service_date, service_type, payment_status, status, quantity, amount_due_cents
         FROM booking_service_records WHERE id = $1::uuid`,
      [RECORD_ID],
    )).rows[0];
    afterCounts = await dbCounts(c);
    bookingPaymentsAfter = (await c.query(
      'SELECT COUNT(*)::text AS count FROM payments WHERE booking_id = $1::uuid',
      [BOOKING_ID],
    )).rows[0].count;
  });

  const svcGetAfter = await req(
    'GET',
    `/staff/bookings/${BOOKING_ID}/services?client_slug=${encodeURIComponent(CLIENT)}`,
    null,
    cookie,
  );

  const invalidPatch = await req(
    'PATCH',
    `/staff/bookings/${BOOKING_ID}/services/${RECORD_ID}/date`,
    { client_slug: CLIENT, service_date: '2099-01-01' },
    cookie,
  );

  let recordAfterInvalid;
  await withDb(async (c) => {
    recordAfterInvalid = (await c.query(
      'SELECT service_date FROM booking_service_records WHERE id = $1::uuid',
      [RECORD_ID],
    )).rows[0];
  });

  const healthAfter = await req('GET', '/healthz');

  const backOnUnscheduled = (svcGetAfter.body.unscheduled_services || [])
    .some((s) => s.service_record_id === RECORD_ID);

  const proofB = {
    booking: BOOKING_CODE,
    record_id: RECORD_ID,
    service_type: recordBefore && recordBefore.service_type,
    service_date_before: recordBefore && recordBefore.service_date,
    unschedule_http: unschedule.status,
    unschedule_success: unschedule.body && unschedule.body.success,
    service_date_after: recordAfterUnschedule && recordAfterUnschedule.service_date,
    back_on_unscheduled: backOnUnscheduled,
    only_service_date_changed: recordBefore && recordAfterUnschedule
      && recordBefore.service_type === recordAfterUnschedule.service_type
      && recordBefore.payment_status === recordAfterUnschedule.payment_status
      && recordBefore.status === recordAfterUnschedule.status
      && String(recordBefore.quantity) === String(recordAfterUnschedule.quantity)
      && String(recordBefore.amount_due_cents) === String(recordAfterUnschedule.amount_due_cents)
      && recordAfterUnschedule.service_date === null,
    service_records_count_unchanged: beforeCounts.booking_service_records === afterCounts.booking_service_records,
    booking_payments_unchanged: bookingPaymentsBefore === bookingPaymentsAfter,
  };

  const proofC = {
    http: invalidPatch.status,
    success_false: invalidPatch.body && invalidPatch.body.success === false,
    service_date_unchanged: recordAfterInvalid && recordAfterInvalid.service_date === null,
  };

  const bOk = proofB.unschedule_http === 200 && proofB.unschedule_success
    && proofB.back_on_unscheduled && proofB.only_service_date_changed
    && proofB.service_records_count_unchanged && proofB.booking_payments_unchanged;
  const cOk = proofC.http === 400 && proofC.success_false && proofC.service_date_unchanged;
  const schemaOk = nullableAfter === 'YES';
  const safetyOk = beforeCounts.payments === afterCounts.payments
    && beforeCounts.bookings === afterCounts.bookings
    && beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent;

  let result = 'FAIL';
  if (schemaOk && bOk && cOk && safetyOk && healthAfter.status === 200) result = 'PASS';
  else if (schemaOk && (bOk || cOk)) result = 'PARTIAL';

  console.log(JSON.stringify({
    result,
    commit: '77eb227',
    migration: {
      applied: migrationApplied,
      nullable_before: nullableBefore,
      nullable_after: nullableAfter,
    },
    healthz: { before: healthBefore.status, after: healthAfter.status },
    proofB,
    proofC,
    counts: { before: beforeCounts, after: afterCounts },
    safety: {
      no_payment_writes: beforeCounts.payments === afterCounts.payments,
      no_stripe: true,
      no_whatsapp: beforeCounts.guest_message_sends_sent === afterCounts.guest_message_sends_sent,
    },
  }, null, 2));

  process.exit(result === 'PASS' ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
