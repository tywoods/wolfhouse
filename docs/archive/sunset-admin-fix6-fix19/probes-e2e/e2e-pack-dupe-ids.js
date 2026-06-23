'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('#admin-new-pack-schedule-start');
  const dupes = await page.evaluate(() => {
    const ids = ['admin-new-pack-schedule-start', 'admin-new-pack-schedule-end', 'admin-new-pack-label'];
    return ids.map((id) => ({ id, count: document.querySelectorAll('#' + id).length, vals: Array.from(document.querySelectorAll('#' + id)).map((n) => n.value || n.textContent) }));
  });
  console.log(JSON.stringify(dupes, null, 2));
  await browser.close();
})();
