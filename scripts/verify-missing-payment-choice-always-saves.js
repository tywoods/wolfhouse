'use strict';

/**
 * Offline Staff handler -> real builder/executor -> production atomic SQL ->
 * committed readback of the returned booking_id. No booking/payment mocks.
 *
 * node --max-old-space-size=1024 scripts/verify-missing-payment-choice-always-saves.js
 * Supply NODE_PATH when PGlite is installed in a shared dependency directory.
 * --baseline replays the original Staff/create-service sources from the local
 * authorized parent commit, without reverting files being edited in parallel.
 * Explicit deposit/full only schedules create_stripe_link; the plugin proof
 * separately owns link-call assertions. This gate never calls Stripe.
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./verify-luna-create-booking-occupants');
const { actualApiFunction } = require('./verify-package-minimum-transport');
const { buildManualBookingCreateSql } = require('./lib/staff-manual-booking-create-sql');
const BASELINE = '30272c361f9611065d80f060fcc0d4af17b14c47';
const baseline = process.argv.includes('--baseline');
const apiPath = path.join(__dirname, 'staff-query-api.js');
const servicePath = path.join(__dirname, 'lib/luna-front-desk-accommodation-booking-create-service.js');
const normalizeSql = sql => String(sql).replace(/\s+/g, ' ').trim();
const atomicSql = normalizeSql(buildManualBookingCreateSql());
const SLUG = 'wolfhouse-somo';
const PHONE = '+999000001682'; // Synthetic, valid authenticated-turn phone; no delivery.

function historicalSource(relativePath) {
  return execFileSync('git', ['show', `${BASELINE}:${relativePath}`], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
}
function loadService() {
  if (!baseline) return require(servicePath);
  const loaded = new Module(servicePath, module);
  loaded.filename = servicePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(servicePath));
  loaded._compile(historicalSource('scripts/lib/luna-front-desk-accommodation-booking-create-service.js'), servicePath);
  return loaded.exports;
}
const service = loadService();
const baselineApi = baseline ? historicalSource('scripts/staff-query-api.js') : null;
function staffHandler(deps) {
  if (!baseline) return actualApiFunction('handleBotBookingCreate', deps);
  const start = baselineApi.indexOf('async function handleBotBookingCreate(');
  const end = baselineApi.indexOf('\n}\n', start);
  assert(start >= 0 && end > start, 'historical production handler anchors');
  return vm.runInNewContext(`(${baselineApi.slice(start, end + 2)})`, {
    console, Date, Buffer, require: Module.createRequire(apiPath), ...deps,
  }, { filename: `staff-query-api.js@${BASELINE}:handleBotBookingCreate` });
}

// Fail closed on even an attempted outbound connection, including attempts that
// production catches. Only in-process WASM SQL and local source reads are used.
let networkAttempts = 0;
function denyNetwork() {
  networkAttempts += 1;
  throw new Error('Network forbidden by missing-payment-choice SQL proof');
}
require('node:net').Socket.prototype.connect = denyNetwork;
require('node:tls').connect = denyNetwork;
for (const name of ['node:http', 'node:https']) {
  require(name).request = denyNetwork;
  require(name).get = denyNetwork;
}
globalThis.fetch = denyNetwork;

function bookingBody(label, overrides) {
  return {
    confirm: true, check_in: '2026-07-06', check_out: '2026-07-13',
    guest_count: 2, guest_name: 'Offline Alex',
    guests: [{ name: 'Offline Alex' }, { name: 'Offline Sam' }],
    phone: PHONE, package_code: 'malibu', room_type: 'shared',
    selected_bed_codes: ['R1-B1', 'R1-B2'],
    idempotency_key: `missing-payment-choice-${label}`, ...overrides,
  };
}

async function seed(db) {
  // Same repository seed/migrations as fixtures/first-yes-sql.js. Only inventory,
  // pricing and portal prerequisites are seeded, NEVER saved booking results.
  await seedOfflineBookingDb(db, { phone: PHONE, guest_name: 'Offline Alex' });
  await db.exec(`
    ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents integer;
    ALTER TABLE clients ADD COLUMN settings jsonb DEFAULT '{}'::jsonb;
    UPDATE clients SET settings='{"inbox_channel_modes":{"whatsapp":"auto"}}'::jsonb;
    ALTER TABLE conversations ADD COLUMN needs_human boolean NOT NULL DEFAULT false;
    ALTER TABLE conversations ADD COLUMN last_staff_reply_at timestamptz;
    CREATE TABLE bot_pause_states (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_slug text NOT NULL,
      guest_phone text, conversation_id text, paused boolean NOT NULL DEFAULT true,
      paused_by text NOT NULL);
    UPDATE rooms SET room_type='mixed', gender_strategy='Flexible', capacity=2,
      can_be_matrimonial=false, often_used_by_operator=false, selling_mode='shared',
      fill_priority=1 WHERE room_code='R1';
    UPDATE beds SET active=bed_number<=2 WHERE room_id=(SELECT id FROM rooms WHERE room_code='R1');
    ALTER TABLE payments ADD COLUMN stripe_checkout_session_id text;
    ALTER TABLE payments ADD COLUMN checkout_url text;
  `);
  assert.equal((await db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 0);
}

function noCheckout(value, label) {
  if (Array.isArray(value)) return value.forEach((v, i) => noCheckout(v, `${label}[${i}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:stripe_checkout_session_id|stripe_session_id|checkout_session_id|checkout_url|stripe_checkout_url|payment_url|payment_link_url|stripe_url)$/.test(key)) {
      assert.ok(child == null || child === '', `${label}.${key} must not exist before link creation`);
    }
    if (typeof child === 'string') {
      assert.doesNotMatch(child, /https?:\/\/(?:checkout|buy)\.stripe\.com\//, `${label}.${key}`);
      assert.doesNotMatch(child, /^cs_(?:test|live)_/, `${label}.${key}`);
    }
    noCheckout(child, `${label}.${key}`);
  }
}

async function runScenario(db, label, overrides, pending) {
  // Empty the prior case, not an artificial readback fixture. Every saved row
  // below must originate from this case's production Staff create request.
  await db.exec('TRUNCATE bookings CASCADE');
  // conversations references bookings, so CASCADE also removes the seeded
  // contact. Restore only the authenticated-turn prerequisite for this case.
  await db.query(`INSERT INTO conversations (client_id, phone, display_name, language)
    SELECT id, $1, 'Offline Alex', 'en' FROM clients WHERE slug=$2`, [PHONE, SLUG]);
  const calls = [], errors = [];
  const pg = { async query(sql, params = []) {
    const call = { sql: normalizeSql(sql) };
    calls.push(call);
    try {
      const result = await db.query(sql, params);
      call.rows = result.rows;
      return result; // No SQL rewrite, canned rows, or suppressed query failure.
    } catch (error) {
      errors.push(error.message);
      throw error;
    }
  } };
  const payload = bookingBody(label, overrides);
  const handle = staffHandler({
    ...service,
    ...require('./lib/booking-guests'),
    ...require('./lib/booking-create-source-attribution'),
    ...require('./lib/staff-manual-booking-create-sql'),
    ...require('./lib/staff-booking-portal-policy'),
    ...require('./lib/staff-bot-request-tenant-bind'),
    DEFAULT_CLIENT: SLUG, STAFF_AUTH_REQUIRED: false,
    readBody: async () => JSON.stringify(payload),
    sendJSON: (_res, status, body) => ({ status, body }),
    send400: (_res, error) => ({ status: 400, body: { error } }),
    withPgClient: fn => fn(pg),
    loadWolfhouseQuoteConfigWithOverlay: () => service.loadBookingQuoteConfigWithOverlay(pg),
    appendAuditLog() {}, // Local logging boundary only, not business behavior.
  });
  const request = () => handle({ headers: { 'x-luna-guest-phone': PHONE } }, {}, null, 'bot_token');
  const created = await request();
  assert.deepEqual(errors, [], `${label}: all production SQL must execute`);
  assert.equal(created.status, 201, `${label}: ${JSON.stringify(created)}`);
  assert.equal(created.body.success, true);
  assert.equal(created.body.created, true);
  assert.equal(created.body.write_performed, true);
  assert.ok(created.body.booking_id);
  const writes = calls.filter(c => c.sql === atomicSql);
  assert.equal(writes.length, 1, `${label}: exact production atomic INSERT must execute once`);
  assert.equal(writes[0].rows[0].booking_id, created.body.booking_id);
  assert.equal(calls.filter(c => c.sql === 'COMMIT').length, 1, `${label}: committed`);
  assert.ok(calls.findIndex(c => c.sql === 'BEGIN') < calls.indexOf(writes[0]));
  assert.ok(calls.indexOf(writes[0]) < calls.findIndex(c => c.sql === 'COMMIT'));
  assert.ok(!calls.some(c => c.sql === 'ROLLBACK'));

  async function readSaved() {
    const rows = (await db.query('SELECT * FROM bookings WHERE id=$1::uuid', [created.body.booking_id])).rows;
    assert.equal(rows.length, 1, `${label}: same returned booking_id is durable`);
    assert.equal((await db.query('SELECT count(*)::int n FROM bookings')).rows[0].n, 1);
    const saved = rows[0];
    assert.equal(saved.id, created.body.booking_id);
    assert.equal(saved.booking_code, created.body.booking_code);
    assert.equal(saved.status, 'confirmed');
    assert.equal(saved.metadata.idempotency_key, payload.idempotency_key);
    assert.equal(saved.metadata.payment_choice_pending, pending, `${label}: saved payment_choice_pending`);
    assert.equal(saved.metadata.ask_payment_amount, pending, `${label}: saved ask_payment_amount`);
    assert.equal(saved.metadata.payment_choice, pending ? null : overrides.payment_choice);
    const related = {};
    for (const table of ['booking_beds', 'booking_guests', 'payments', 'booking_service_records']) {
      related[table] = (await db.query(`SELECT * FROM ${table} WHERE booking_id=$1::uuid ORDER BY id`, [saved.id])).rows;
    }
    assert.equal(related.booking_beds.length, 2);
    assert.deepEqual(related.booking_beds.map(b => b.bed_code).sort(), payload.selected_bed_codes);
    assert.equal(related.booking_guests.length, 2);
    assert.equal(related.payments.length, 1, 'draft payment is allowed; a checkout is not');
    assert.equal(related.payments[0].status, 'draft');
    assert.equal(related.payments[0].payment_kind, overrides.payment_choice === 'full' ? 'full_amount' : 'deposit_only');
    noCheckout({ saved, related }, `${label}: persisted`);
    return { saved, related };
  }
  const beforeRetry = await readSaved();
  const retry = await request();
  assert.deepEqual(errors, [], `${label}: retry SQL must execute without hidden failures`);
  assert.equal(retry.status, 200, `${label}: ${JSON.stringify(retry)}`);
  assert.equal(retry.body.success, true);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.created, false);
  assert.equal(retry.body.write_performed, false);
  assert.equal(retry.body.booking_id, created.body.booking_id);
  assert.equal(retry.body.booking_code, created.body.booking_code);
  assert.deepEqual(await readSaved(), beforeRetry, `${label}: retry cannot change persisted rows/counts`);
  assert.ok(calls.some(c => c.sql.includes('offer_idempotency_lookup') && c.rows.some(r => r.booking_id === created.body.booking_id)),
    `${label}: idempotency must recover the actual SQL row`);
  assert.equal(calls.filter(c => c.sql === atomicSql).length, 1, `${label}: retry must not insert again`);
  assert.equal(calls.filter(c => c.sql === 'COMMIT').length, 1);
  assert.equal(networkAttempts, 0);
  console.log(`SQL ${label}: HTTP ${created.status}/${retry.status}, booking_id=${created.body.booking_id}, bookings=1, beds=2, guests=2, payments=1, COMMIT=1, retry unchanged`);

  // Check both transport envelopes after proving the entire real SQL journey.
  const failures = [];
  for (const response of [created, retry]) {
    noCheckout(response.body, `${label}: HTTP ${response.status}`);
    assert.equal(response.body.creates_stripe_link, false);
    assert.equal(response.body.sends_whatsapp, false);
    for (const [key, expected] of Object.entries({
      payment_choice_pending: pending, ask_payment_amount: pending,
      next_action: pending ? 'ask_deposit_or_full' : 'create_stripe_link',
    })) {
      if (response.body[key] !== expected) {
        failures.push(`${label} HTTP ${response.status} ${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(response.body[key])}`);
      }
    }
  }
  assert.deepEqual(failures, [], 'Staff response must preserve the committed payment-choice state');
  console.log(`PASS ${label}: SQL metadata and HTTP 201/200 agree; next_action=${created.body.next_action}; no Stripe session/checkout URL`);
}

async function main() {
  console.log(`Missing payment choice real SQL proof (${baseline ? `baseline ${BASELINE}` : 'working tree'})`);
  const db = new PGlite();
  const failures = [];
  try {
    await seed(db);
    for (const [label, overrides, pending] of [
      ['missing', {}, true],
      ['empty', { payment_choice: '' }, true],
      ['unspecified', { payment_choice: 'unspecified' }, true],
      ['together', { payment_link_distribution: 'together' }, true],
      ['separate', { payment_link_distribution: 'separate' }, true],
      ['deposit', { payment_choice: 'deposit' }, false],
      ['full', { payment_choice: 'full' }, false],
    ]) {
      try { await runScenario(db, label, overrides, pending); }
      catch (error) {
        failures.push(label);
        console.error(`FAIL ${label}: ${error.stack || error}`);
        // Recover only for independent cases; the failed case remains failed.
        await db.exec('ROLLBACK');
      }
    }
    assert.equal(networkAttempts, 0, 'no outbound network attempts, even caught ones');
    assert.deepEqual(failures, [], 'all missing-choice and explicit-choice SQL scenarios must pass');
    console.log('PASS missing payment_choice always saves: 7 real SQL scenarios, HTTP 201 + idempotent 200, no network/Stripe');
  } finally {
    await db.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
