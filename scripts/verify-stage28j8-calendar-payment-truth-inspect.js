/**
 * Stage 28j.8 — calendar visibility + payment truth inspect verifier.
 *
 * Usage:
 *   npm run verify:stage28j8-calendar-payment-truth-inspect
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'infra', '.env') });
const { Client } = require('pg');
const { roomCodeFromBedCode } = require('./lib/assign-booking-beds-plan');
const { getBedCalendarBlocksQuery } = require('./lib/staff-bed-calendar-queries');

const ROOT = path.join(__dirname, '..');
const PKG_FILE = path.join(ROOT, 'package.json');
const ASSIGN = path.join(__dirname, 'lib', 'assign-booking-beds-plan.js');
const CAL = path.join(__dirname, 'lib', 'staff-bed-calendar-queries.js');
const ADAPTER = path.join(__dirname, 'lib', 'meta-open-demo-inbound-adapter.js');

const PROOF_PHONE_RAW = '491726422307';
const CONV_ID = '7361e380-1074-4441-a9e1-f92c127a4e76';
const CLIENT = 'wolfhouse-somo';
const EXPECT_BOOKING = 'WH-G27-FCD6347442';

let passes = 0;
let failures = 0;
function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function check(id, cond, msg) { if (cond) pass(id, msg); else fail(id, msg); }
function section(t) { console.log(`\n── ${t} ──`); }

function az(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function pgConnect() {
  const db = az('az keyvault secret show --vault-name wh-staging-kv --name wolfhouse-database-url --query value -o tsv');
  const pg = new Client({ connectionString: db, ssl: { rejectUnauthorized: false } });
  await pg.connect();
  return pg;
}

console.log('\nverify-stage28j8-calendar-payment-truth-inspect.js  (Stage 28j.8)\n');

for (const f of [ASSIGN, CAL, ADAPTER, __filename]) {
  try {
    execSync(`node --check "${f}"`, { stdio: 'pipe' });
    pass('0', `${path.basename(f)} passes node --check`);
  } catch {
    fail('0', `${path.basename(f)} syntax error`);
  }
}

const assignSrc = fs.readFileSync(ASSIGN, 'utf8');
const calSrc = fs.readFileSync(CAL, 'utf8');
const adapterSrc = fs.readFileSync(ADAPTER, 'utf8');
const pkg = fs.existsSync(PKG_FILE) ? JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) : {};

section('A. Wiring fixes');

check('A1', roomCodeFromBedCode('DEMO-R1-B1') === 'DEMO-R1',
  'roomCodeFromBedCode resolves DEMO-R1 from DEMO-R1-B1');
check('A2', calSrc.includes('COALESCE(NULLIF(bb.room_code'),
  'bed calendar query coalesces room_code from beds.rooms join');
check('A3', adapterSrc.includes('send_payment_link_whatsapp_confirmed: stripeOk && liveReplyGate.ok !== true'),
  'separate payment-link WhatsApp send skipped when live composer reply is on');
check('A4', pkg.scripts && pkg.scripts['verify:stage28j8-calendar-payment-truth-inspect'],
  'npm script registered');

section('B. Live booking inspect (staging DB)');

(async () => {
  const pg = await pgConnect();

  const booking = await pg.query(
    `SELECT b.id::text, b.booking_code, b.status::text, b.payment_status::text,
            b.confirmation_sent_at::text, b.check_in::text, b.check_out::text,
            b.amount_paid_cents, b.balance_due_cents
       FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1
        AND REPLACE(COALESCE(b.phone,''),'+','') = $2
      ORDER BY b.updated_at DESC LIMIT 1`,
    [CLIENT, PROOF_PHONE_RAW],
  );
  const b = booking.rows[0];

  const conv = await pg.query(
    `SELECT id::text FROM conversations WHERE id = $1::uuid`,
    [CONV_ID],
  );

  const pay = b ? await pg.query(
    `SELECT id::text, status::text, amount_due_cents, stripe_checkout_session_id, checkout_url
       FROM payments WHERE booking_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [b.id],
  ) : { rows: [] };
  const p = pay.rows[0];

  const bb = b ? await pg.query(
    `SELECT id::text, bed_code, room_code, assignment_start_date::text, assignment_end_date::text
       FROM booking_beds WHERE booking_id = $1::uuid`,
    [b.id],
  ) : { rows: [] };

  const blocksSql = getBedCalendarBlocksQuery();
  const blocks = b ? await pg.query(blocksSql, [CLIENT, '2026-07-01', '2026-07-06']) : { rows: [] };
  const match = blocks.rows.filter((r) => r.booking_code === (b && b.booking_code));

  const dup = await pg.query(
    `SELECT COUNT(*)::int AS n FROM bookings b JOIN clients c ON c.id = b.client_id
      WHERE c.slug = $1 AND REPLACE(COALESCE(b.phone,''),'+','') = $2
        AND b.status::text IN ('hold','pending_payment','confirmed')
        AND b.check_in = '2026-07-01' AND b.check_out = '2026-07-05'`,
    [CLIENT, PROOF_PHONE_RAW],
  );

  await pg.end();

  check('B1', !!b && !!b.booking_code, `latest live booking found (${b && b.booking_code})`);
  check('B2', conv.rows.length === 1, 'conversation id exists');
  check('B3', !!p && !!p.id, 'payment_draft/payment row exists');
  check('B4', !!(p && p.stripe_checkout_session_id), 'Stripe TEST checkout session exists');
  check('B5', b && ['deposit_paid', 'paid', 'waiting_payment'].includes(b.payment_status),
    `payment truth on booking (${b && b.payment_status})`);
  check('B6', p && (p.status === 'paid' || p.status === 'checkout_created'),
    `payment row status (${p && p.status})`);
  check('B7', !b || !b.confirmation_sent_at, 'confirmation_sent_at still null');
  check('B8', bb.rows.length > 0, 'booking_beds assignment exists');
  check('B9', match.length > 0 && match[0].room_code === 'DEMO-R1',
    `bed calendar SQL includes booking with room_code DEMO-R1 (was ${match[0] && match[0].room_code})`);
  check('B10', (dup.rows[0] && dup.rows[0].n) <= 2,
    `no duplicate July 1-5 holds explosion (count=${dup.rows[0] && dup.rows[0].n})`);

  section('C. Safety');

  check('C1', !adapterSrc.includes('confirmation_send'), 'no confirmation send in adapter');
  check('C2', !assignSrc.includes('sk_live_'), 'no live Stripe in assign plan');
  check('C3', assignSrc.includes('DEMO-R'), 'demo bed room code helper present');

  console.log(`\n── Summary ──\n\nResults: ${passes} passed, ${failures} failed\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
