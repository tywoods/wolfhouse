#!/usr/bin/env node
'use strict';

// OFFLINE integration: real production HTTP router/auth + emitted browser handlers;
// session lookup and PostgreSQL alone are replaced with local in-memory fixtures.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
Object.assign(process.env, {
  NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
  STAFF_UI_BUILDER_TEST_SEAM: '1', STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false',
  STAFF_QUERY_API_HOST: '127.0.0.1', DEFAULT_CLIENT_SLUG: 'sunset',
  LUNA_BOT_CLIENT_SLUG: 'sunset', LUNA_BOT_INTERNAL_TOKEN: 'offline-intelligence-token-not-a-real-secret-002',
});
const api = require('./staff-query-api');
const slugs = ['sunset', 'wolfhouse-somo'];
const rows = slugs.map((slug, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`, slug,
  settings: { luna_personality: 'calm', inbox_channel_modes: { whatsapp: 'draft' }, other: { keep: true } },
}));
let failDb = false;
const queries = [];
const pg = { async query(sql, params) {
  queries.push({ sql, params });
  if (failDb) throw new Error('offline database failure');
  assert.match(sql, /(?:FROM|UPDATE) clients/);
  const row = rows.find((r) => r.id === params[0] || r.slug === params[0]);
  if (/UPDATE clients/.test(sql) && row) {
    assert.match(sql, /jsonb_set/);
    assert.match(sql, /\{luna_intelligence\}/);
    assert.match(sql, /to_jsonb\(\$2::boolean\)/);
    row.settings = { ...row.settings, luna_intelligence: params[1] };
  }
  return { rows: row ? [structuredClone(row)] : [] };
} };
api.setFortress15j3OfflineSeams({
  withPgClient: async (fn) => fn(pg),
  resolveSessionUser(req) {
    const cookie = req.headers.cookie || '';
    const row = rows.find((r) => cookie === `offline_session=${r.slug}`);
    if (cookie === 'offline_session=viewer') return { role: 'viewer', client_id: rows[0].id, client_slug: rows[0].slug };
    if (cookie === 'offline_session=missing') return { role: 'operator', client_id: '00000000-0000-4000-8000-000000000099', client_slug: 'sunset' };
    return row ? { role: 'operator', staff_user_id: 'offline-staff', client_id: row.id, client_slug: row.slug } : null;
  },
  canAccessClient: (user, slug) => user && user.client_slug === slug,
});
const server = api.createStaffQueryApiHttpServer();
let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  api.setFortress15j3OfflineSeams(null);
});
async function hit(path = '/staff/luna-intelligence', { slug = 'sunset', method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + path, {
    method, headers: { ...(slug ? { Cookie: `offline_session=${slug}` } : {}), 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

test('PUT persists only the principal tenant flag and preserves every sibling setting', async () => {
  const before = rows.map((r) => structuredClone(r.settings));
  for (const [i, row] of rows.entries()) {
    for (const enabled of [true, false]) {
      const res = await hit(undefined, { slug: row.slug, method: 'PUT', body: { enabled } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { success: true, client_slug: row.slug, enabled });
      assert.deepEqual(rows[i].settings, { ...before[i], luna_intelligence: enabled });
      assert.equal((await hit(undefined, { slug: row.slug })).body.enabled, enabled);
      if (i === 0) assert.deepEqual(rows[1].settings, before[1]);
    }
  }
});

test('write validation rejects non-booleans, malformed JSON and all caller tenant selectors without SQL', async () => {
  const start = queries.length;
  for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: null }, null, [], '{']) {
    const res = await hit(undefined, { method: 'PUT', body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  for (const method of ['GET', 'PUT']) {
    const res = await hit('/staff/luna-intelligence?client_slug=wolfhouse-somo', {
      method, ...(method === 'PUT' ? { body: { enabled: true } } : {}),
    });
    assert.equal(res.status, 400);
  }
  for (const selector of ['client_slug', 'client_id', 'tenant', 'settings']) {
    const res = await hit(undefined, { method: 'PUT', body: { enabled: true, [selector]: 'wolfhouse-somo' } });
    assert.equal(res.status, 400);
  }
  assert.equal(queries.length, start);
});

test('database failures and unknown principals never return a successful flag', async () => {
  for (const method of ['GET', 'PUT']) {
    const opts = { method, ...(method === 'PUT' ? { body: { enabled: true } } : {}) };
    const missing = await hit(undefined, { ...opts, slug: 'missing' });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'client_not_found');
    failDb = true;
    try {
      const failed = await hit(undefined, opts);
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.body, { success: false, error: method === 'GET' ? 'intelligence_read_failed' : 'intelligence_save_failed' });
    } finally { failDb = false; }
  }
});

test('bot GET uses canonical authenticated principal, never query tenant, and cannot write', async () => {
  const path = '/staff/bot/luna-intelligence';
  const headers = { 'X-Luna-Bot-Token': process.env.LUNA_BOT_INTERNAL_TOKEN };
  for (const row of rows) {
    process.env.LUNA_BOT_CLIENT_SLUG = row.slug;
    process.env.DEFAULT_CLIENT_SLUG = row.slug;
    row.settings.luna_intelligence = row.slug === 'sunset';
    const res = await hit(path, { slug: null, headers });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, client_slug: row.slug, enabled: row.slug === 'sunset' });
    const start = queries.length;
    assert.equal((await hit(path + '?client_slug=foreign', { slug: null, headers })).status, 400);
    assert.equal((await hit(path, { slug: null })).status, 401);
    assert.equal((await hit(path, { slug: null, headers: { 'X-Luna-Bot-Token': 'wrong' } })).status, 401);
    assert.notEqual((await hit(path, { slug: null, headers, method: 'PUT', body: { enabled: true } })).status, 200);
    assert.equal(queries.length, start);
  }
  process.env.LUNA_BOT_CLIENT_SLUG = 'sunset';
  process.env.DEFAULT_CLIENT_SLUG = 'sunset';
  failDb = true;
  try { assert.equal((await hit(path, { slug: null, headers })).status, 500); }
  finally { failDb = false; }
});

test('staff auth denies missing session, bot-only token and viewer before persistence', async () => {
  const start = queries.length;
  for (const method of ['GET', 'PUT']) {
    for (const slug of [null, 'viewer']) {
      const res = await hit(undefined, { slug, method, ...(method === 'PUT' ? { body: { enabled: true } } : {}) });
      assert.equal(res.status, slug ? 403 : 401);
    }
    assert.equal((await hit(undefined, { slug: null, method, headers: { 'X-Luna-Bot-Token': process.env.LUNA_BOT_INTERNAL_TOKEN }, ...(method === 'PUT' ? { body: { enabled: true } } : {}) })).status, 401);
  }
  assert.equal(queries.length, start);
});

// Chromium executes the exact emitted card and handlers, not a reimplementation.
// The surrounding portal is sliced out to avoid unrelated booking/email traffic.
async function browserSlice(browser, slug, cookieSlug = slug) {
  const html = api.buildUiHtmlForOfflineTest(0, slug);
  const card = html.match(/<section[^>]*id="staff-luna-personality-card"[\s\S]*?<\/section>/)[0];
  assert.match(card, /Luna Intelligence/);
  assert.match(card, /Let Luna search the web for surf, local info, and open guest questions\. Off = booking tools only\./);
  assert.match(card, /id="staff-luna-intelligence-toggle"[^>]*disabled/);
  const start = html.indexOf('function lunaIntelligenceLoad(');
  const end = html.indexOf('function wireLunaStaffTabCards(', start);
  assert.ok(start > 0 && end > start, 'emitted intelligence handlers present');
  assert.match(html, /function wireLunaStaffTabCards\(\)\{[\s\S]{0,400}lunaIntelligenceLoad\(/);
  const ctx = await browser.newContext();
  if (cookieSlug) await ctx.addCookies([{ name: 'offline_session', value: cookieSlug, url: base }]);
  const page = await ctx.newPage();
  await page.route('**/offline-intelligence-ui', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body>' + card + '<script>function el(id){return document.getElementById(id)}\n' + html.slice(start, end) + '\nlunaIntelligenceLoad();</script></body></html>',
  }));
  await page.goto(base + '/offline-intelligence-ui');
  return { ctx, page, toggle: page.locator('#staff-luna-intelligence-toggle'), status: page.locator('#staff-luna-intelligence-status') };
}

test('Chromium emitted switch loads, clicks, persists and reloads independently for both authenticated tenants', async () => {
  const browser = await require('playwright').chromium.launch({ headless: true });
  try {
    for (const [i, row] of rows.entries()) {
      rows.forEach((r) => { delete r.settings.luna_intelligence; });
      const sibling = structuredClone(rows[1 - i].settings);
      const { ctx, page, toggle } = await browserSlice(browser, row.slug);
      await page.waitForFunction(() => !document.getElementById('staff-luna-intelligence-toggle').disabled);
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await toggle.click();
      await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-toggle').getAttribute('aria-checked') === 'true');
      assert.equal(row.settings.luna_intelligence, true);
      assert.deepEqual(rows[1 - i].settings, sibling);
      await page.reload();
      await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-toggle').getAttribute('aria-checked') === 'true');
      await toggle.click();
      await page.waitForFunction(() => !document.getElementById('staff-luna-intelligence-toggle').disabled);
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      assert.equal(row.settings.luna_intelligence, false);
      assert.equal(row.settings.luna_personality, 'calm');
      assert.deepEqual(row.settings.inbox_channel_modes, { whatsapp: 'draft' });
      await ctx.close();
    }
  } finally { await browser.close(); }
});

test('Chromium failed load or save shows an error, stays disabled and never advertises unsaved state', async () => {
  const browser = await require('playwright').chromium.launch({ headless: true });
  try {
    for (const row of rows) {
      for (const cookie of [null, 'viewer', row.slug]) {
        failDb = cookie === row.slug;
        const { ctx, page, toggle, status } = await browserSlice(browser, row.slug, cookie);
        await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-status').textContent.startsWith('Could not'));
        assert.match(await status.textContent(), /Could not load/);
        assert.equal(await toggle.isDisabled(), true);
        assert.equal(await toggle.getAttribute('aria-checked'), 'false');
        await ctx.close();
        failDb = false;
      }
      for (const enabled of [true, false]) {
        row.settings.luna_intelligence = enabled;
        const { ctx, page, toggle, status } = await browserSlice(browser, row.slug);
        await page.waitForFunction(() => !document.getElementById('staff-luna-intelligence-toggle').disabled);
        failDb = true;
        await toggle.click();
        await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-status').textContent.startsWith('Could not'));
        assert.match(await status.textContent(), /Could not save/);
        assert.equal(await toggle.getAttribute('aria-checked'), String(enabled));
        assert.equal(row.settings.luna_intelligence, enabled);
        assert.equal(await toggle.isDisabled(), true);
        failDb = false;
        await page.evaluate(() => lunaIntelligenceLoad());
        assert.equal(await toggle.isDisabled(), false);
        await ctx.clearCookies();
        await toggle.click();
        await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-status').textContent.startsWith('Could not'));
        assert.match(await status.textContent(), /Could not save/);
        assert.equal(row.settings.luna_intelligence, enabled);
        await ctx.close();
      }
    }
  } finally { failDb = false; await browser.close(); }
});

test('Chromium ignores duplicate clicks and tab reloads while a save is pending', async () => {
  const browser = await require('playwright').chromium.launch({ headless: true });
  let release;
  try {
    rows[0].settings.luna_intelligence = false;
    const { ctx, page, toggle } = await browserSlice(browser, 'sunset');
    await page.waitForFunction(() => !document.getElementById('staff-luna-intelligence-toggle').disabled);
    let gets = 0;
    let puts = 0;
    const barrier = new Promise((resolve) => { release = resolve; });
    await page.route('**/staff/luna-intelligence', async (route) => {
      if (route.request().method() === 'PUT') { puts++; await barrier; }
      else gets++;
      await route.continue();
    });
    await toggle.click();
    await page.evaluate(() => {
      document.getElementById('staff-luna-intelligence-toggle').dispatchEvent(new Event('click'));
      lunaIntelligenceLoad();
    });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'no optimistic enable');
    assert.equal(await toggle.isDisabled(), true);
    // Flush a browser round trip so intercepted fetch events have run.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(gets, 0, 'reopening tab must not race the pending save');
    assert.equal(puts, 1);
    release();
    await page.waitForFunction(() => document.getElementById('staff-luna-intelligence-toggle').getAttribute('aria-checked') === 'true');
    assert.equal(rows[0].settings.luna_intelligence, true);
    await ctx.close();
  } finally { if (release) release(); await browser.close(); }
});

test('authenticated reads default OFF for both tenants and enable only stored boolean true', async () => {
  for (const row of rows) {
    for (const value of [undefined, null, false, 'true', 1, {}, true]) {
      row.settings.luna_intelligence = value;
      const res = await hit(undefined, { slug: row.slug });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { success: true, client_slug: row.slug, enabled: value === true });
    }
    delete row.settings.luna_intelligence;
  }
});
