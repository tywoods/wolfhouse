'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const reqs = [];
  page.on('request', (r) => {
    if (r.url().includes('/staff/admin/config')) reqs.push({ method: r.method(), url: r.url() });
  });

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('[data-admin-action="add-pack"]');
  await page.locator('[data-admin-action="add-pack"]').click();
  await page.waitForSelector('#admin-new-pack-schedule-start');

  const beforeClick = await page.evaluate(() => ({
    start: document.getElementById('admin-new-pack-schedule-start')?.value,
    end: document.getElementById('admin-new-pack-schedule-end')?.value,
    form: !!document.querySelector('[data-admin-pack-form="new"]'),
  }));

  await page.fill('#admin-new-pack-label', 'E2E Pack Debug');
  await page.locator('[data-admin-action="save-new-pack"]').click();
  await page.waitForTimeout(1500);

  const after = {
    beforeClick,
    msg: (await page.locator('#admin-save-msg').textContent())?.trim(),
    reqs,
  };
  console.log(JSON.stringify(after, null, 2));
  await browser.close();
})();
