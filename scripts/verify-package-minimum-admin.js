'use strict';

// Entirely offline: production resolver/routes/store and browser module; isolated PGlite only.
const assert = require('assert/strict');
const resolve = require('./lib/wolfhouse-pricing-resolve');
const tests = [];
function test(name, run) { tests.push({ name, run }); }
const policy = (value) => ({ item_type: 'policy', item_code: 'package_min_nights', active: true, metadata: { minimum_nights: value } });

test('JSON seed and shared resolver project the same nights into admin and effective config', () => {
  const config = resolve.loadPricingConfig();
  assert.equal(config.package_min_nights, 7);
  assert.equal(typeof resolve.resolvePackageMinimumNights, 'function');
  for (const [rows, expected] of [[[], { value: 7, source: 'config' }], [[policy(9)], { value: 9, source: 'db' }]]) {
    assert.deepEqual(resolve.resolvePackageMinimumNights(config, rows), expected);
    assert.deepEqual(resolve.buildAdminPricingView({ config, dbItems: rows }).extras.package_min_nights, expected);
    assert.equal(resolve.applyOverlayPackageItemsToConfig(structuredClone(config), rows).package_min_nights, expected.value);
  }
  for (const value of [undefined, null, '', ' ', true, false, 0, -1, 2.5, '7', [], {}, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(resolve.resolvePackageMinimumNights({ package_min_nights: value }, []).value, null);
    assert.deepEqual(resolve.resolvePackageMinimumNights(config, [policy(value)]), { value: null, source: 'db' });
    assert.equal(resolve.applyOverlayPackageItemsToConfig(structuredClone(config), [policy(value)]).package_min_nights, null);
  }
  assert.equal(resolve.resolvePackageMinimumNights(config, [{ ...policy(9), active: false }]).value, 7);
});

const BASE = '/staff/admin/wh/pricing';
const ADMIN = { role: 'admin', staff_user_id: '00000000-0000-4000-8000-000000000001' };
async function harness() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  await db.waitReady;
  const pg = { query: async (sql, params) => {
    if (!params && sql.includes('CREATE TABLE')) { await db.exec(sql); return { rows: [] }; }
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows };
  } };
  const audit = [];
  const deps = {
    sendJSON: (res, status, body) => Object.assign(res, { status, body }),
    send400: (res, error) => Object.assign(res, { status: 400, body: { success: false, error } }),
    readBody: async (req) => req.body,
    assertStaffClientAccess: (user, slug, res) => {
      if (user && user.denied) { Object.assign(res, { status: 403 }); return false; }
      return true;
    },
    appendAuditLog: (entry) => audit.push(entry),
    withPgClient: (run) => run(pg), DEFAULT_CLIENT: 'wolfhouse-somo',
    SQL_INJECT_RE: /[;'"\\]/, STAFF_AUTH_REQUIRED: true, resolveStaffRole: (u) => u.role,
  };
  const makeRoutes = () => require('./lib/wolfhouse-pricing-routes').createWolfhousePricingRoutes(deps);
  let routes = makeRoutes();
  return {
    db, audit,
    restart: () => { routes = makeRoutes(); },
    call: async (path = BASE, method = 'GET', body, user = ADMIN, client = 'wolfhouse-somo') => {
      const handler = routes.match(path, method);
      assert.equal(typeof handler, 'function', `${method} ${path} must have a handler`);
      const res = {};
      await handler({ client }, { body: JSON.stringify(body) }, res, user);
      return res;
    },
  };
}

test('dedicated route saves policy through SQL and rereads; permission gates and invalid writes preserve it', async () => {
  const before = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  const h = await harness();
  try {
    const path = BASE + '/package-minimum';
    for (const minimum_nights of [9, 4]) {
      const saved = await h.call(path, 'PUT', { minimum_nights });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.extras.package_min_nights, { value: minimum_nights, source: 'db' });
      h.restart();
      assert.deepEqual((await h.call()).body.extras.package_min_nights, saved.body.extras.package_min_nights);
    }
    const sql = await h.db.query("SELECT * FROM wh_pricing_items WHERE item_type = 'policy'");
    assert.equal(sql.rows.length, 1);
    assert.equal(sql.rows[0].client_slug, 'wolfhouse-somo');
    assert.equal(sql.rows[0].item_code, 'package_min_nights');
    assert.equal(sql.rows[0].label, 'Package Night minimum');
    assert.deepEqual(sql.rows[0].metadata, { minimum_nights: 4 });
    assert.equal(sql.rows[0].updated_by, ADMIN.staff_user_id);
    for (const minimum_nights of [undefined, null, '', ' ', true, false, 0, -1, 1.5, [], {}, '4', Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await h.call(path, 'PUT', { minimum_nights })).status, 400, `reject ${JSON.stringify(minimum_nights)}`);
    }
    assert.equal((await h.call(BASE + '/items', 'PUT', { ...policy(2), label: 'Bypass' })).status, 400);
    assert.equal((await h.call(BASE + '/items/policy/package_min_nights', 'DELETE')).status, 400);
    assert.equal((await h.call(path, 'PUT', { minimum_nights: 2 }, null)).status, 401);
    for (const role of ['viewer', 'operator']) {
      assert.equal((await h.call(path, 'PUT', { minimum_nights: 2 }, { role })).status, 403);
    }
    assert.equal((await h.call(path, 'PUT', { minimum_nights: 2 }, { ...ADMIN, denied: true })).status, 403);
    assert.equal((await h.call(path, 'PUT', { minimum_nights: 2 }, ADMIN, 'sunset')).status, 404);
    process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'false';
    assert.equal((await h.call(path, 'PUT', { minimum_nights: 2 })).status, 403);
    assert.deepEqual((await h.call()).body.extras.package_min_nights, { value: 4, source: 'db' });
    assert.equal(h.audit.filter((a) => a.intent === 'api:admin.wh.pricing.package_minimum_save' && a.success).length, 2);
  } finally {
    await h.db.close();
    if (before === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = before;
  }
});

test('browser Extras edit/input/save uses nights, validates input, and rereads saved SQL policy', async () => {
  const fs = require('fs');
  const path = require('path');
  const { chromium } = require('playwright');
  const before = process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
  process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'true';
  const h = await harness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const ledger = [], blocked = [], errors = [];
  const evidence = process.env.PACKAGE_MINIMUM_EVIDENCE_DIR;
  page.on('pageerror', (err) => errors.push(err.message));
  try {
    // Isolated host for the unmodified production module; no reconstructed setting markup.
    const moduleSource = fs.readFileSync(path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js'), 'utf8');
    await context.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      ledger.push({ method: req.method(), path: url.pathname, body: req.postDataJSON() });
      if (url.origin === 'http://staff.test' && req.method() === 'GET' && url.pathname === '/') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline Package minimum module proof</title><div id="wh-admin-pricing-body"></div><script>' + moduleSource + '</script>' });
      }
      if (url.origin === 'http://staff.test' && ((req.method() === 'GET' && url.pathname === BASE)
        || (req.method() === 'PUT' && url.pathname === BASE + '/package-minimum'))) {
        const result = await h.call(url.pathname, req.method(), req.postDataJSON());
        return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
      }
      blocked.push(req.url());
      return route.abort();
    });
    await page.goto('http://staff.test');
    await page.evaluate(() => window.loadWolfhouseAdminPricing());
    const extras = page.locator('section').filter({ has: page.locator('.portal-admin-section-hdr-title', { hasText: /^Extras$/ }) });
    assert.equal(await extras.getByText('Package Night minimum', { exact: true }).count(), 1, 'Extras must show Package Night minimum');
    const card = page.locator('[data-wh-package-minimum]');
    assert.match(await card.innerText(), /7 nights/);
    assert.doesNotMatch(await card.innerText(), /€/);
    await card.locator('[data-wh-price-action="edit-package-minimum"]').click();
    const input = page.locator('#wh-price-package-minimum');
    assert.equal(await input.getAttribute('type'), 'number');
    assert.equal(await input.getAttribute('step'), '1');
    assert.equal(await input.inputValue(), '7');
    const saves = () => ledger.filter((r) => r.method === 'PUT').length;
    for (const invalid of ['', '0', '-1', '2.5']) {
      await input.fill(invalid);
      await page.locator('[data-wh-price-action="save-package-minimum"]').click();
      assert.equal(await input.evaluate((el) => el.checkValidity()), false);
      assert.equal(saves(), 0);
    }
    await input.fill('9');
    await page.locator('[data-wh-price-action="save-package-minimum"]').click();
    await page.waitForFunction(() => document.querySelector('[data-wh-package-minimum]')?.textContent.includes('9 nights'));
    assert.equal(saves(), 1);
    assert.deepEqual(ledger.find((r) => r.method === 'PUT').body, { minimum_nights: 9 });
    assert.match(await card.innerText(), /edited/);
    assert.doesNotMatch(await card.innerText(), /€/);
    h.restart();
    await page.reload();
    await page.evaluate(() => window.loadWolfhouseAdminPricing());
    assert.match(await card.innerText(), /9 nights/);
    const stored = await h.db.query("SELECT metadata FROM wh_pricing_items WHERE item_type = 'policy' AND item_code = 'package_min_nights'");
    assert.deepEqual(stored.rows[0].metadata, { minimum_nights: 9 });
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      await card.screenshot({ path: path.join(evidence, 'browser-saved-policy.png') });
    }
    process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = 'false';
    await page.evaluate(() => window.loadWolfhouseAdminPricing({ force: true }));
    assert.equal(await card.locator('button').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  } finally {
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      fs.writeFileSync(path.join(evidence, 'browser-ledger.json'), JSON.stringify({ ledger, blocked, errors }, null, 2));
    }
    await browser.close();
    await h.db.close();
    if (before === undefined) delete process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED;
    else process.env.WOLFHOUSE_ADMIN_WRITES_ENABLED = before;
  }
});

(async () => {
  for (const { name, run } of tests) {
    await run();
    console.log('PASS', name);
  }
  console.log(`PASS ${tests.length} Package minimum admin gates (offline)`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
