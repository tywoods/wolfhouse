'use strict';
// Offline production HTML and delegated Admin > Staff Prices > Transfers handlers.
// Synthetic read/write fixtures prove browser payloads, NOT SQL persistence.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { chromium } = require('playwright');
const { buildClientProfilesMap, getAccessibleClients } = require('./lib/staff-portal-clients');
const pricing = require('./lib/wolfhouse-pricing-resolve');
const { getClientTransferConfig } = require('./lib/client-transfer-config');
const { resolveTenantBusinessConfig } = require('./lib/tenant-business-config');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.TRANSFER_MAX_BROWSER_OUT || 'artifacts/transfer-max-browser');
const MODE = process.env.TRANSFER_MAX_BROWSER_MODE || 'all';
assert(['hydrate', 'save', 'bad-input', 'range', 'order', 'locale', 'all'].includes(MODE), 'known test mode');
const ORIGIN = 'http://transfer-max.test';
const BASE = '/staff/admin/wh/pricing';
const results = [];

function emit(slug) {
  const file = path.join(OUT, slug + '.html');
  const run = spawnSync(process.execPath, ['scripts/verify-inbox-ui-parity.js', '--emit', slug, file], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, STAFF_PORTAL_LOCALES: 'en,es,it' },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return fs.readFileSync(file, 'utf8');
}

async function runCase(browser, html, { name, slug = 'wolfhouse-somo', locale = 'en', mobile = false, readOnly = false }) {
  const ledger = [], errors = [], consoleErrors = [], observations = [];
  const result = { name, slug, locale, mobile, readOnly, ledger, errors, consoleErrors, observations, passed: false };
  results.push(result);
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  let saved = { airport_code: 'SDR', label: 'Santander (offline fixture)', requires_package: false, included_when_package: false, min_guest_count: 1, max_guest_count: 8, active: true };
  let fare = { amount_cents: 4200, currency: 'EUR', unit: 'flat', source: 'db' };
  function view() {
    const value = pricing.buildAdminPricingView({ config: pricing.loadPricingConfig(), transferConfig: getClientTransferConfig('wolfhouse-somo'), dbTransferRules: [saved], writesEnabled: !readOnly });
    // Explicit browser-only contract fixture while backend is a separate owner.
    value.transfers = value.transfers.map(t => t.airport_code === 'SDR' ? { ...t, ...saved, price: fare } : t);
    return { success: true, ...value, overlay_available: true };
  }
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    const entry = { method: req.method(), url: req.url() }; ledger.push(entry);
    try {
      if (url.origin !== ORIGIN) {
        entry.blocked = true;
        entry.expectedExternalFont = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(req.url());
        if (!entry.expectedExternalFont) entry.unexpected = true;
        return route.abort();
      }
      let data;
      if (req.method() === 'PUT' && (p === BASE + '/transfers' || p === BASE + '/prices')) {
        entry.body = req.postDataJSON(); entry.syntheticWrite = true;
        assert.equal(readOnly, false); assert.equal(slug, 'wolfhouse-somo');
        assert.equal(url.searchParams.get('client'), slug);
        const body = entry.body;
        if (p.endsWith('/transfers')) {
          assert.equal(body.airport_code, 'SDR');
          assert(Object.hasOwn(body, 'max_guest_count'), 'Save payload must explicitly include max_guest_count');
          assert(body.max_guest_count === null || (Number.isInteger(body.max_guest_count) && body.max_guest_count >= 1 && body.max_guest_count <= 99), 'max must be a JSON integer or null');
          assert(body.max_guest_count === null || body.min_guest_count == null || body.max_guest_count >= Number(body.min_guest_count), 'max >= min');
          saved = { ...saved, ...body };
        } else {
          assert.equal(body.item_type, 'transfer'); assert.equal(body.item_code, 'SDR');
          assert(['flat', 'per_person'].includes(body.unit));
          assert.equal(body.amount_eur, '42.00');
          fare = { ...fare, unit: body.unit };
        }
        data = view();
      } else if (req.method() !== 'GET') { entry.unexpected = true; return route.abort(); }
      else if (p === '/staff/ui') return route.fulfill({ contentType: 'text/html', body: html });
      else if (p === '/staff/auth/session') data = { success: true, auth_required: false, role: 'owner', clients: getAccessibleClients(null), client_profiles: buildClientProfilesMap(null), can_use_owner_insights: true };
      else if (p === BASE) { assert.equal(slug, 'wolfhouse-somo'); data = view(); }
      else if (p === '/staff/intents') data = { success: true, intents: [] };
      else if (p === '/staff/inbox/luna-mode') data = { success: true, mode: 'off' };
      else if (p === '/staff/bot/global-pause-state') data = { success: true, paused: false };
      else if (p === '/staff/whatsapp-numbers') data = { success: true, numbers: [] };
      else if (p === '/staff/admin/house-notes') data = { success: true, notes: '' };
      else if (p === '/staff/automated-notifications') data = { success: true, notifications: [] };
      else if (p === '/staff/packages') data = { success: true, packages: [] };
      else if (p === '/staff/conversations') data = { success: true, conversations: [] };
      else if (p === '/staff/bed-calendar') data = { success: true, days: [], rooms: [], blocks: [], warnings: [] };
      else if (p === '/staff/admin/finance/summary') data = { success: false, error: 'offline_finance_not_under_test' };
      else if (p === '/staff/admin/config') data = { success: true, ...resolveTenantBusinessConfig(slug, 'sunset-somo') };
      else if (p === '/staff/admin/config/rental-offerings') data = { success: true, offerings: [] };
      else if (slug === 'sunset' && p === '/staff/schedule/bookings/catalog') data = { success: true, offerings: [], courses: [] };
      else if (slug === 'sunset' && p === '/staff/schedule/day') data = { success: true, date: url.searchParams.get('date'), lessons: [], gear: [], rows: [] };
      else if (slug === 'sunset' && p === '/staff/admin/config/surf-beaches') data = { success: true, beaches: [] };
      else if (p === '/staff/clients') data = { success: true, clients: getAccessibleClients(null) };
      else if (p.startsWith('/staff/assets/')) {
        const file = path.join(ROOT, 'config/staff-portal', path.basename(p));
        if (fs.existsSync(file)) return route.fulfill({ path: file });
        entry.unexpected = true; return route.abort();
      } else { entry.unexpected = true; return route.abort(); }
      return route.fulfill({ json: data });
    } catch (error) {
      errors.push('route: ' + error.stack);
      return route.fulfill({ status: 500, json: { success: false, error: error.message } });
    }
  });
  await context.routeWebSocket('**/*', ws => { ledger.push({ method: 'WEBSOCKET', url: ws.url(), blocked: true, unexpected: true }); ws.close(); });
  await context.addInitScript(({ slug, locale }) => {
    localStorage.setItem('staff_portal_client', slug);
    localStorage.setItem('wh_staff_portal_locale', locale);
  }, { slug, locale });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  async function openPricing() {
    await page.waitForFunction(s => !document.body.classList.contains('portal-profile-pending') && document.getElementById('c-client')?.value === s, slug);
    if (mobile) await page.locator('#nav-menu-toggle').click();
    await page.locator('button.tab-btn[data-tab="admin"]').click();
    await page.locator('#tab-admin.tab-panel.active').waitFor();
    await page.locator('#wh-admin-tab-pricing').click();
    await page.locator('#wh-admin-pricing-body .portal-admin-section').first().waitFor();
  }
  async function edit() {
    await page.locator('[data-wh-price-action="edit-transfer"][data-wh-airport="SDR"]').click();
    await page.locator('#wh-price-transfer-min').waitFor();
  }
  try {
    await page.goto(ORIGIN + '/staff/ui', { waitUntil: 'domcontentloaded' });
    if (slug === 'sunset') {
      await page.waitForFunction(s => !document.body.classList.contains('portal-profile-pending') && document.getElementById('c-client')?.value === s, slug);
      await page.locator('button.tab-btn[data-tab="admin"]').click();
      await page.locator('#tab-admin.tab-panel.active').waitFor();
      const shells = await page.evaluate(() => ({
        sunsetHidden: document.getElementById('admin-sunset-shell').hidden,
        whHidden: document.getElementById('admin-wh-shell').hidden,
        pricing: document.getElementById('wh-admin-pricing-body').innerText.trim(),
        tabs: Array.from(document.querySelectorAll('#admin-subtab-list [data-admin-tab]'), e => e.getAttribute('data-admin-tab')),
      }));
      assert.deepEqual(shells, { sunsetHidden: false, whHidden: true, pricing: '', tabs: ['finance', 'pricing', 'luna-staff'] });
      assert.equal(ledger.filter(e => e.url.includes(BASE)).length, 0, 'Sunset never requests Wolfhouse pricing');
      assert.equal(ledger.filter(e => e.syntheticWrite).length, 0);
      observations.push({ behavior: 'Sunset native non-target Admin control', shells });
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      assert.deepEqual(ledger.filter(e => e.unexpected), []); assert.deepEqual(errors, []);
      result.passed = true; return;
    }
    await openPricing();
    if (readOnly) {
      await page.waitForFunction(() => /Read-only/.test(document.getElementById('wh-admin-pricing-body').innerText));
      assert.equal(await page.locator('[data-wh-price-action^="edit-"], [data-wh-price-action^="new-"], [data-wh-price-action^="delete-"]').count(), 0);
      assert.equal(await page.locator('#wh-price-transfer-max').count(), 0);
      assert.equal(ledger.filter(e => e.syntheticWrite).length, 0);
      await page.locator('#wh-admin-pricing-body').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      assert.deepEqual(ledger.filter(e => e.unexpected), []); assert.deepEqual(errors, []);
      observations.push({ behavior: 'read-only no write controls' }); result.passed = true; return;
    }
    await edit();
    assert.equal(await page.locator('#wh-price-transfer-max').count(), 1, 'Transfer Edit must render Max group size');
    assert.equal(await page.locator('#wh-price-transfer-max').inputValue(), '8', 'configured max must hydrate');
    if (['locale', 'all'].includes(MODE)) {
      assert.equal(await page.locator('label[for="wh-price-transfer-max"]').textContent(), locale === 'es' ? 'Tamaño máximo del grupo' : 'Max group size', 'localized max label');
    }
    if (MODE !== 'hydrate') {
      await page.locator('#wh-price-transfer-max').fill('9');
      await Promise.all([
        page.waitForResponse(r => r.url().includes(BASE + '/transfers?') && r.request().method() === 'PUT'),
        page.locator('[data-wh-price-action="save-transfer"]').click(),
      ]);
      const write = ledger.find(e => e.syntheticWrite && e.url.includes('/transfers?'));
      assert.equal(write?.body.max_guest_count, 9, 'delegated Save sends numeric max');
      await page.waitForFunction(() => !document.getElementById('wh-price-transfer-min'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await openPricing(); await edit();
      assert.equal(await page.locator('#wh-price-transfer-max').inputValue(), '9', 'API fixture reload must hydrate saved max');
      observations.push({ behavior: 'save-reload', max: 9, proof: 'synthetic browser/payload only' });
    }
    if (MODE === 'all') {
      for (const unit of ['flat', 'per_person']) {
        for (const value of [1, 99, null]) {
          await page.locator('#wh-price-transfer-min').fill('1');
          await page.locator('#wh-price-transfer-unit').selectOption(unit);
          await page.locator('#wh-price-transfer-max').fill(value === null ? '' : String(value));
          assert.equal(await page.locator('#wh-price-transfer-max').evaluate(e => e.validity.badInput), false, 'deliberate clear is not malformed input');
          const before = ledger.filter(e => e.syntheticWrite).length;
          await Promise.all([
            page.waitForResponse(r => r.url().includes(BASE + '/prices?') && r.request().method() === 'PUT'),
            page.locator('[data-wh-price-action="save-transfer"]').click(),
          ]);
          await page.waitForFunction(() => !document.getElementById('wh-price-transfer-min'));
          const writes = ledger.filter(e => e.syntheticWrite).slice(before);
          assert.equal(writes.length, 2, 'one rule and one fare write');
          assert.equal(writes[0].body.max_guest_count, value, 'explicit integer boundary or JSON null');
          assert.equal(writes[1].body.unit, unit, 'max does not change fare unit');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await openPricing(); await edit();
          assert.equal(await page.locator('#wh-price-transfer-max').inputValue(), value === null ? '' : String(value), 'boundary/clear survives fixture reload');
          assert.equal(await page.locator('#wh-price-transfer-unit').inputValue(), unit, 'fare unit survives fixture reload');
          observations.push({ behavior: value === null ? 'null-clear-reload' : 'boundary-save-reload', max: value, unit, proof: 'synthetic browser/payload only' });
          if (value === 99) {
            await page.locator('#wh-price-transfer-max').scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(OUT, name + '-' + unit + '-99.png') });
          }
        }
      }
    }
    if (['bad-input', 'range', 'order', 'all'].includes(MODE)) {
      const max = page.locator('#wh-price-transfer-max');
      await max.fill('');
      await max.pressSequentially('1e');
      assert.equal(await max.evaluate(e => e.validity.badInput), true, 'real Chromium incomplete exponent');
      assert.equal(await max.inputValue(), '', 'badInput exposes empty value, not deliberate clear');
      const before = ledger.filter(e => e.syntheticWrite).length;
      await page.locator('[data-wh-price-action="save-transfer"]').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(ledger.filter(e => e.syntheticWrite).length, before, 'badInput must not issue a clearing write');
      assert.equal(await max.evaluate(e => e.validity.badInput), true, 'invalid draft must remain intact');
      observations.push({ behavior: 'badInput-no-clear', savedMax: saved.max_guest_count });
      await max.fill('9');
    }
    if (['range', 'order', 'all'].includes(MODE)) {
      for (const invalid of ['0', '-1', '100', '1.5', '1e3']) {
        const max = page.locator('#wh-price-transfer-max');
        await max.fill(invalid);
        const before = ledger.filter(e => e.syntheticWrite).length;
        await page.locator('[data-wh-price-action="save-transfer"]').click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(ledger.filter(e => e.syntheticWrite).length, before, 'invalid max must not write: ' + invalid);
        assert.equal(await max.inputValue(), invalid, 'rejected draft retained');
        assert.equal(await max.evaluate(e => e.checkValidity()), false);
        observations.push({ behavior: 'range-reject', invalid });
      }
      await page.locator('#wh-price-transfer-max').fill('9');
    }
    if (['order', 'locale', 'all'].includes(MODE)) {
      await page.locator('#wh-price-transfer-min').fill('10');
      await page.locator('#wh-price-transfer-max').fill('9');
      const before = ledger.filter(e => e.syntheticWrite).length;
      await page.locator('[data-wh-price-action="save-transfer"]').click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(ledger.filter(e => e.syntheticWrite).length, before, 'max below min must not write');
      assert.equal(await page.locator('#wh-price-transfer-max').evaluate(e => e.validity.customError), true, 'explain min/max conflict on the field');
      assert.equal(await page.locator('#wh-price-transfer-max').evaluate(e => e.validationMessage), locale === 'es' ? 'El tamaño máximo del grupo debe ser igual o mayor que el mínimo.' : 'Max group size must be at least the minimum group size.', 'localized order error');
      observations.push({ behavior: 'order-reject', min: 10, max: 9 });
      await page.locator('#wh-price-transfer-min').fill('1');
    }
    await page.locator('#wh-price-transfer-max').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, name + '.png') });
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.deepEqual(ledger.filter(e => e.unexpected), [], 'Unexpected requests fail closed');
    result.passed = true;
  } catch (error) {
    result.failure = error.stack;
    await page.screenshot({ path: path.join(OUT, name + '-failure.png') }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const html = emit('wolfhouse-somo');
  const sunsetHtml = MODE === 'all' ? emit('sunset') : null;
  const browser = await chromium.launch({ headless: true });
  let failure;
  try {
    const cases = MODE === 'all'
      ? [
        ...[false, true].flatMap(mobile => ['en', 'es'].map(locale => ({ name: (mobile ? 'mobile-' : 'desktop-') + locale, mobile, locale }))),
        { name: 'wolfhouse-read-only', readOnly: true },
        { name: 'sunset-isolation', slug: 'sunset' },
      ]
      : [{ name: MODE === 'locale' ? 'desktop-es' : 'desktop-en', locale: MODE === 'locale' ? 'es' : 'en' }];
    for (const testCase of cases) {
      try { await runCase(browser, testCase.slug === 'sunset' ? sunsetHtml : html, testCase); }
      catch (error) { failure = failure || error; }
    }
    assert.equal(results.length, cases.length, 'every requested case executed');
  }
  catch (error) { failure = error; }
  finally {
    await browser.close();
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ mode: MODE, proof: 'Synthetic browser/payload proof, not SQL persistence', passed: !failure, results }, null, 2));
  }
  if (failure) throw failure;
  console.log('PASS transfer max group browser: ' + results.length + ' cases (' + MODE + ')');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
