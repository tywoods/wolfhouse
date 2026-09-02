'use strict';

/** Generated /staff/ui browser regression for Group Course Save feedback. */
process.env.STAFF_AUTH_REQUIRED = 'false';
process.env.STAFF_AUTH_ALLOW_OPEN = 'true';
process.env.NODE_ENV = 'test';
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/data/pw-browsers';

const assert = require('assert');
const fs = require('fs');
function playwright() {
  try { return require('playwright'); }
  catch (_err) { return require('/opt/data/pw/node_modules/playwright'); }
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

(async () => {
  const { createSunsetAdminVerifyServer } = require('./fixtures/sunset-admin-verify-server');
  const server = createSunsetAdminVerifyServer();
  const base = await listen(server);
  const localChromium = '/opt/data/pw-browsers/chromium_headless_shell-1187/chrome-linux/headless_shell';
  const launchOptions = { headless: true };
  if (fs.existsSync(localChromium)) launchOptions.executablePath = localChromium;
  const browser = await playwright().chromium.launch(launchOptions);
  const page = await browser.newPage();
  const saveRequests = [];
  const pack = {
    pack_id: 'save-feedback-pack', label: 'Group Course', age_band: '12_and_up',
    group_size: 8, beaches: ['somo'], weekly: 'mon_fri', schedules: ['0930_1130'],
    price_tiers: [], equipment_options: [],
  };
  await page.addInitScript(() => {
    localStorage.setItem('staff_portal_client', 'sunset');
    localStorage.setItem('staff_portal_sunset_location', 'sunset-somo');
    localStorage.setItem('wh_staff_portal_locale', 'en');
  });
  await page.route('**/staff/admin/config?**', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.surf_packs = [pack];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/staff/admin/config/surf-packs/save-feedback-pack?**', route => {
    saveRequests.push({
      method: route.request().method(),
      body: JSON.parse(route.request().postData()),
    });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, surf_pack: pack }) });
  });

  try {
    await page.goto(`${base}/staff/ui`);
    await page.waitForFunction(() => document.querySelector('#c-client')?.value === 'sunset');
    await page.locator('button[data-tab="admin"]').click();
    await page.locator('#admin-tab-pricing').click();
    await page.locator('[data-admin-pack-card="save-feedback-pack"] [data-admin-action="edit-pack"]').click();

    const save = page.locator('[data-admin-action="save-pack"]');
    await page.locator('#admin-pack-save-feedback-pack-group-size').fill('0');
    assert.strictEqual(await save.isEnabled(), true, 'invalid Save remains actionable so it can provide feedback');
    await save.click();
    const feedback = page.locator('#admin-save-msg');
    await assert.doesNotReject(() => feedback.waitFor({ state: 'visible', timeout: 1000 }), 'invalid Save shows immediate action-area feedback');
    assert.ok((await feedback.innerText()).trim().length > 0, 'invalid Save feedback is non-empty');
    assert.strictEqual(saveRequests.length, 0, 'invalid Save sends zero save requests');

    await page.locator('#admin-pack-save-feedback-pack-group-size').fill('8');
    await save.click();
    await page.waitForFunction(() => document.querySelector('#admin-save-msg')?.classList.contains('success'));
    assert.strictEqual(saveRequests.length, 1, 'valid Save sends exactly one save request');
    assert.strictEqual(saveRequests[0].method, 'PATCH', 'valid existing-course Save uses PATCH');
    assert.ok((await feedback.innerText()).trim().length > 0, 'valid Save yields action-area feedback');
    console.log('PASS generated /staff/ui Group Course Save feedback browser regression');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(err => { console.error(err); process.exit(1); });
