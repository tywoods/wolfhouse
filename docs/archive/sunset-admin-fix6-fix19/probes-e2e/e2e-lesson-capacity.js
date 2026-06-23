'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { patches: [] };

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/staff/admin/config/lesson-times/') && res.request().method() === 'PATCH') {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      out.patches.push({ status: res.status(), body: body.slice(0, 500), req: res.request().postData() });
    }
  });

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });

  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('#admin-time-capacity');
  await page.fill('#admin-time-capacity', '26');
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(4000);

  out.msg = (await page.locator('#admin-save-msg').textContent())?.catch?.() || (await page.locator('#admin-save-msg').textContent())?.trim?.();
  try { out.msg = (await page.locator('#admin-save-msg').textContent())?.trim(); } catch (_) {}

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})();
