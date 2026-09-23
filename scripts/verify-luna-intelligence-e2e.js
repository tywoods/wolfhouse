#!/usr/bin/env node
'use strict';

// OFFLINE cross-language integration. No staging, model, or public-provider
// network traffic. Fixture provider output is NOT live search evidence.
// Run: node --test scripts/verify-luna-intelligence-e2e.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
Object.assign(process.env, {
  NODE_ENV: 'test', STAFF_RUNTIME_PROFILE: 'test', STAFF_API_FORTRESS_OFFLINE_LISTENER: '1',
  STAFF_UI_BUILDER_TEST_SEAM: '1', STAFF_AUTH_REQUIRED: 'true', STAFF_AUTH_HTTPS: 'false',
  STAFF_QUERY_API_HOST: '127.0.0.1', DEFAULT_CLIENT_SLUG: 'sunset',
  LUNA_BOT_CLIENT_SLUG: 'sunset', LUNA_BOT_INTERNAL_TOKEN: 'offline-e2e-fixture-token-not-a-secret',
});
const api = require('./staff-query-api');
const tenants = ['sunset', 'wolfhouse-somo'];
const origins = { sunset: 'https://sunset-staging.lunafrontdesk.com', 'wolfhouse-somo': 'https://staff-staging.lunafrontdesk.com' };
const roles = { sunset: 'sunset-luna', 'wolfhouse-somo': 'luna' };
const rows = tenants.map((slug, i) => ({
  id: `00000000-0000-4000-8000-00000000000${i + 1}`, slug,
  settings: { luna_personality: 'calm', inbox_channel_modes: { whatsapp: 'draft' }, other: { keep: true } },
}));
const original = structuredClone(rows);
const queries = [], requests = [], violations = [], children = new Set(), closed = [];
let base;
const pg = { async query(sql, params) {
  queries.push({ sql, params });
  assert.match(sql, /(?:FROM|UPDATE) clients/);
  assert.doesNotMatch(sql, /\b(?:INSERT|DELETE|MERGE|CALL)\b/i);
  const row = rows.find((r) => r.id === params[0] || r.slug === params[0]);
  if (/\bUPDATE\b/i.test(sql)) {
    assert.match(sql, /UPDATE clients/);
    assert.match(sql, /jsonb_set/);
    assert.match(sql, /\{luna_intelligence\}/);
    assert.match(sql, /to_jsonb\(\$2::boolean\)/);
    assert.equal(typeof params[1], 'boolean');
    assert.ok(row);
    row.settings = { ...row.settings, luna_intelligence: params[1] };
  }
  return { rows: row ? [structuredClone(row)] : [] };
} };

// Asynchronous child RPC: never spawnSync/execSync while the Node HTTP server
// must service Python's real urllib requests. One child keeps a single emitted
// ordinary turn alive across ON -> OFF, proving revocation within that turn.
function startGuest(slug) {
  const child = spawn(process.env.PYTHON || 'python3', ['-u', path.resolve(__dirname,
    '../docker/hermes-staging/wolfhouse/test_luna_intelligence_e2e_bridge.py')], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', LUNA_E2E_LOCAL_ORIGIN: base,
      LUNA_CLIENT_SLUG: slug, HERMES_ROLE: roles[slug], WOLFHOUSE_STAFF_API_BASE_URL: origins[slug] },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  let stderr = '', failure, waiter;
  const queue = [];
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const fail = (error) => { failure = error; if (waiter) { waiter.reject(error); waiter = null; } };
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error(`Unexpected Python stdout: ${line}`)); return; }
    if (waiter) { waiter.resolve(message); waiter = null; } else queue.push(message);
  });
  const exited = new Promise((resolve) => {
    child.on('error', (error) => { fail(error); resolve({ code: null, error }); });
    child.on('close', (code, signal) => {
      children.delete(child);
      if (code !== 0) fail(new Error(`Python exit ${code}/${signal}: ${stderr}`));
      else if (waiter) fail(new Error('Python exited before expected bridge message'));
      resolve({ code, signal });
    });
  });
  function next() {
    if (failure) return Promise.reject(failure);
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); fail(new Error(`Python bridge timeout: ${stderr}`)); }, 15000);
      waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
    });
  }
  return {
    ready: async () => { assert.deepEqual(await next(), { event: 'ready', tenant: slug, fixture_provider: true }); },
    async call(tool, params) {
      // The real bot auth selects its canonical deployment tenant, not a query
      // selector. Model/tool inputs never choose a tenant. Calls are serialized.
      process.env.LUNA_BOT_CLIENT_SLUG = slug;
      process.env.DEFAULT_CLIENT_SLUG = slug;
      child.stdin.write(JSON.stringify({ tool, params }) + '\n');
      const message = await next();
      assert.equal(message.event, 'result');
      return message;
    },
    async finish() {
      child.stdin.write(JSON.stringify({ tool: 'finish' }) + '\n');
      const message = await next();
      assert.equal(message.event, 'closed');
      assert.equal(message.cleanup_verified, true);
      assert.equal(message.business_write_calls, 0);
      child.stdin.end();
      assert.equal((await exited).code, 0, stderr);
      closed.push(message);
    },
  };
}

async function browserSlice(browser, slug) {
  const html = api.buildUiHtmlForOfflineTest(0, slug);
  const card = html.match(/<section[^>]*id="staff-luna-personality-card"[\s\S]*?<\/section>/)?.[0];
  assert.ok(card);
  assert.match(card, /Luna Intelligence/);
  const start = html.indexOf('function lunaIntelligenceLoad(');
  const end = html.indexOf('function wireLunaStaffTabCards(', start);
  assert.ok(start > 0 && end > start);
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'offline_session', value: slug, url: base }]);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      violations.push(`non-local browser request: ${url}`);
      return route.abort();
    }
    if (url.pathname === '/offline-intelligence-e2e-ui') return route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><body>' + card +
        '<script>function el(id){return document.getElementById(id)}\n' + html.slice(start, end) +
        '\nlunaIntelligenceLoad();</script></body></html>',
    });
    if (url.pathname !== '/staff/luna-intelligence') {
      violations.push(`unexpected browser request: ${url}`);
      return route.abort();
    }
    return route.continue();
  });
  const page = await ctx.newPage();
  await page.goto(base + '/offline-intelligence-e2e-ui');
  const toggle = page.locator('#staff-luna-intelligence-toggle');
  async function settled(enabled) {
    await page.waitForFunction((value) => {
      const button = document.getElementById('staff-luna-intelligence-toggle');
      return !button.disabled && button.getAttribute('aria-checked') === String(value);
    }, enabled);
  }
  await settled(false);
  return { ctx, page, toggle, settled };
}

async function blocked(guest, providerCount = 0, sourceId = 's1') {
  for (const [tool, params] of [['search_public_info', { query: 'soft versus hard surfboard' }],
    ['read_public_source', { source_id: sourceId }]]) {
    const message = await guest.call(tool, params);
    assert.equal(message.result.success, false);
    assert.equal(message.result.error, 'intelligence_off');
    assert.equal(message.provider_calls.length, providerCount);
  }
}

test('OFFLINE Chromium -> Staff auth/router -> Python registered guest research boundary', { timeout: 120000 }, async (t) => {
  api.setFortress15j3OfflineSeams({
    withPgClient: async (fn) => fn(pg),
    resolveSessionUser(req) {
      const row = rows.find((r) => req.headers.cookie === `offline_session=${r.slug}`);
      return row ? { role: 'operator', staff_user_id: 'offline-e2e-staff', client_id: row.id, client_slug: row.slug } : null;
    },
    canAccessClient: (user, slug) => user && user.client_slug === slug,
  });
  const server = api.createStaffQueryApiHttpServer();
  server.prependListener('request', (req) => {
    requests.push({ method: req.method, path: req.url, cookie: req.headers.cookie,
      token: req.headers['x-luna-bot-token'] });
    if (!((req.url === '/staff/luna-intelligence' && ['GET', 'PUT'].includes(req.method)) ||
      (req.url === '/staff/bot/luna-intelligence' && req.method === 'GET'))) {
      violations.push(`unexpected API request: ${req.method} ${req.url}`);
      req.destroy();
    }
  });
  let browser;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await require('playwright').chromium.launch({ headless: true });
    for (const slug of tenants) await t.test(`${slug}: missing setting defaults OFF without provider calls`, async () => {
      const guest = startGuest(slug);
      await guest.ready();
      await blocked(guest);
      await guest.finish();
      assert.deepEqual(rows, original);
    });
    for (const [i, slug] of tenants.entries()) await t.test(`${slug}: emitted UI ON/search/read/OFF; sibling stays OFF`, async () => {
      const siblingBefore = structuredClone(rows[1 - i]);
      const ui = await browserSlice(browser, slug);
      const guest = startGuest(slug);
      await guest.ready();
      try {
        await blocked(guest);
        await ui.toggle.click();
        await ui.settled(true);
        assert.equal(rows[i].settings.luna_intelligence, true);
        await ui.page.reload();
        await ui.settled(true);
        const search = await guest.call('search_public_info', { query: 'soft versus hard surfboard' });
        assert.equal(search.result.success, true);
        assert.match(search.result.untrusted_content_warning, /NOT instructions/);
        assert.equal(search.provider_calls.length, 1);
        assert.equal(search.provider_calls[0].operation, 'search');
        assert.match(search.result.sources[0].title, /OFFLINE FIXTURE/);
        const sourceId = search.result.sources[0].source_id;
        const read = await guest.call('read_public_source', { source_id: sourceId });
        assert.equal(read.result.success, true);
        assert.equal(read.result.source_id, sourceId);
        assert.match(read.result.content, /OFFLINE FIXTURE ONLY/);
        assert.match(read.result.untrusted_content_warning, /NOT instructions/);
        assert.deepEqual(read.provider_calls.map((call) => call.operation), ['search', 'read']);
        const sibling = startGuest(tenants[1 - i]);
        await sibling.ready();
        await blocked(sibling);
        await sibling.finish();
        assert.deepEqual(rows[1 - i], siblingBefore);
        await ui.toggle.click();
        await ui.settled(false);
        assert.equal(rows[i].settings.luna_intelligence, false);
        // Same emitted turn and previously valid source: OFF revokes both tools.
        await blocked(guest, 2, sourceId);
        await guest.finish();
        assert.deepEqual(rows[i].settings, { ...original[i].settings, luna_intelligence: false });
        assert.deepEqual(rows[1 - i], siblingBefore);
      } finally { await ui.ctx.close(); }
    });
    assert.deepEqual(violations, []);
    const writes = queries.filter(({ sql }) => /\bUPDATE\b/i.test(sql));
    assert.deepEqual(writes.map(({ params }) => params), rows.flatMap((row) => [[row.id, true], [row.id, false]]));
    const puts = requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 4);
    for (const req of puts) {
      assert.equal(req.path, '/staff/luna-intelligence');
      assert.ok(tenants.some((slug) => req.cookie === `offline_session=${slug}`));
      assert.equal(req.token, undefined);
    }
    const botGets = requests.filter((r) => r.path === '/staff/bot/luna-intelligence');
    for (const req of botGets) {
      assert.equal(req.method, 'GET');
      assert.equal(req.cookie, undefined);
      assert.equal(req.token, process.env.LUNA_BOT_INTERNAL_TOKEN);
    }
    const summary = {
      offline: true, provider: 'INJECTED FIXTURE; NOT LIVE SEARCH EVIDENCE', tenants: tenants.length,
      emitted_worker_cleanups: closed.length,
      registered_handler_calls: closed.reduce((sum, row) => sum + row.handler_count, 0),
      real_fetch_setting_http_gets: botGets.length,
      fixture_search_calls: closed.flatMap((row) => row.provider_calls).filter((c) => c.operation === 'search').length,
      fixture_read_calls: closed.flatMap((row) => row.provider_calls).filter((c) => c.operation === 'read').length,
      ui_setting_writes: puts.length, business_writes: 0,
    };
    assert.equal(summary.emitted_worker_cleanups, 6);
    assert.equal(summary.registered_handler_calls, 20);
    assert.equal(summary.real_fetch_setting_http_gets, 24);
    assert.equal(closed.reduce((sum, row) => sum + row.http_count, 0), botGets.length);
    assert.equal(summary.fixture_search_calls, 2);
    assert.equal(summary.fixture_read_calls, 2);
    t.diagnostic(JSON.stringify(summary));
  } finally {
    for (const child of children) child.kill();
    if (browser) await browser.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    api.setFortress15j3OfflineSeams(null);
  }
});
