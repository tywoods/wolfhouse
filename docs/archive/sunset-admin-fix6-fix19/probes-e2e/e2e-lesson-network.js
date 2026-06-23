'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  page.on('request', (r) => {
    if (r.url().includes('/staff/admin/config/lesson-times')) {
      requests.push({ method: r.method(), url: r.url(), body: r.postData() });
    }
  });
  page.on('response', async (r) => {
    if (r.url().includes('/staff/admin/config/lesson-times') && r.request().method() !== 'GET') {
      requests.push({ status: r.status(), body: await r.text().catch(() => '') });
    }
  });

  await page.goto('https://sunset-staging.lunafrontdesk.com/staff/login?client=sunset');
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForTimeout(3000);
  await page.locator('[data-admin-action="add-time"]').click();
  await page.waitForSelector('#admin-add-time-form');
  await page.fill('#admin-new-time-label', 'E2E New Lesson');
  await page.fill('#admin-new-time-start', '11:00');
  await page.fill('#admin-new-time-cost', '45.00');
  await page.locator('[data-admin-action="save-new-time"]').click();
  await page.waitForTimeout(3000);
  const msg = await page.locator('#admin-save-msg').textContent().catch(() => '');
  console.log('msg', msg?.trim());
  console.log('requests', JSON.stringify(requests, null, 2));
  await browser.close();
})();
