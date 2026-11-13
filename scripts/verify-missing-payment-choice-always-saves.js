'use strict';

/**
 * Missing/empty payment_choice must never 400 before INSERT.
 * Usage: node scripts/verify-missing-payment-choice-always-saves.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const {
  BOOKING_CREATE_CHANNELS,
  buildWolfhouseBookingCreateCommand,
  executeWolfhouseBookingCreate,
} = require('./lib/luna-front-desk-accommodation-booking-create-service');
const { WOLFHOUSE_CLIENT_SLUG } = require('./lib/wolfhouse-accommodation-application');
const { GOLDEN_BED_ROWS } = require('./lib/luna-golden-offline-pg');

const CHECK_IN = '2026-08-02';
const CHECK_OUT = '2026-08-09';
const BED = 'R1-B1';
const QUOTE_CONFIG = {
  client_slug: 'wolfhouse-somo',
  currency: 'EUR',
  payment_options: { deposit: true, full: true },
  seasons: [{
    code: 'august', label: 'August', bookable: true, active: true, priority: 10,
    ranges: [{ start_month: 8, start_day: 1, end_month: 8, end_day: 31 }],
  }],
  packages: [{
    code: 'malibu',
    name: 'Malibu',
    default_nights: 6,
    min_days: 1,
    seasonal_prices: { august: { weekly_per_person_cents: 41500, per_night_cents: 7000 } },
  }],
};
const CREATE_SRC = fs.readFileSync(
  path.join(__dirname, 'lib/luna-front-desk-accommodation-booking-create-service.js'),
  'utf8',
);

function lunaBody(overrides = {}) {
  return {
    confirm: true,
    check_in: CHECK_IN,
    check_out: CHECK_OUT,
    guest_count: 1,
    package_code: 'malibu',
    room_type: 'shared',
    guest_name: 'Pending Choice Guest',
    phone: '+34600001111',
    selected_bed_codes: [BED],
    ...overrides,
  };
}

function makePg() {
  const inserts = [];
  let committed = false;
  return {
    inserts,
    committed: () => committed,
    query: async (sql, params) => {
      const s = String(sql);
      const norm = s.replace(/\s+/g, ' ').trim();
      if (/^BEGIN/i.test(s)) return { rows: [] };
      if (/^COMMIT/i.test(s)) { committed = true; return { rows: [] }; }
      if (/^ROLLBACK/i.test(s)) return { rows: [] };
      if (/inserted_booking_beds|is_duplicate/i.test(s)) {
        inserts.push({ table: 'bookings', params: [...(params || [])] });
        return {
          rows: [{
            is_duplicate: false,
            is_blocked: false,
            booking_id: 'booking-pending-1',
            booking_code: 'WH-20260706-PEND01',
            beds_inserted: Array.isArray(params && params[12]) ? params[12].length : 1,
            payments_inserted: 1,
            audit_event_id: 'audit-pending',
          }],
        };
      }
      if (norm.includes('FROM rooms r') && norm.includes('LEFT JOIN beds bd')) {
        return { rows: GOLDEN_BED_ROWS };
      }
      if (norm.includes('FROM booking_beds bb') && norm.includes('assignment_start_date')) {
        return { rows: [] };
      }
      if (/UPDATE bookings/i.test(s)) {
        inserts.push({ table: 'bookings_update', params: [...(params || [])] });
        return { rows: [] };
      }
      if (/UPDATE payments/i.test(s)) {
        inserts.push({ table: 'payments_update', params: [...(params || [])] });
        return { rows: [{ payment_id: 'pay-pending-1' }] };
      }
      if (/SELECT client_id FROM bookings/i.test(s)) return { rows: [{ client_id: 'client-wh-1' }] };
      if (/FROM clients WHERE slug/i.test(s)) return { rows: [{ id: 'client-wh-1' }] };
      if (/metadata->>'idempotency_key'/i.test(s) || /bk.id::text = \$2/i.test(s)) {
        return { rows: [] };
      }
      if (/FROM booking_beds/i.test(s)) return { rows: [{ bed_code: BED, room_code: 'R1' }] };
      if (/INSERT INTO booking_service_records/i.test(s)) {
        return { rows: [{ id: 'sr-1' }] };
      }
      if (/information_schema|to_regclass/i.test(s)) return { rows: [{ reg: 'booking_service_records' }] };
      return { rows: [] };
    },
  };
}

async function buildLuna(body) {
  return buildWolfhouseBookingCreateCommand({
    channel: BOOKING_CREATE_CHANNELS.LUNA_WHATSAPP,
    trustedClientSlug: WOLFHOUSE_CLIENT_SLUG,
    transportBody: body,
    actorHints: { staff_user_id: 'luna-bot-internal', staff_role: 'operator' },
    pgClient: makePg(),
    quoteConfig: QUOTE_CONFIG,
  });
}

async function saveLuna(body) {
  const built = await buildLuna(body);
  if (!built.ok) return { built, out: null, pg: null };
  const pg = makePg();
  const out = await executeWolfhouseBookingCreate(pg, built.command, {
    stripeConfig: { stripeLinksEnabled: false },
    privateRoomHooks: { enabled: () => false },
  });
  return { built, out, pg };
}

function metadataFrom(pg) {
  const upd = (pg.inserts || []).find((row) => row.table === 'bookings_update');
  if (!upd) return null;
  const raw = upd.params.find((p) => typeof p === 'string' && p.trim().startsWith('{'));
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function sqlReadBack(row) {
  const scratch = '/tmp/inbox-pg-scratch';
  const bin = path.join(scratch, 'node_modules/@embedded-postgres/linux-x64/native/bin');
  const pgMod = createRequire(path.join(scratch, 'package.json'))('pg');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-paychoice-pg-'));
  execFileSync(path.join(bin, 'initdb'), ['-D', dataDir, '--auth=trust', '-U', 'postgres', '--locale=C', '--encoding=UTF8'], { stdio: 'pipe' });
  const port = 56000 + (crypto.randomBytes(2).readUInt16BE(0) % 1000);
  execFileSync(path.join(bin, 'pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(dataDir, 'pg.log'),
    '-o', `-p ${port} -k ${dataDir} --listen-addresses=127.0.0.1`,
    'start',
  ], { stdio: 'pipe' });
  const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
  if (!url.includes('127.0.0.1')) throw new Error('throwaway pg must be loopback');
  const client = new pgMod.Client({ connectionString: url });
  try {
    await client.connect();
    for (const file of ['001_init.sql', '003_rename_hostel_to_client.sql', '004_payment_schema_phase2.sql']) {
      let sql = fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8');
      sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '');
      await client.query(sql);
    }
    const clientId = '10000000-0000-4000-8000-000000000001';
    await client.query('INSERT INTO clients(id,slug,name) VALUES($1,$2,$3)', [clientId, 'wolfhouse-somo', 'WH']);
    await client.query(
      `INSERT INTO bookings (id, client_id, booking_code, guest_name, status, check_in, check_out, guest_count, total_amount_cents, metadata)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'confirmed', $5, $6, 1, 41500, $7::jsonb)`,
      [
        '10000000-0000-4000-8000-000000000010',
        clientId,
        row.booking_code,
        'Pending Choice Guest',
        CHECK_IN,
        CHECK_OUT,
        JSON.stringify(row.metadata),
      ],
    );
    const read = await client.query(
      'SELECT id, booking_code, metadata FROM bookings WHERE booking_code = $1',
      [row.booking_code],
    );
    return read.rows[0];
  } finally {
    try { await client.end(); } catch (_) { /* closed */ }
    try {
      execFileSync(path.join(bin, 'pg_ctl'), ['-D', dataDir, '-m', 'fast', 'stop'], { stdio: 'pipe' });
    } catch (_) { /* already stopped */ }
  }
}

async function main() {
  assert.equal(
    /missing_payment_choice/.test(CREATE_SRC),
    false,
    'create service must not 400 missing_payment_choice',
  );

  const omittedBody = lunaBody();
  delete omittedBody.payment_choice;
  const omitted = await saveLuna(omittedBody);
  assert.equal(omitted.built.ok, true, JSON.stringify(omitted.built.body || omitted.built));
  assert.notEqual(omitted.built.body && omitted.built.body.reason_code, 'missing_payment_choice');
  assert.equal(omitted.built.command.paymentChoicePending, true);
  assert.equal(omitted.built.command.paymentChoice, null);
  assert.equal(omitted.out && omitted.out.ok, true, JSON.stringify(omitted.out && omitted.out.body));
  assert.ok(omitted.out.body.booking_id, 'omitted choice must return booking_id');
  assert.equal(omitted.out.body.payment_choice_pending, true);
  assert.equal(omitted.pg.committed(), true);
  const omittedMeta = metadataFrom(omitted.pg);
  assert.ok(omittedMeta);
  assert.equal(omittedMeta.payment_choice_pending, true);
  assert.equal(omittedMeta.payment_choice == null, true);
  assert.equal(omittedMeta.ask_payment_amount, true);

  const together = await saveLuna(lunaBody({
    payment_choice: undefined,
    payment_link_distribution: 'together',
    phone: '+346****2222',
    idempotency_key: 'together-only-1',
  }));
  assert.equal(together.built.ok, true, JSON.stringify(together.built.body || together.built));
  assert.notEqual(together.built.body && together.built.body.reason_code, 'missing_payment_choice');
  assert.equal(together.built.command.paymentChoicePending, true);
  assert.equal(together.out && together.out.ok, true, JSON.stringify(together.out && together.out.body));
  assert.ok(together.out.body.booking_id, 'together-only must return booking_id');
  assert.equal(together.out.body.payment_choice_pending, true);

  const deposit = await saveLuna(lunaBody({
    payment_choice: 'deposit',
    phone: '+346****3333',
    idempotency_key: 'deposit-choice-1',
  }));
  assert.equal(deposit.built.ok, true);
  assert.equal(deposit.built.command.paymentChoice, 'deposit');
  assert.equal(deposit.built.command.paymentChoicePending, false);
  assert.equal(deposit.out.ok, true);
  assert.ok(deposit.out.body.booking_id);
  assert.equal(deposit.out.body.payment_choice_pending, false);

  const full = await saveLuna(lunaBody({
    payment_choice: 'full',
    phone: '+346****4444',
    idempotency_key: 'full-choice-1',
  }));
  assert.equal(full.built.ok, true);
  assert.equal(full.built.command.paymentChoice, 'full');
  assert.equal(full.built.command.paymentKind, 'full_amount');
  assert.equal(full.out.ok, true);
  assert.ok(full.out.body.booking_id);

  const sqlRow = await sqlReadBack({
    booking_code: omitted.out.body.booking_code,
    metadata: omittedMeta,
  });
  assert.ok(sqlRow && sqlRow.id, 'SQL read-back returned id');
  const md = typeof sqlRow.metadata === 'string' ? JSON.parse(sqlRow.metadata) : sqlRow.metadata;
  assert.equal(md.payment_choice_pending, true);
  assert.equal(sqlRow.booking_code, omitted.out.body.booking_code);

  console.log('PASS missing payment_choice always saves', {
    omitted: omitted.out.body.booking_id,
    together: together.out.body.booking_id,
    deposit: deposit.out.body.booking_id,
    full: full.out.body.booking_id,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
