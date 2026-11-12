'use strict';
// Isolated PostgreSQL + Chromium. All browser requests are intercepted and
// dispatched to real Admin handlers; no Staff server, external DB or payments.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
const { loadWolfhouseDepositRates } = require('./lib/wolfhouse-stay-deposit');
const { savePriceRule } = require('./lib/wolfhouse-pricing-store');
const SLUG = 'wolfhouse-somo';
const ACTOR = '00000000-0000-4000-8000-000000000001';
async function main() {
  const db = new PGlite();
  const previous = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  const queries = [];
  const pg = { async query(sql, params) {
    queries.push(String(sql));
    return params ? db.query(sql, params) : (await db.exec(sql)).at(-1);
  } };
  let browser;
  try {
    await db.exec(`CREATE TABLE staff_users (id UUID PRIMARY KEY);
      INSERT INTO staff_users VALUES ('${ACTOR}');
      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;`);
    for (const file of ['076_wolfhouse_pricing_admin.sql', '106_wh_pricing_catalog_extra_types.sql']) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8'));
    }
    for (const [code, amount] of [['standard_package', 25750], ['custom_or_short_stay', 13225]]) {
      await savePriceRule(pg, SLUG, { item_type: 'deposit', item_code: code, season_code: null,
        unit: 'per_person', amount_cents: amount, currency: 'EUR', active: true }, ACTOR);
    }
    let response;
    const routes = createWolfhousePricingRoutes({
      sendJSON: (_res, status, body) => { response = { status, body }; },
      send400: (_res, error) => { response = { status: 400, body: { error } }; },
      readBody: async req => JSON.stringify(req.body), assertStaffClientAccess: (user, client) => user.client_slug === client,
      appendAuditLog: () => {}, withPgClient: async fn => fn(pg), DEFAULT_CLIENT: SLUG,
      SQL_INJECT_RE: /['";\\]|--/, STAFF_AUTH_REQUIRED: true, resolveStaffRole: user => user.role,
    });
    assert.equal(typeof routes.match('/staff/admin/wh/pricing/deposit-policy', 'PUT'), 'function', 'one atomic policy endpoint');
    const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/134_wolfhouse_nights_deposit.sql'), 'utf8');
    const { applyAndVerify } = require('./lib/france-staging-nights-deposit-migration');
    await assert.rejects(applyAndVerify({ query: async () => ({ rows: [{ database: 'wolfhouse_prod' }] }) }, migration), /staging_database_required/);
    // PGlite's fixed database name differs; only its identity SELECT is adapted.
    // Every migration and settings query runs against the real isolated engine.
    const migrationPg = { query: (sql, params) => sql === 'SELECT current_database() AS database'
      ? Promise.resolve({ rows: [{ database: 'wolfhouse_staging' }] }) : pg.query(sql, params) };
    await applyAndVerify(migrationPg, migration);
    assert.deepEqual(await loadWolfhouseDepositRates(pg), {
      nights_threshold: 6, short_stay_cents: 13225, long_stay_cents: 25750, source: 'admin_pricing',
    }, 'migration keeps existing custom amounts and seeds X=6');
    async function request(suffix, body, status = 200, role = 'admin') {
      response = undefined;
      const handler = routes.match('/staff/admin/wh/pricing' + suffix, body ? 'PUT' : 'GET');
      assert.equal(typeof handler, 'function');
      await handler({ client: SLUG }, { body }, {}, { role, staff_user_id: ACTOR, client_slug: SLUG });
      assert.equal(response.status, status, JSON.stringify(response));
      return response.body;
    }
    const policy = { nights_threshold: 8, short_stay_eur: '143.50', long_stay_eur: '286.75' };
    await request('/deposit-policy', policy);
    const desired = { nights_threshold: 8, short_stay_cents: 14350, long_stay_cents: 28675, source: 'admin_pricing' };
    assert.deepEqual((await request('')).extras.deposit_policy, desired);
    await db.exec(migration);
    assert.deepEqual(await loadWolfhouseDepositRates(pg), desired, 'migration rerun must not reset edited settings');
    for (const bad of [{ ...policy, nights_threshold: 0 }, { ...policy, long_stay_eur: '-1' }]) {
      await request('/deposit-policy', bad, 400);
      assert.deepEqual(await loadWolfhouseDepositRates(pg), desired);
    }
    await request('/deposit-policy', policy, 403, 'viewer');
    await db.exec('BEGIN READ ONLY');
    queries.length = 0;
    assert.deepEqual(await loadWolfhouseDepositRates(pg), desired);
    assert(queries.every(sql => /^\s*SELECT/.test(sql)), 'read-only consumer performs no DDL or writes');
    await db.exec('ROLLBACK');
    console.log('PASS numbered migration, custom amount preservation, rerun, atomic save/readback, validation, auth and read-only loader');
    browser = await require('playwright').chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== 'http://pricing.invalid') return route.abort();
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<main id="wh-admin-pricing-body"></main>' });
      const body = await request(url.pathname.slice('/staff/admin/wh/pricing'.length), route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://pricing.invalid/');
    await page.addScriptTag({ path: path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js') });
    await page.evaluate(() => window.loadWolfhouseAdminPricing());
    await page.locator('[aria-controls="wh-pricing-collapse-extras"]').click();
    assert.equal(await page.locator('[data-wh-deposit-policy]').count(), 1);
    assert.doesNotMatch(await page.locator('#wh-admin-pricing-body').innerText(), /Accommodation only · per person|With package · per person/);
    await page.locator('[data-wh-price-action="edit-deposit-policy"]').click();
    await page.locator('#wh-deposit-threshold').fill('6');
    await page.locator('#wh-deposit-under').fill('100');
    await page.locator('#wh-deposit-over').fill('200');
    await page.locator('[data-wh-price-action="save-deposit-policy"]').click();
    await page.waitForFunction(() => !window.__whPricingStateForTest.busy);
    assert.equal(await page.evaluate(() => window.__whPricingStateForTest.error), null);
    assert.deepEqual(await loadWolfhouseDepositRates(pg), {
      nights_threshold: 6, short_stay_cents: 10000, long_stay_cents: 20000, source: 'admin_pricing',
    });
    assert.match(await page.locator('[data-wh-deposit-policy]').innerText(), /6/);
    assert.deepEqual(errors, []);
    console.log('PASS Chromium single card: edit all three settings → real handler → PostgreSQL → fresh readback; no page errors');
  } finally {
    if (browser) await browser.close();
    if (previous === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = previous;
    await db.close();
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
