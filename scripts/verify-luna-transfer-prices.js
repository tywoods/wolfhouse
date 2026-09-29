'use strict';

// Offline contract gate: production handler + read-only overlay SQL in PGlite.
// No Staff API listener, external DB, booking write or guest message.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const WH = 'wolfhouse-somo';

async function createHarness() {
  const db = new PGlite();
  const queries = [];
  try {
    await db.exec(`CREATE TABLE staff_users (id uuid PRIMARY KEY);
      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END $$;`);
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/076_wolfhouse_pricing_admin.sql'), 'utf8'));
    const migration = path.join(__dirname, '../database/migrations/109_wh_transfer_max_guest_count.sql');
    if (fs.existsSync(migration)) await db.exec(fs.readFileSync(migration, 'utf8'));
    const modulePath = path.join(__dirname, 'lib/staff-bot-transfer-prices.js');
    assert.ok(fs.existsSync(modulePath), 'read-only transfer-price handler must exist');
    const { createBotTransferPricesHandler } = require(modulePath);
    const pg = { query: async (sql, args) => {
      assert.match(sql.trim(), /^SELECT\b/i, 'production reads must not perform DDL/catalog/booking writes');
      queries.push({ sql, args });
      return db.query(sql, args);
    } };
    const sendJSON = (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    const handler = createBotTransferPricesHandler({ withPgClient: fn => fn(pg), sendJSON });
    const invoke = async (slug = WH) => {
      const req = { _botBoundClientSlug: slug };
      const res = { end(text) { this.body = JSON.parse(text); } };
      await handler(req, res);
      return { status: res.statusCode, body: res.body };
    };
    return { db, pg, queries, invoke, handler, sendJSON, close: () => db.close() };
  } catch (error) { await db.close(); throw error; }
}

async function verifyRoute() {
  const source = fs.readFileSync(path.join(__dirname, 'staff-query-api.js'), 'utf8');
  const start = source.indexOf("  if (pathname === '/staff/bot/transfers/prices') {");
  assert.notEqual(start, -1, 'POST transfer-price route must be wired');
  const end = source.indexOf('\n  }', start) + '\n  }'.length;
  const route = source.slice(start, end);
  const wrapper = source.match(/async function dispatchBotRouteBoundToPrincipalTenant\([^]*?\n\}/)[0];

  const bind = require('./lib/staff-bot-request-tenant-bind');
  const vm = require('node:vm');
  const h = await createHarness();
  let authCalls = 0;
  try {
    const context = vm.createContext({
      ...bind, STAFF_AUTH_REQUIRED: true, userCanAccessClient: (user, slug) => user.client_slug === slug,

      readBody: async req => req._cachedBody,
      sendJSON: h.sendJSON, send400: (res, error) => h.sendJSON(res, 400, { success: false, error }),
      requireBotAuth: async (req, res) => {
        authCalls++;
        if (!req.auth.ok) h.sendJSON(res, 401, { success: false });
        return req.auth;
      },
      handleBotTransferPrices: h.handler,
    });
    const dispatch = vm.runInContext(`${wrapper}\n(async function(req, res, method, parsed) {
      const pathname = '/staff/bot/transfers/prices'; ${route}\n})`, context);
    async function call({ method = 'POST', slug = WH, body = {}, query = {}, ok = true } = {}) {
      const req = { _cachedBody: typeof body === 'string' ? body : JSON.stringify(body),
        auth: { ok, auth_mode: 'bot_token', user: { client_slug: slug, role: 'bot_internal' } } };
      const res = { writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
        end(text) { this.body = JSON.parse(text); } };
      const outcome = await dispatch(req, res, method, { query });
      if (outcome && outcome.result) await outcome.result;
      return res;
    }
    assert.equal((await call()).statusCode, 200, 'omission must bind authenticated Wolfhouse');
    const before = h.queries.length;
    for (const options of [
      { slug: 'sunset' }, { slug: '' }, { body: { client_slug: 'sunset' } },
      { query: { client: 'sunset' } }, { body: { client_slug: null } },
    ]) assert.equal((await call(options)).statusCode, 403, JSON.stringify(options));
    assert.equal((await call({ body: '{' })).statusCode, 400);
    assert.equal((await call({ ok: false })).statusCode, 401);
    const previousAuthCalls = authCalls;
    const wrongMethod = await call({ method: 'GET' });
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(wrongMethod.headers.Allow, 'POST');
    assert.equal(authCalls, previousAuthCalls, 'method gate before authentication');
    assert.equal(h.queries.length, before, 'denied routes never query SQL');
    console.log('PASS extracted production route + principal binding: auth denial, body/query spoofing, Sunset, malformed JSON, POST-only');
  } finally { await h.close(); }
}

async function main() {
  await verifyRoute();
  const h = await createHarness();
  try {
    const result = await h.invoke();
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.client_slug, WH);
    assert.equal(result.body.read_only, true);
    assert.equal(result.body.availability_checked, false);
    assert.deepEqual(result.body.transfers, [
      { airport_code: 'SDR', label: 'Santander', price: { amount_cents: 2500, currency: 'EUR', unit: 'flat', source: 'config' },
        eligibility: { min_guest_count: null, max_guest_count: null, requires_package: false, included_when_package: true, source: 'config' } },
      { airport_code: 'BIO', label: 'Bilbao', price: { amount_cents: 1500, currency: 'EUR', unit: 'per_person', source: 'config' },
        eligibility: { min_guest_count: 4, max_guest_count: null, requires_package: true, included_when_package: false, source: 'config' } },
    ]);
    assert.equal(h.queries.length, 2);
    assert.ok(h.queries.every(q => q.args[0] === WH));
    console.log('PASS config fallback through real SQL/handler JSON: both units, nullable bounds, no availability/write');
    await verifyConfigured(h);
    console.log('PASS production validator/store -> independent SQL -> Luna JSON: max 1/8/99/null, prices unchanged, reader SELECT-only');
    const queryCount = h.queries.length;
    for (const slug of ['sunset', '', 'unknown', null]) {
      const denied = await h.invoke(slug);
      assert.equal(denied.status, 403, `unsupported/unbound tenant ${slug} must be denied`);
      assert.equal(denied.body.success, false);
      assert.equal(denied.body.error, 'unsupported_client');
      assert.equal(denied.body.transfers, undefined);
    }
    assert.equal(h.queries.length, queryCount, 'tenant denial must precede DB access');
    console.log('PASS unsupported/unbound tenants: denied before SQL');
    await h.db.exec('DROP TABLE wh_pricing_rules');
    const failure = await h.invoke();
    assert.deepEqual(failure, { status: 503, body: { success: false, error: 'transfer_prices_unavailable' } },
      'SQL failure must not fall back to a successful config-only response');
    console.log('PASS real SQL failure: closed without fake prices');
  } finally { await h.close(); }
}

async function verifyConfigured(h, values = [1, 8, 99, null]) {
  const { validateTransferRuleBody } = require('./lib/wolfhouse-pricing-writes');
  const { saveTransferRule } = require('./lib/wolfhouse-pricing-store');
  let result;
  for (const max of values) {
    const parsed = validateTransferRuleBody({ airport_code: 'SDR', label: 'Santander',
      aliases: [], requires_package: false, min_guest_count: 1,
      max_guest_count: max, included_when_package: true, active: true,
      unavailable_below_min_group_message: 'At least one guest required.' });
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    // Fixture setup uses the production writer, never the read-only pg seam.
    await saveTransferRule(h.db, WH, parsed.value, null);
    const sql = await h.db.query("SELECT max_guest_count FROM wh_pricing_transfer_rules WHERE client_slug=$1 AND airport_code='SDR'", [WH]);
    assert.equal(sql.rows[0].max_guest_count, max);
    const before = await h.db.query('SELECT * FROM wh_pricing_transfer_rules ORDER BY airport_code');
    result = await h.invoke();
    assert.equal(result.status, 200);
    const row = result.body.transfers.find(r => r.airport_code === 'SDR');
    assert.equal(row.eligibility.max_guest_count, max);
    assert.equal(row.eligibility.min_guest_count, 1);
    assert.equal(row.eligibility.source, 'db');
    assert.deepEqual(row.price, { amount_cents: 2500, currency: 'EUR', unit: 'flat', source: 'config' });
    assert.deepEqual(await h.db.query('SELECT * FROM wh_pricing_transfer_rules ORDER BY airport_code'), before);
  }
  const custom = validateTransferRuleBody({ airport_code: 'MAD', label: 'Madrid', aliases: [],
    requires_package: false, min_guest_count: null, max_guest_count: 4,
    included_when_package: false, active: true });
  assert.equal(custom.ok, true);
  await saveTransferRule(h.db, WH, custom.value, null);
  result = await h.invoke();
  const missingFare = result.body.transfers.find(r => r.airport_code === 'MAD');
  assert.equal(missingFare.price, null, 'missing custom fare must not become free or disappear');
  assert.equal(missingFare.eligibility.max_guest_count, 4);
  return result;
}

async function captureContract(configured = false) {
  const h = await createHarness();
  try { return configured ? await verifyConfigured(h, [8]) : await h.invoke(); } finally { await h.close(); }
}

if (require.main === module) {
  const json = process.argv.includes('--json') || process.argv.includes('--configured-json');
  const run = json ? captureContract(process.argv.includes('--configured-json')).then(result => console.log(JSON.stringify(result))) : main();
  run.catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { createHarness, captureContract, main };
