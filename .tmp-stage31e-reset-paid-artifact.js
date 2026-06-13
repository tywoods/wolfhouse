'use strict';
/** Reset WH-G27-AE23A49F21 paid proof artifact on staging. Temp — do not commit. */
const { execSync } = require('child_process');
const { Client } = require('pg');
const { runLiveProofHygiene } = require('./scripts/lib/luna-live-proof-hygiene');

const CLIENT = 'wolfhouse-somo';
const PROOF_PHONE = '+491726422307';
const BOOKING_CODE = 'WH-G27-AE23A49F21';
const HOST = 'staff-staging.lunafrontdesk.com';

(async () => {
  const db = execSync('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv', { encoding: 'utf8' }).trim();
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  const before = (await pg.query(
    `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  )).rows[0];
  const out = await runLiveProofHygiene({
    client_slug: CLIENT,
    phone: PROOF_PHONE,
    check_in: '2026-07-06',
    check_out: '2026-07-10',
    source: 'stage31e-paid-artifact-reset',
  }, {
    allow_hygiene: true,
    confirm_hygiene: true,
    allow_staging_paid_proof_reset: true,
    dry_run: false,
    pg,
    host_header: HOST,
  });
  const after = (await pg.query(
    `SELECT booking_code, status::text, payment_status::text, check_in::text, check_out::text
       FROM bookings WHERE booking_code = $1`,
    [BOOKING_CODE],
  )).rows[0];
  const payments = (await pg.query(
    `SELECT p.id::text, p.status::text, p.amount_paid_cents FROM payments p
      JOIN bookings b ON b.id = p.booking_id WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  )).rows;
  const beds = (await pg.query(
    `SELECT bed_code FROM booking_beds bb JOIN bookings b ON b.id = bb.booking_id WHERE b.booking_code = $1`,
    [BOOKING_CODE],
  )).rows;
  await pg.end();
  console.log(JSON.stringify({ before, after, payments, beds, hygiene: out }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
