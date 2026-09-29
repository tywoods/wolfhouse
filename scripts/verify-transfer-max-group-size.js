'use strict';

// Offline only: production validator/routes/store/resolver with in-process PGlite.
const assert = require('node:assert/strict');
const { validateTransferRuleBody } = require('./lib/wolfhouse-pricing-writes');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const body = (extra = {}) => ({ airport_code: 'SDR', label: 'Santander', ...extra });

test('validator retains configured max 8', () => {
  const parsed = validateTransferRuleBody(body({ max_guest_count: 8 }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.max_guest_count, 8);
});

test('validator accepts only optional integer max 1..99', () => {
  for (const value of [true, false, [], [8], {}, 0, -1, 100, 1.5, NaN, Infinity, 'garbage', '8x', '8.5', undefined]) {
    const parsed = validateTransferRuleBody(body({ max_guest_count: value }));
    assert.equal(parsed.ok, false, `must reject ${String(value)} (${typeof value})`);
    assert.match(parsed.error, /max_guest_count/);
  }
  for (const value of [1, 99, '8', ' 8 ']) {
    const parsed = validateTransferRuleBody(body({ max_guest_count: value }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.max_guest_count, Number(value));
  }
  for (const value of [null, '', '   ']) {
    const parsed = validateTransferRuleBody(body({ max_guest_count: value }));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value.max_guest_count, null);
  }
  assert.equal(Object.hasOwn(validateTransferRuleBody(body()).value, 'max_guest_count'), false,
    'omission is distinct from explicit clear');
});

test('validator rejects max below min', () => {
  for (const max of [7, 8, 9, null]) {
    const parsed = validateTransferRuleBody(body({ min_guest_count: 8, max_guest_count: max,
      unavailable_below_min_group_message: 'Minimum eight' }));
    assert.equal(parsed.ok, max !== 7);
    if (max === 7) assert.match(parsed.error, /max_guest_count.*min_guest_count/);
  }
});

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const store = require('./lib/wolfhouse-pricing-store');
const WH = 'wolfhouse-somo';
const migrationPath = path.join(__dirname, '../database/migrations/109_wh_transfer_max_guest_count.sql');
async function oldSchema(db) {
  await db.exec(`CREATE TABLE staff_users (id uuid PRIMARY KEY);
    CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at=NOW(); RETURN NEW; END $$;`);
  await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/076_wolfhouse_pricing_admin.sql'), 'utf8'));
}
// PGlite exec is the pg multi-statement no-parameter query equivalent.
const pgFor = db => ({ query: async (sql, args) => {
  if (process.env.TRANSFER_MAX_SQL_TRACE === '1') console.error('SQL', sql.slice(0, 110), args);
  return args ? db.query(sql, args) : db.exec(sql).then(r => r[r.length - 1]);
} });

test('schema upgrade is additive idempotent and constrains max', async () => {
  assert.ok(fs.existsSync(migrationPath), 'additive migration 109 must exist');
  for (const mode of ['migration', 'runtime-existing', 'runtime-fresh']) {
    const db = new PGlite();
    try {
      if (mode !== 'runtime-fresh') {
        await oldSchema(db);
        await db.query("INSERT INTO wh_pricing_transfer_rules (client_slug,airport_code,label,min_guest_count) VALUES ($1,'SDR','Legacy',4)", [WH]);
      }
      const upgrade = () => mode === 'migration' ? db.exec(fs.readFileSync(migrationPath, 'utf8')) : store.ensureWolfhousePricingTables(pgFor(db));
      await upgrade();
      await upgrade();
      if (mode === 'runtime-fresh') await db.query("INSERT INTO wh_pricing_transfer_rules (client_slug,airport_code,label,min_guest_count) VALUES ($1,'SDR','Legacy',4)", [WH]);
      const stored = async () => (await db.query('SELECT label,min_guest_count,max_guest_count FROM wh_pricing_transfer_rules')).rows[0];
      assert.deepEqual(await stored(), { label: 'Legacy', min_guest_count: 4, max_guest_count: null }, mode);
      for (const max of [0, -1, 100, 3]) {
        await assert.rejects(db.query('UPDATE wh_pricing_transfer_rules SET max_guest_count=$1', [max]),
          err => err.code === '23514', `${mode} rejects ${max}`);
      }
      for (const max of [4, 99, null]) {
        await db.query('UPDATE wh_pricing_transfer_rules SET max_guest_count=$1', [max]);
        assert.equal((await stored()).max_guest_count, max);
      }
      await db.query('UPDATE wh_pricing_transfer_rules SET max_guest_count=8');
      await assert.rejects(db.query('UPDATE wh_pricing_transfer_rules SET min_guest_count=9'), err => err.code === '23514');
      await upgrade();
      assert.equal((await stored()).max_guest_count, 8, 're-upgrade preserves saved maximum');
    } finally { await db.close(); }
  }
});

async function createHarness() {
  const db = new PGlite();
  const pg = pgFor(db);
  const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
  const routes = createWolfhousePricingRoutes({
    withPgClient: fn => fn(pg),
    sendJSON: (res, status, payload) => Object.assign(res, { status, body: payload }),
    send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
    readBody: async req => req.body,
    assertStaffClientAccess: (user, slug) => user.client_slug === slug,
    appendAuditLog() {}, DEFAULT_CLIENT: WH, SQL_INJECT_RE: /[;'"\\\\]/,
    STAFF_AUTH_REQUIRED: true, resolveStaffRole: user => user.role,
  });
  async function dispatch(method, suffix = '', payload = {}, slug = WH) {
    const handler = routes.match(`/staff/admin/wh/pricing${suffix}`, method);
    assert.ok(handler, 'production route must match');
    const res = {};
    await handler({ client: slug }, { body: JSON.stringify(payload) }, res, { role: 'admin', client_slug: slug });
    return res;
  }
  return { db, pg, routes, dispatch, close: () => db.close() };
}
const transfer = response => response.body.transfers.find(row => row.airport_code === 'SDR');

test('real admin route save reload persists max 8 through store and resolver', async () => {
  const h = await createHarness();
  try {
    const saved = await h.dispatch('PUT', '/transfers', body({ max_guest_count: 8 }));
    assert.equal(saved.status, 200, JSON.stringify(saved));
    assert.equal((await h.db.query("SELECT max_guest_count FROM wh_pricing_transfer_rules WHERE client_slug=$1 AND airport_code='SDR'", [WH])).rows[0].max_guest_count, 8,
      'independent SQL must confirm persistence');
    assert.equal(transfer(saved).max_guest_count, 8);
    assert.equal((await store.loadTransferRules(h.pg, WH))[0].max_guest_count, 8);
    const reloaded = await h.dispatch('GET');
    assert.equal(reloaded.body.overlay_available, true);
    assert.equal(transfer(reloaded).max_guest_count, 8);
  } finally { await h.close(); }
});

test('real admin update replaces clears and preserves omitted max', async () => {
  const h = await createHarness();
  try {
    const save = extra => h.dispatch('PUT', '/transfers', body(extra));
    const stored = async () => (await h.db.query("SELECT max_guest_count FROM wh_pricing_transfer_rules WHERE client_slug=$1 AND airport_code='SDR' AND active", [WH])).rows[0].max_guest_count;
    assert.equal((await save({})).status, 200);
    assert.equal(await stored(), null, 'legacy insert stores null');
    for (const max of [8, 1, 99, '', 8, null, 8, '   ']) {
      const saved = await save({ max_guest_count: max });
      assert.equal(saved.status, 200);
      const expected = typeof max === 'string' || max === null ? null : max;
      assert.equal(await stored(), expected, `update ${JSON.stringify(max)}`);
      assert.equal(transfer(saved).max_guest_count, expected);
      assert.equal(transfer(await h.dispatch('GET')).max_guest_count, expected);
    }
    await save({ max_guest_count: 8 });
    const legacy = await save({ label: 'Legacy editor' });
    assert.equal(legacy.status, 200);
    assert.equal(await stored(), 8, 'legacy update must not erase configured max');
    assert.equal(transfer(legacy).max_guest_count, 8);
  } finally { await h.close(); }
});

test('config fallback exposes nullable max including retired overlays', async () => {
  const { configTransferRules } = require('./lib/wolfhouse-pricing-resolve');
  const seed = configTransferRules({ airports: [{ code: 'MAD', label: 'Madrid' }],
    rules: [{ airport_code: 'MAD', max_guest_count: 9 }] });
  assert.equal(seed.eligibility[0].max_guest_count, 9);
  const h = await createHarness();
  try {
    assert.equal(transfer(await h.dispatch('GET')).max_guest_count, null, 'unconfigured default is explicit null');
    await h.dispatch('PUT', '/transfers', body({ max_guest_count: 8 }));
    await h.dispatch('DELETE', '/transfers/SDR');
    const fallback = transfer(await h.dispatch('GET'));
    assert.equal(fallback.source, 'config');
    assert.equal(fallback.max_guest_count, null, 'retired overlay does not leak maximum');
    await h.dispatch('PUT', '/transfers', body({ airport_code: 'MAD', max_guest_count: 8 }));
    await h.dispatch('DELETE', '/transfers/MAD');
    assert.equal((await h.dispatch('GET')).body.transfers.some(row => row.airport_code === 'MAD'), false);
  } finally { await h.close(); }
});

test('Staff admin_prices projects max without capacity enforcement or repricing', async () => {
  const { createHarness: createBookingHarness } = require('./verify-transfer-admin-price-custom');
  const h = await createBookingHarness();
  try {
    await store.ensureWolfhousePricingTables(pgFor(h.db));
    const { loadStaffTransferConfig } = require('./lib/staff-transfer-pricing');
    for (const max of [1, 8, null]) {
      const parsed = validateTransferRuleBody(body({ max_guest_count: max }));
      await store.saveTransferRule(h.pg, WH, parsed.value, null);
      assert.equal((await h.db.query("SELECT max_guest_count FROM wh_pricing_transfer_rules WHERE airport_code='SDR'")).rows[0].max_guest_count, max);
      for (const unit of ['flat', 'per_person']) {
        await h.adminFare('SDR', 1950, unit);
        const config = await loadStaffTransferConfig(h.pg, WH);
        assert.equal(config.rules.find(row => row.airport_code === 'SDR').max_guest_count, max);
        const get = await h.dispatch('GET');
        assert.equal(get.status, 200);
        assert.equal(get.body.admin_prices.SDR.max_guest_count, max);
        const embedded = h.routes.buildTransfersDrawerPayload(WH, { booking_id: h.bookingId, guest_count: 3 }, await h.saved(), { resolvedConfig: config });
        assert.equal(embedded.admin_prices.SDR.max_guest_count, max);
        assert.equal(get.body.admin_prices.BIO.max_guest_count, null);
        const post = await h.dispatch('POST');
        assert.equal(post.status, 200, 'metadata maximum does not introduce capacity enforcement');
        assert.equal((await h.saved())[0].price_cents, unit === 'flat' ? 1950 : 5850);
        const custom = await h.dispatch('POST', { manual_override_enabled: true, manual_override_euros: 0 });
        assert.equal(custom.status, 200);
        const before = await h.saved();
        assert.equal(before[0].price_cents, 0);
        await h.dispatch('GET');
        assert.deepEqual(await h.saved(), before, 'reference read never reprices Custom Price');
      }
    }
  } finally { await h.close(); }
});

async function main() {
  // Reclaim each WASM database with its process; close() alone can retain its
  // heap until GC, which starves parallel offline browser gates on small hosts.
  if (!process.argv[2]) {
    const { spawnSync } = require('node:child_process');
    for (const { name } of tests) {
      const child = spawnSync(process.execPath, [__filename, name], { stdio: 'inherit', timeout: 60000 });
      if (child.error) throw child.error;
      assert.equal(child.status, 0, `failed: ${name}`);
    }
    return;
  }
  const previousFlag = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  try {
    for (const { name, run } of tests) {
      if (process.argv[2] && !name.includes(process.argv[2])) continue;
      await run();
      console.log(`PASS ${name}`);
    }
  } finally {
    if (previousFlag === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = previousFlag;
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
