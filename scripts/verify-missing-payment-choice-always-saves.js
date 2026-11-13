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
  nextActionAfterWolfhouseCreate,
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

function loadPglite() {
  const Module = require('node:module');
  const scratch = '/tmp/pglite-scratch/node_modules';
  if (fs.existsSync(path.join(scratch, '@electric-sql/pglite'))) {
    process.env.NODE_PATH = [scratch, process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
    Module._initPaths();
  }
  return require('@electric-sql/pglite').PGlite;
}

async function capSqlMissingTierProof() {
  loadPglite();
  const { boundary } = require('./verify-wolfhouse-always-save');
  const { actualApiFunction } = require('./verify-package-minimum-transport');
  const service = require('./lib/luna-front-desk-accommodation-booking-create-service');
  const { mapBotBookingCreateBlockedHttp } = require('./lib/booking-guests');
  const SLUG = 'wolfhouse-somo';

  function julyBody(overrides = {}) {
    const body = {
      confirm: true,
      check_in: '2026-07-06',
      check_out: '2026-07-13',
      guest_count: 2,
      guest_name: 'Alex',
      guests: [{ name: 'Alex' }, { name: 'Sam' }],
      phone: '+34611110000',
      package_code: 'malibu',
      room_type: 'shared',
      selected_bed_codes: ['R1-B1', 'R1-B2'],
      ...overrides,
    };
    if (!Object.prototype.hasOwnProperty.call(overrides, 'payment_choice')) {
      delete body.payment_choice;
    }
    return body;
  }

  async function staffCreate(pg, payload) {
    const handleCreate = actualApiFunction('handleBotBookingCreate', {
      ...service,
      mapBotBookingCreateBlockedHttp,
      DEFAULT_CLIENT: SLUG,
      STAFF_AUTH_REQUIRED: false,
      readBody: async () => JSON.stringify(payload),
      sendJSON: (_res, status, body) => ({ status, body }),
      send400: (_res, error) => ({ status: 400, body: { error } }),
      stampBookingCreateSource: require('./lib/booking-create-source-attribution').stampBookingCreateSource,
      resolveBotHandlerTrustedClientSlug: () => SLUG,
      withPgClient: (fn) => fn(pg),
      loadWolfhouseQuoteConfigWithOverlay: async () => {
        const { loadConfig: bundled } = require('./lib/wolfhouse-quote-calculator');
        const config = structuredClone(bundled());
        config.seasons = [{
          code: 'summer', active: true, bookable: true,
          ranges: [{ start_month: 7, start_day: 1, end_month: 7, end_day: 31 }],
        }];
        return config;
      },
      resolveWolfhouseAutomaticBookingAdmission: async () => ({ allowed: true }),
      isGeneratedBookingCodeCollision: () => false,
      appendAuditLog: () => {},
    });
    return handleCreate({ headers: { 'x-luna-guest-phone': payload.phone } }, {}, null, 'bot_token');
  }

  async function saveAndRead(label, payload) {
    const pg = await boundary();
    try {
      const result = await staffCreate(pg, payload);
      assert.notEqual(result.status, 400, `${label} must not 400: ${JSON.stringify(result)}`);
      assert.equal(result.status, 201, `${label} ${JSON.stringify(result)}`);
      assert.equal(result.body.success, true);
      assert.ok(result.body.booking_id, `${label} missing booking_id`);
      const bookings = (await pg.db.query('SELECT * FROM bookings')).rows;
      assert.equal(bookings.length, 1, `${label} expected one booking`);
      assert.equal(String(bookings[0].id), String(result.body.booking_id));
      assert.ok(pg.calls.some((c) => c.sql.includes('inserted_booking_beds AS')), `${label} no SQL INSERT`);
      assert.ok(pg.calls.some((c) => c.sql === 'COMMIT'), `${label} no COMMIT`);
      return { pg, result, bookings };
    } catch (err) {
      await pg.db.close();
      throw err;
    }
  }

  for (const [label, extra] of [
    ['unspecified', { idempotency_key: 'missing-tier-unspecified' }],
    ['together', { payment_link_distribution: 'together', phone: '+34611110001', idempotency_key: 'missing-tier-together' }],
    ['separate', { payment_link_distribution: 'separate', phone: '+34611110002', idempotency_key: 'missing-tier-separate' }],
  ]) {
    const { pg, result, bookings } = await saveAndRead(label, julyBody(extra));
    try {
      assert.equal(result.body.next_action, 'ask_deposit_or_full', `${label} next_action`);
      assert.equal(result.body.creates_stripe_link, false);
      const retry = await staffCreate(pg, julyBody(extra));
      assert.equal(String(retry.body.booking_id), String(result.body.booking_id), `${label} retry booking_id`);
      assert.equal((await pg.db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1, `${label} retry duplicate`);
      assert.equal(bookings[0].status, 'confirmed');
    } finally {
      await pg.db.close();
    }
  }

  for (const [label, choice] of [['deposit', 'deposit'], ['full', 'full']]) {
    const { pg, result } = await saveAndRead(label, julyBody({
      payment_choice: choice,
      phone: choice === 'deposit' ? '+34611112001' : '+34611112002',
      idempotency_key: `explicit-${choice}`,
    }));
    try {
      assert.equal(result.body.next_action, 'create_stripe_link', `${label} next_action`);
    } finally {
      await pg.db.close();
    }
  }
}

async function main() {
  assert.equal(
    /missing_payment_choice/.test(CREATE_SRC),
    false,
    'create service must not 400 missing_payment_choice',
  );

  const apiSrc = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  assert.match(apiSrc, /nextActionAfterWolfhouseCreate\(cmd\)/,
    'bot create 201 must pick next_action from the create command, not always create_stripe_link');
  assert.equal(nextActionAfterWolfhouseCreate({ paymentChoicePending: true }), 'ask_deposit_or_full');
  assert.equal(nextActionAfterWolfhouseCreate({ paymentChoicePending: false, paymentChoice: 'deposit' }), 'create_stripe_link');
  assert.equal(nextActionAfterWolfhouseCreate({ paymentChoice: 'full' }), 'create_stripe_link');

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
  assert.equal(nextActionAfterWolfhouseCreate(omitted.built.command), 'ask_deposit_or_full');
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
  assert.equal(nextActionAfterWolfhouseCreate(together.built.command), 'ask_deposit_or_full');

  const separate = await saveLuna(lunaBody({
    payment_choice: undefined,
    payment_link_distribution: 'separate',
    phone: '+346****5555',
    idempotency_key: 'separate-only-1',
  }));
  assert.equal(separate.built.ok, true, JSON.stringify(separate.built.body || separate.built));
  assert.equal(separate.built.command.paymentChoicePending, true);
  assert.equal(separate.out && separate.out.ok, true, JSON.stringify(separate.out && separate.out.body));
  assert.ok(separate.out.body.booking_id, 'separate-only must return booking_id');
  assert.equal(nextActionAfterWolfhouseCreate(separate.built.command), 'ask_deposit_or_full');

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
  assert.equal(nextActionAfterWolfhouseCreate(deposit.built.command), 'create_stripe_link');

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

  await capSqlMissingTierProof();

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
