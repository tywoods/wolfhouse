'use strict';

/**
 * Focused OFFLINE synthetic browser regression for the production Pricing module.
 * Run with node --test scripts/verify-wolfhouse-pricing-disclosure-state.js.
 * This isolates the module and the parent's disclosure/lifecycle contract; the
 * overall disclosure verifier owns emitted-page/auth integration and styling.
 * All HTTP/WebSockets are intercepted. No database, live auth or persistence.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.WH_PLAYWRIGHT_PATH || 'playwright');
const resolver = require('./lib/wolfhouse-pricing-resolve');
const { getClientTransferConfig } = require('./lib/client-transfer-config');
const source = fs.readFileSync(path.join(__dirname, 'browser/wolfhouse-admin-pricing-ui.js'), 'utf8');
const keys = ['seasons', 'packages', 'rentals', 'services', 'transfers', 'extras'];
const out = process.env.WH_PRICING_EVIDENCE_DIR;
const ledger = [];
const errors = [];
let browser;
const fixture = resolver.buildAdminPricingView({
  config: resolver.loadPricingConfig(), transferConfig: getClientTransferConfig('wolfhouse-somo'),
  dbSeasons: [], dbRules: [{ item_type: 'package', item_code: 'review-package', season_code: 'august',
    unit: 'per_person_per_week', amount_cents: 34900, currency: 'EUR', active: true }],
  dbItems: [{ item_type: 'package', item_code: 'review-package', label: 'Synthetic review package', active: true }],
  dbTransferRules: [], writesEnabled: true,
});
fixture.success = true;
fixture.overlay_available = true;
const scaffold = `<!doctype html><html data-portal-client="wolfhouse-somo"><style>
[hidden]{display:none!important}.staff-collapse-toggle[aria-expanded="false"] ~ *{display:none!important}
button{padding:8px}section{margin:12px}input{padding:6px}
</style><body><div id="wh-admin-pricing-body"></div><script>
window.contextKey='wolfhouse-somo'; window.staffCollapseContextKey=()=>window.contextKey;
window.translated=false; window.t=k=>window.translated&&/^admin.wh.pricing.(seasons|packages|rentals|services|transfers|extras)$/.test(k)?'Étiquette traduite':k;
// Parent contract: the Pricing body's preventDefault claims its own toggles.
document.addEventListener('click',e=>{if(e.defaultPrevented)return;const b=e.target.closest('.staff-collapse-toggle');if(!b)return;
const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));document.getElementById(b.getAttribute('aria-controls')).hidden=!open;});
</script><script src="/pricing.js"></script></body></html>`;

before(async () => {
  browser = await chromium.launch({ headless: true,
    ...(process.env.WH_CHROMIUM_EXECUTABLE ? { executablePath: process.env.WH_CHROMIUM_EXECUTABLE } : {}) });
  if (out) fs.mkdirSync(out, { recursive: true });
});
after(async () => {
  if (browser) await browser.close();
  if (out) fs.writeFileSync(path.join(out, 'requests.json'), JSON.stringify({
    notice: 'Offline synthetic module fixture; every request intercepted. Not live auth/DB/persistence proof.',
    requests: ledger, pageErrors: errors,
  }, null, 2));
  assert.deepEqual(errors, [], 'no browser errors');
  assert.equal(ledger.filter(r => r.disposition === 'unexpected-blocked').length, 0, 'no unexpected requests');
});
async function setup(t, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  context.setDefaultTimeout(3000);
  const state = { writes: opts.writes !== false, response: 'reject', hold: false, held: null, step: 0 };
  await context.routeWebSocket('**/*', socket => { errors.push('unexpected WebSocket'); socket.close(); });
  await context.route('**/*', async route => {
    const req = route.request(); const url = new URL(req.url());
    const entry = { test: t.name, method: req.method(), path: url.pathname, disposition: 'unexpected-blocked' };
    ledger.push(entry);
    if (url.origin !== 'http://pricing.test') return route.abort();
    if (req.method() === 'GET' && url.pathname === '/') {
      entry.disposition = 'synthetic-scaffold'; return route.fulfill({ contentType: 'text/html', body: scaffold });
    }
    if (req.method() === 'GET' && url.pathname === '/pricing.js') {
      entry.disposition = 'production-module'; return route.fulfill({ contentType: 'application/javascript', body: source });
    }
    if (url.pathname.startsWith('/staff/admin/wh/pricing')) {
      entry.disposition = 'synthetic-fixture';
      if (req.method() !== 'GET') {
        state.step++;
        if (state.hold) await new Promise(resolve => { state.held = resolve; });
        if (state.response === 'network') return route.abort('failed');
        if (state.response !== 'success' && !(state.response === 'second-reject' && state.step === 1)) {
          return route.fulfill({ status: 400, json: { success: false, error: 'Synthetic rejected price' } });
        }
      }
      return route.fulfill({ json: { ...fixture, writes_enabled: state.writes } });
    }
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', err => errors.push(`${t.name}: ${err.message}`));
  t.after(async () => {
    if (out && !page.isClosed()) await page.screenshot({ path: path.join(out, t.name.replace(/[^a-z0-9]+/gi, '-') + '.png'), fullPage: true });
    await context.close();
  });
  await page.goto('http://pricing.test/');
  await page.evaluate(() => window.loadWolfhouseAdminPricing());
  return { page, state };
}
const toggle = (page, key) => page.locator(`[aria-controls="wh-pricing-collapse-${key}"]`);
const action = (page, name) => page.locator(`[data-wh-price-action="${name}"]`).first();
async function open(page, key) {
  const b = toggle(page, key);
  if (await b.getAttribute('aria-expanded') !== 'true') await b.click();
}
async function expanded(page, key, expected = true) {
  assert.equal(await toggle(page, key).getAttribute('aria-expanded'), String(expected), `${key} expanded`);
  assert.equal(await page.locator(`#wh-pricing-collapse-${key}`).evaluate(n => n.hidden), !expected, `${key} hidden`);
}
async function editPrice(page) {
  await open(page, 'packages'); await action(page, 'edit-package-price').click();
}
async function pending(page, state, save, key) {
  state.hold = true;
  await action(page, save).click();
  // Intercept reached, not a blind sleep; awaiting the route prevents racing the collapse.
  await new Promise((resolve, reject) => {
    const end = Date.now() + 3000;
    const tick = () => state.held ? resolve() : Date.now() > end ? reject(new Error('request not intercepted')) : setTimeout(tick, 5);
    tick();
  });
  await toggle(page, key).click();
  await expanded(page, key, false);
  state.hold = false; state.held(); state.held = null;
  await page.locator('.wh-price-banner-warn').waitFor({ state: 'visible' });
}

test('all six default closed and pointer Enter Space preserve live unsaved DOM without mutations', async t => {
  const { page } = await setup(t);
  for (const key of keys) {
    await expanded(page, key, false);
    await toggle(page, key).click(); await expanded(page, key);
    await toggle(page, key).press('Space'); await expanded(page, key, false);
    await toggle(page, key).press('Enter'); await expanded(page, key);
  }
  await action(page, 'edit-package-price').click(); await open(page, 'packages');
  await page.locator('#wh-price-amount').fill('375.00');
  const field = await page.locator('#wh-price-amount').elementHandle();
  const requests = ledger.length;
  await toggle(page, 'packages').click();
  assert.equal(await page.locator('#wh-price-amount').isVisible(), false);
  await toggle(page, 'packages').press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id === 'wh-price-amount'), false);
  await toggle(page, 'packages').click();
  assert.equal(await page.locator('#wh-price-amount').inputValue(), '375.00');
  assert.equal(await field.evaluate(n => n.isConnected), true);
  assert.equal(ledger.length, requests, 'toggle issues no requests');
});

test('Edit Cancel successful Save tab entry and forced refresh retain independent section state', async t => {
  const { page, state } = await setup(t); state.response = 'success';
  await editPrice(page); await expanded(page, 'packages');
  await action(page, 'cancel').click(); await expanded(page, 'packages');
  await editPrice(page); await page.locator('#wh-price-amount').fill('375.00');
  await action(page, 'save-package-price').click();
  await page.locator('.wh-price-banner-ok').waitFor(); await expanded(page, 'packages');
  await open(page, 'extras');
  await page.evaluate(() => window.loadWolfhouseAdminPricing());
  await page.evaluate(() => window.loadWolfhouseAdminPricing({ force: true }));
  for (const key of keys) await expanded(page, key, ['packages', 'extras'].includes(key));
});

test('translated duplicate titles keep stable unique semantic controls and state', async t => {
  const { page } = await setup(t); await open(page, 'packages');
  await page.evaluate(() => { window.translated = true; window.__whPricingRenderForTest(); });
  for (const key of keys) {
    assert.equal(await toggle(page, key).count(), 1, `stable ${key} ID`);
    await expanded(page, key, key === 'packages');
  }
});

for (const response of ['reject', 'network']) test(`pending ${response} reopens owning editor and preserves rejected amount`, async t => {
  const { page, state } = await setup(t); state.response = response;
  await editPrice(page); await open(page, 'packages');
  await page.locator('#wh-price-amount').fill('0');
  await pending(page, state, 'save-package-price', 'packages');
  await expanded(page, 'packages');
  assert.equal(await page.locator('#wh-price-amount').isVisible(), true);
  assert.equal(await page.locator('#wh-price-amount').inputValue(), '0');
  await expanded(page, 'extras', false);
});

for (const [key, edit, save, input] of [
  ['seasons', 'new-season', 'save-season', '#wh-price-season-label'],
  ['rentals', 'new-item', 'save-new-item', '#wh-price-item-label'],
  ['services', 'new-item', 'save-new-item', '#wh-price-item-label'],
  ['transfers', 'new-transfer', 'save-transfer', '#wh-price-transfer-label'],
  ['extras', 'new-extra', 'save-new-extra', '#wh-price-item-label'],
]) test(`${key} rejected creation exposes editor after pending collapse`, async t => {
  const { page, state } = await setup(t); await open(page, key);
  await page.locator(`#wh-pricing-collapse-${key}`).locator('..').locator(`[data-wh-price-action="${edit}"]`).first().click();
  await open(page, key); await page.locator(input).fill('Synthetic unsaved');
  await pending(page, state, save, key);
  await expanded(page, key); assert.equal(await page.locator(input).isVisible(), true);
  assert.equal(await page.locator(input).inputValue(), 'Synthetic unsaved');
});

for (const [key, edit, save, input, amount] of [
  ['rentals', 'new-item', 'save-new-item', '#wh-price-item-label', '#wh-price-item-amount'],
  ['extras', 'new-extra', 'save-new-extra', '#wh-price-item-label', '#wh-price-item-amount'],
  ['transfers', 'new-transfer', 'save-transfer', '#wh-price-transfer-label', '#wh-price-transfer-amount'],
]) test(`${key} second-write rejection keeps editor and section visible`, async t => {
  const { page, state } = await setup(t); state.response = 'second-reject';
  await open(page, key);
  await page.locator(`#wh-pricing-collapse-${key}`).locator('..').locator(`[data-wh-price-action="${edit}"]`).first().click();
  await open(page, key); await page.locator(input).fill('Synthetic draft'); await page.locator(amount).fill('0');
  await pending(page, state, save, key);
  await expanded(page, key); assert.equal(await page.locator(input).isVisible(), true);
  assert.equal(await page.locator(input).inputValue(), 'Synthetic draft');
  assert.equal(await page.locator(amount).inputValue(), '0');
});

test('same context retains state but new authenticated context and reload reset it', async t => {
  const { page } = await setup(t); await editPrice(page); await open(page, 'packages');
  await page.evaluate(() => window.dispatchEvent(new Event('staff-disclosure-context')));
  await expanded(page, 'packages');
  await page.evaluate(() => { window.contextKey = 'sunset'; window.dispatchEvent(new Event('staff-disclosure-context')); });
  assert.equal(await page.locator('#wh-price-amount').count(), 0, 'old editor cleared immediately');
  await page.evaluate(() => { window.contextKey = 'wolfhouse-somo'; window.dispatchEvent(new Event('staff-disclosure-context')); return window.loadWolfhouseAdminPricing(); });
  for (const key of keys) await expanded(page, key, false);
  await open(page, 'packages'); await page.reload();
  await page.evaluate(() => window.loadWolfhouseAdminPricing());
  for (const key of keys) await expanded(page, key, false);
});

test('read-only disclosure cannot expose editing or issue mutations', async t => {
  const { page } = await setup(t, { writes: false });
  for (const key of keys) { await open(page, key); await expanded(page, key); }
  assert.equal(await page.locator('[data-wh-price-action]').count(), 0);
  assert.match(await page.locator('#wh-admin-pricing-body').innerText(), /Read-only/);
  assert.equal(ledger.filter(r => r.test === t.name && r.method !== 'GET').length, 0);
});

test('old-context delayed save cannot reopen or repopulate the new context', async t => {
  const { page, state } = await setup(t); await editPrice(page); await open(page, 'packages');
  state.hold = true;
  const request = page.waitForRequest(r => r.method() === 'PUT');
  await action(page, 'save-package-price').click(); await request;
  await page.evaluate(() => { window.contextKey = 'sunset'; window.dispatchEvent(new Event('staff-disclosure-context')); });
  const response = page.waitForResponse(r => r.request().method() === 'PUT');
  state.held(); await response;
  await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
  assert.equal(await page.locator('#wh-price-amount').count(), 0);
  assert.equal(await page.locator('.wh-price-banner-warn').count(), 0);
  await page.evaluate(() => { window.contextKey = 'wolfhouse-somo'; window.dispatchEvent(new Event('staff-disclosure-context')); return window.loadWolfhouseAdminPricing(); });
  await expanded(page, 'packages', false);
});
