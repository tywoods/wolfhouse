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
  await page.waitForSelector('[data-admin-action="add-pack"]');
  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('#admin-new-pack-schedule-start');
  const info = await page.evaluate(() => {
    const start = document.getElementById('admin-new-pack-schedule-start');
    const end = document.getElementById('admin-new-pack-schedule-end');
    const re = new RegExp('^([01]\\d|2[0-3]):[0-5]\\d$');
    const sv = start ? start.value : null;
    const ev = end ? end.value : null;
    return {
      sv, ev,
      st: re.test(String(sv || '').trim()),
      et: re.test(String(ev || '').trim()),
      allStarts: Array.from(document.querySelectorAll('[id$="-schedule-start"]')).map((n) => ({ id: n.id, v: n.value })),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
