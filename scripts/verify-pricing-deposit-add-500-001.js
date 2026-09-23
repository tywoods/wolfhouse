'use strict';

// Offline PostgreSQL-engine regression, not a staging proof. No network or DSN.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const store = require('./lib/wolfhouse-pricing-store');
const { createWolfhousePricingRoutes } = require('./lib/wolfhouse-pricing-routes');
const slug = 'wolfhouse-somo';
const actor = '00000000-0000-4000-8000-000000000001';

async function main() {
  const db = new PGlite();
  const previous = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  const errors = [];
  const pg = {
    async query(sql, params) {
      try {
        return params ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
      } catch (err) {
        errors.push({ code: err.code, message: err.message, constraint: err.constraint });
        throw err;
      }
    },
  };
  try {
    await db.exec(`CREATE TABLE staff_users (id UUID PRIMARY KEY);
      INSERT INTO staff_users VALUES ('${actor}');
      CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;`);
    // Exact shipped migration, including CHECKs and FKs that fake-pg tests omit.
    await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/076_wolfhouse_pricing_admin.sql'), 'utf8'));
    if (!process.argv.includes('--baseline')) {
      await db.exec(fs.readFileSync(path.join(__dirname, '../database/migrations/106_wh_pricing_catalog_extra_types.sql'), 'utf8'));
    }
    let response;
    const routes = createWolfhousePricingRoutes({
      sendJSON: (_res, status, body) => { response = { status, body }; },
      send400: (_res, error) => { response = { status: 400, body: { success: false, error } }; },
      readBody: async (req) => JSON.stringify(req.body),
      assertStaffClientAccess: (user, client) => user.client_slug === client,
      appendAuditLog: () => {}, withPgClient: async (fn) => fn(pg),
      DEFAULT_CLIENT: slug, SQL_INJECT_RE: /['";\\]|--/,
      STAFF_AUTH_REQUIRED: true, resolveStaffRole: (user) => user.role,
    });
    async function request(suffix, body, scope = slug, user = { role: 'admin', staff_user_id: actor, client_slug: slug }) {
      const handler = routes.match('/staff/admin/wh/pricing' + suffix, body ? 'PUT' : 'GET');
      assert.equal(typeof handler, 'function');
      response = undefined;
      await handler({ client: scope }, { body }, {}, user);
      return response;
    }
    const season = await request('/seasons', { code: 'qa_season', label: 'QA season',
      ranges: [{ start_month: 9, start_day: 1, end_month: 9, end_day: 30 }] });
    assert.equal(season.status, 200, JSON.stringify(errors));
    console.log('PASS migrated-schema season Save with valid staff actor');
    const item = await request('/items', { item_type: 'deposit', item_code: 'standard_deposit', label: 'Standard deposit' });
    if (item.status !== 200) console.error('POSTGRES_FAILURE', JSON.stringify(errors));
    assert.equal(item.status, 200, 'Add deposit identity Save must succeed against migration 076');
    for (const unit of ['per_booking', 'per_person']) {
      const price = await request('/prices', { item_type: 'deposit', item_code: 'standard_deposit', unit, amount_eur: '25.50' });
      assert.equal(price.status, 200, JSON.stringify(errors));
      const read = await request('');
      const deposit = read.body.extras.deposits.find((row) => row.code === 'standard_deposit');
      assert.ok(deposit, 'new deposit appears on refreshed catalog');
      const saved = await store.loadRules(pg, slug);
      assert.ok(saved.some((row) => row.item_code === 'standard_deposit' && row.unit === unit && row.amount_cents === 2550));
      console.log('PASS Add deposit Save/read-back ' + unit);
    }
    assert.equal(errors.length, 0, 'no hidden SQL errors on successful saves/reads');
    const extra = { item_type: 'supplement', item_code: 'qa_extra', label: 'QA extra' };
    assert.equal((await request('/items', extra)).status, 200);
    assert.equal((await request('/items', { ...extra, item_type: 'unknown' })).status, 400);
    assert.equal((await request('/items', extra, 'sunset')).status, 404);
    assert.equal((await request('/items', extra, slug, { role: 'operator', client_slug: slug })).status, 403);
    process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'false';
    assert.equal((await request('/items', extra)).status, 403);
    process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
    console.log('PASS supplement, invalid-type validation, Sunset isolation, role and write-flag fences');
    // Reapplying the repair preserves exact catalog rows, not just their count.
    const migration = fs.readFileSync(path.join(__dirname, '../database/migrations/106_wh_pricing_catalog_extra_types.sql'), 'utf8');
    const before = await store.loadItems(pg, slug);
    await db.exec(migration);
    assert.deepEqual(await store.loadItems(pg, slug), before);
    await assert.rejects(db.query(`INSERT INTO wh_pricing_items
      (client_slug, item_type, item_code, label) VALUES ($1, $2, $3, $4)`,
    [slug, 'unknown', 'invalid_type', 'Invalid type']), { code: '23514', constraint: 'wh_pricing_items_item_type_check' });
    await assert.rejects(store.saveItem(pg, slug, { ...extra, item_code: 'missing_actor', active: true },
      '00000000-0000-4000-8000-000000000099'), { code: '23503' });
    console.log('PASS idempotent repair preserves rows, invalid SQL types rejected, staff FK retained');
    // Real module in Chromium; only the outer portal/auth shell is omitted.
    // Fetches dispatch to the production handlers and PostgreSQL-engine store.
    if (process.argv.includes('--browser')) await browserProof(request, db);
    const fresh = new PGlite();
    try {
      await fresh.exec(migration);
      assert.equal((await fresh.query("SELECT to_regclass('public.wh_pricing_items') AS name")).rows[0].name, null);
      await store.ensureWolfhousePricingTables({ query: (sql) => fresh.exec(sql) });
      await fresh.exec(migration);
      await fresh.query(`INSERT INTO wh_pricing_items (client_slug,item_type,item_code,label)
        VALUES ($1,$2,$3,$4)`, [slug, 'deposit', 'fresh_deposit', 'Fresh deposit']);
      await assert.rejects(fresh.query(`INSERT INTO wh_pricing_items (client_slug,item_type,item_code,label)
        VALUES ($1,$2,$3,$4)`, [slug, 'unknown', 'bad', 'Bad']), { code: '23514' });
      console.log('PASS absent table no-op and runtime-created schema upgrade');
    } finally { await fresh.close(); }
  } finally {
    if (previous === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = previous;
    await db.close();
  }
}
async function browserProof(request, db) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const receipts = [];
    await page.route('http://pricing.invalid/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><html><body><main id="wh-admin-pricing-body"></main></body></html>' });
      assert.ok(url.pathname.startsWith('/staff/admin/wh/pricing'));
      const body = route.request().postDataJSON();
      const result = await request(url.pathname.slice('/staff/admin/wh/pricing'.length), body, url.searchParams.get('client'));
      receipts.push({ path: url.pathname, method: route.request().method(), status: result.status });
      return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
    });
    await page.goto('http://pricing.invalid/');
    await page.addScriptTag({ path: path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js') });
    await page.evaluate(() => window.loadWolfhouseAdminPricing());
    for (const unit of ['per_booking', 'per_person']) {
      await page.locator('[data-wh-price-action="new-extra"]').click();
      await page.locator('#wh-price-extra-kind').selectOption('deposit');
      await page.locator('#wh-price-item-label').fill('Browser ' + unit);
      await page.locator('#wh-price-item-amount').fill('19.75');
      await page.locator('input[name="wh-deposit-scope"][value="' + unit + '"]').check();
      const start = receipts.length;
      await page.locator('[data-wh-price-action="save-new-extra"]').click();
      await page.waitForFunction(() => !window.__whPricingStateForTest.busy);
      assert.equal(await page.evaluate(() => window.__whPricingStateForTest.error), null);
      assert.match(await page.locator('#wh-admin-pricing-body').innerText(), /Saved\./);
      assert.deepEqual(receipts.slice(start).filter((r) => r.method === 'PUT').map((r) => r.status), [200, 200]);
      await page.evaluate(() => window.loadWolfhouseAdminPricing({ force: true }));
      const rows = await db.query(`SELECT i.label, r.unit, r.amount_cents
        FROM wh_pricing_items i JOIN wh_pricing_rules r
          ON r.client_slug=i.client_slug AND r.item_type=i.item_type AND r.item_code=i.item_code
        WHERE i.client_slug=$1 AND i.label=$2 AND i.active AND r.active`, [slug, 'Browser ' + unit]);
      assert.deepEqual(rows.rows, [{ label: 'Browser ' + unit, unit, amount_cents: 1975 }]);
      assert.match(await page.locator('#wh-admin-pricing-body').innerText(), /€19\.75/);
      console.log('PASS Chromium actual Add deposit Save → items 200 → prices 200 → DB read-back: ' + unit);
    }
    assert.deepEqual(pageErrors, []);
  } finally { await browser.close(); }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
