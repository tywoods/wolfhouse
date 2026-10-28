'use strict';

/**
 * Composed-portal regressions for the approved summary-only Finance screen.
 * Real production renderer, loader and event wiring; offline producer fixtures.
 * Deleted detail/pagination/409 lifecycle is NOT exercised. Its pure renderer
 * contract remains covered in verify-wolfhouse-finance-creator-ui.js.
 * Run: node scripts/verify-wolfhouse-finance-creator-ui-review.js
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function buildPortalHtml() {
  Object.assign(process.env, {
    NODE_ENV: 'test', STAFF_UI_BUILDER_TEST_SEAM: '1',
    STAFF_AUTH_REQUIRED: 'false', STAFF_AUTH_ALLOW_OPEN: 'true',
    STAFF_PORTAL_LOCALES: 'en,es,it', DEFAULT_CLIENT_SLUG: 'wolfhouse-somo',
  });
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}scripts${path.sep}`)) delete require.cache[key];
  }
  const api = require('./staff-query-api');
  assert.equal(typeof api.buildUiHtmlForOfflineTest, 'function');
  return api.buildUiHtmlForOfflineTest(0, 'wolfhouse-somo');
}

async function proveComposedFinanceReview({ success, partial }) {
  const html = buildPortalHtml();
  assert.ok(html.includes('--finance-bar-green:'), 'Sunset Finance palette retained');
  assert.equal(/--green\s*:/.test(html), false);
  assert.equal(/--line\s*:/.test(html), false);
  const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(10000);
  const requests = [], errors = [], unexpected = [], held = [], cases = [];
  let mode = 'ok';
  const pass = (label) => { cases.push(label); console.log('PASS', label); };
  const host = page.locator('#wh-admin-finance-body');
  const removed = '[data-wh-fin-source],[data-wh-fin-month],[data-wh-fin-detail],[data-wh-fin-open],[data-wh-fin-cursor],[data-wh-fin-trend],[data-wh-fin-refunds],[data-wh-fin-arrival],[data-wh-fin-warnings],[data-wh-fin-products]';
  const envelope = (granularity = 'month', amount = 10000, projection = success) => {
    const proj = structuredClone(projection);
    proj.scope.range = { ...proj.scope.range, granularity };
    proj.creators.find((row) => row.creator === 'luna').gross_receipts.amount_cents = amount;
    return {
      success: true, client: 'wolfhouse-somo', location_id: '',
      summary: { redesign: { view: { granularity, range: proj.scope.range } } },
      wolfhouse_creator_finance: proj,
    };
  };
  const settle = () => host.locator('[data-wh-fin-headline="total"]').waitFor();
  const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const lang = async (locale) => {
    await page.locator(`.staff-lang-btn[data-lang="${locale}"]`).click();
    await frames();
  };
  const refresh = () => page.locator('[data-wh-admin-tab="finance"]').click();
  const release = async (item, body, abort = false) => {
    // Wait for the actual fetch to finish before asserting that it cannot paint.
    const done = page.waitForEvent(abort ? 'requestfailed' : 'requestfinished', (r) => r.url() === item.url);
    if (abort) await item.route.abort('failed');
    else await item.route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    await done;
    await frames();
  };
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    // The composed portal references web fonts; never contact external hosts.
    if (url.origin !== 'http://finance-review.test') return route.fulfill({ status: 204, body: '' });
    if (request.method() !== 'GET') { unexpected.push(request.method() + ' ' + url.href); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/staff/auth/session') return json({
      success: true, auth_required: false, role: 'owner', email: null, display_name: null,
      clients: getAccessibleClients(null), client_profiles: buildClientProfilesMap(null), can_use_owner_insights: true,
    });
    if (url.pathname === '/staff/admin/finance/summary') {
      requests.push(url.href);
      if (url.searchParams.has('creator_detail')) { unexpected.push(url.href); return route.abort(); }
      if (mode === 'hold') { held.push({ route, url: url.href }); return; }
      if (mode === 'abort') return route.abort('failed');
      if (mode === '500') return json({ success: false, error: '<img src=x onerror=alert(1)>' }, 500);
      if (mode === '503') return json({ success: false, code: 'FINANCE_DATA_QUALITY' }, 503);
      if (mode === 'invalid-json') return route.fulfill({ contentType: 'application/json', body: '{' });
      const body = envelope(url.searchParams.get('granularity') || 'month', mode === 'week' ? 11100 : 10000, mode === 'partial' ? partial : success);
      if (mode === 'missing') delete body.wolfhouse_creator_finance;
      if (mode === 'unsupported') body.wolfhouse_creator_finance.schema_version = 'wolfhouse.creator-finance.v1-extra';
      if (mode === 'unsuccessful') body.success = false;
      return json(body);
    }
    if (url.pathname.startsWith('/staff/')) return json({ success: true, rows: [], conversations: [], offerings: [], services: [] });
    return route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'wolfhouse-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });

  try {
    await page.goto('http://finance-review.test/staff/ui', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('c-client')?.value === 'wolfhouse-somo');
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await refresh();
    await settle();
    assert.ok(requests.length > 0);
    assert.equal(await host.locator(removed).count(), 0);
    assert.equal(await host.locator('[data-finance-gran]').count(), 5);
    assert.equal(await host.locator('[data-finance-nav="today"]').count(), 0);
    pass('composed entry has one range control and no removed sections');

    // Retained cards still use Finance-local tokens. There is no chart to test.
    for (const width of [1280, 390]) {
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
        const geometry = await host.evaluate((root) => {
          const finance = getComputedStyle(root.querySelector('.wh-fin'));
          const card = root.querySelector('[data-wh-fin-headline="luna"]');
          const style = getComputedStyle(card), box = card.getBoundingClientRect();
          const probe = document.createElement('span');
          probe.style.color = finance.getPropertyValue('--whf-primary');
          root.appendChild(probe);
          const tokenColor = getComputedStyle(probe).color;
          probe.remove();
          return { border: style.borderLeftColor, tokenColor, width: box.width, height: box.height,
            green: getComputedStyle(document.documentElement).getPropertyValue('--green').trim(),
            line: getComputedStyle(document.documentElement).getPropertyValue('--line').trim() };
        });
        assert.equal(geometry.border, geometry.tokenColor);
        assert.ok(geometry.width > 20 && geometry.height > 20);
        assert.equal(geometry.green, '');
        assert.equal(geometry.line, '');
        assert.equal(await host.locator(removed).count(), 0);
        pass(`composed retained card tokens ${theme} ${width}`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.match(await host.locator('[data-wh-fin-creator-row="luna"] [data-wh-fin-booking-count]').innerText(), /1/);
    assert.match(await host.locator('[data-wh-fin-creator-row="total"] [data-wh-fin-booking-count]').innerText(), /2/);
    pass('composed creator comparison retains server booking counts');

    const beforeStatic = requests.length;
    for (const selector of ['[data-wh-fin-headline="luna"]', '[data-wh-fin-also="staff"]', '[data-wh-fin-secondary="new-booking-value"]', '[data-wh-fin-secondary="outstanding"]', '[data-wh-fin-comparison]']) {
      assert.equal(await host.locator(selector).evaluate((node) => node.tagName === 'BUTTON' || node.hasAttribute('tabindex') || node.hasAttribute('data-wh-fin-open')), false);
      await host.locator(selector).click();
    }
    await frames();
    assert.equal(requests.length, beforeStatic);
    assert.equal(await host.locator(removed).count(), 0);
    pass('static headline receipts secondary and comparison clicks never fetch details');

    const beforeLocale = requests.length;
    for (const [locale, title] of [['es', 'Finanzas · Wolfhouse'], ['it', 'Finanze · Wolfhouse'], ['en', 'Finance · Wolfhouse']]) {
      await lang(locale);
      assert.equal(await host.locator('h2').innerText(), title);
      assert.equal(await host.locator('[data-wh-fin-also="luna"] [data-wh-fin-cents="10000"]').count(), 1);
      assert.equal(await host.locator(removed).count(), 0);
    }
    assert.equal(requests.length, beforeLocale);
    pass('successful summary locale repaint retains server totals without fetch');

    mode = 'partial';
    await refresh();
    await host.locator('[data-wh-fin-reason="mixed_currency"]').first().waitFor();
    assert.match(await host.innerText(), /Not a complete split\./);
    assert.equal(await host.locator('[data-wh-fin-warnings],[data-wh-fin-trend]').count(), 0);
    assert.ok(await host.locator('[data-wh-fin-state="partial"]').count() > 0);
    pass('partial summary keeps visible card reasons without warnings or trend');

    mode = 'week';
    await host.locator('[data-finance-gran="week"]').click();
    await host.locator('[data-wh-fin-also="luna"] [data-wh-fin-cents="11100"]').waitFor();
    mode = 'hold';
    const beforePending = requests.length;
    await host.locator('[data-finance-gran="month"]').click();
    await host.locator('.portal-admin-finance-loading').waitFor();
    await page.waitForFunction(() => document.querySelector('#wh-admin-finance-body')?.dataset.whFinSummaryState === 'pending');
    assert.equal(held.length, 1);
    assert.equal(requests.length, beforePending + 1);
    await lang('es');
    assert.equal(requests.length, beforePending + 1);
    assert.equal(await host.locator('.portal-admin-finance-loading').count(), 1);
    assert.equal(await host.locator('[data-wh-fin-cents],[data-wh-fin-state="complete"]').count(), 0);
    await release(held.shift(), envelope('month', 22200));
    await host.locator('[data-wh-fin-also="luna"] [data-wh-fin-cents="22200"]').waitFor();
    assert.equal(await host.locator('h2').innerText(), 'Finanzas · Wolfhouse');
    assert.equal(await host.locator('[data-finance-gran="month"]').getAttribute('aria-selected'), 'true');
    assert.equal(await host.locator('[data-wh-fin-cents="11100"]').count(), 0);
    pass('pending summary locale repaint keeps loading then paints the new response');

    // Two native tab loads prove the sequence guard for both resolve and reject.
    for (const abort of [false, true]) {
      mode = 'hold';
      await refresh();
      await host.locator('.portal-admin-finance-loading').waitFor();
      assert.equal(held.length, 1);
      mode = 'ok';
      await refresh();
      await settle();
      await release(held.shift(), envelope('week', 44400), abort);
      assert.equal(await host.locator('[data-wh-fin-also="luna"] [data-wh-fin-cents="10000"]').count(), 1);
      assert.equal(await host.locator('[role="alert"],[data-wh-fin-cents="44400"]').count(), 0);
      pass(`superseded summary ${abort ? 'rejection' : 'success'} cannot repaint`);
    }

    await lang('en');
    for (const failure of ['abort', '500', '503', 'invalid-json', 'unsuccessful']) {
      mode = failure;
      await refresh();
      await host.locator('[role="alert"]').waitFor();
      assert.equal(await host.locator('[data-wh-fin-cents]').count(), 0);
      assert.equal(await host.locator('img,script').count(), 0);
      assert.equal(await host.locator('#admin-finance-retry').count(), 1);
      if (failure === '503') assert.equal(await host.locator('[data-wh-fin-state="request-failed"]').count(), 1);
      mode = 'ok';
      await host.locator('#admin-finance-retry').click();
      await settle();
      pass(`summary ${failure} clears cached figures and retries successfully`);
    }

    mode = 'abort';
    await refresh();
    await host.locator('[role="alert"]').waitFor();
    const beforeErrorLocale = requests.length;
    await lang('es');
    await host.locator('[role="alert"]').waitFor();
    assert.equal(requests.length, beforeErrorLocale + 1);
    assert.equal(await host.locator('[data-wh-fin-cents]').count(), 0);
    assert.match(await host.innerText(), /No se pudo|error/i);
    mode = 'ok';
    await host.locator('#admin-finance-retry').click();
    await settle();
    pass('failed summary locale change refetches without reviving cached success');

    for (const state of ['missing', 'unsupported']) {
      mode = state;
      await refresh();
      await host.locator(`[data-wh-fin-state="${state}"]`).waitFor();
      assert.equal(await host.locator('[data-wh-fin-cents]').count(), 0);
      mode = 'ok';
      await refresh();
      await settle();
      pass(`${state} projection never falls back to legacy money`);
    }

    // Isolate the tenant guard: change the real selector without dispatching its
    // reload handler, so financeLoadSeq stays unchanged and cannot mask this guard.
    for (const abort of [false, true]) {
      mode = 'hold';
      await refresh();
      await host.locator('.portal-admin-finance-loading').waitFor();
      assert.equal(held.length, 1);
      const beforeTenant = await host.innerHTML();
      const beforeTenantRequests = requests.length;
      await page.evaluate(() => { document.getElementById('c-client').value = 'sunset'; });
      assert.equal(await page.locator('#c-client').inputValue(), 'sunset');
      await release(held.shift(), envelope('month', 55500), abort);
      assert.equal(requests.length, beforeTenantRequests, 'selector assignment must not start a newer summary');
      assert.equal(await host.innerHTML(), beforeTenant);
      await lang(abort ? 'es' : 'it');
      assert.equal(await host.locator('[data-wh-finance]').count(), 0, 'locale repaint must not restore cached Wolfhouse cards in another tenant');
      await page.evaluate(() => { document.getElementById('c-client').value = 'wolfhouse-somo'; });
      mode = 'ok';
      await refresh();
      await settle();
      pass(`tenant guard rejects late summary ${abort ? 'failure' : 'success'} and cached repaint`);
    }

    for (const url of requests) {
      const params = new URL(url).searchParams;
      assert.equal(params.get('client'), 'wolfhouse-somo');
      for (const key of ['creator_detail', 'creator', 'cursor', 'cohort_id', 'as_of', '_ts', 'anchor', 'start', 'end']) {
        assert.equal(params.has(key), false, `preset summary unexpectedly sends ${key}: ${url}`);
      }
    }
    assert.equal(await host.locator(removed).count(), 0);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    pass('all reviewed requests are tenant-scoped preset summaries with zero detail fetches');
    console.log(`PASS composed Finance review: ${cases.length} checks; ${requests.length} summary requests; 0 detail requests; 0 page errors`);
    return { checks: cases.length, summaryRequests: requests.length, detailRequests: 0, pageErrors: errors.length };
  } finally {
    while (held.length) await held.shift().route.abort('failed').catch(() => {});
    await browser.close();
  }
}

module.exports = { proveComposedFinanceReview };
if (require.main === module) {
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/wolfhouse-finance-creator-data', name), 'utf8')).response.body.wolfhouse_creator_finance;
  proveComposedFinanceReview({ success: fixture('success.json'), partial: fixture('partial.json') })
    .then(() => console.log('PASS verify-wolfhouse-finance-creator-ui-review'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
