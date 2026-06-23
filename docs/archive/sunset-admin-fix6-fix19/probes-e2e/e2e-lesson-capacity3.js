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

  const cfg = await page.evaluate(async () => {
    const r = await fetch('/staff/admin/config?client=sunset&location=sunset-sardinero', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.json();
  });

  const patches = [];
  page.on('response', async (res) => {
    if (res.url().includes('/staff/admin/config/lesson-times/') && res.request().method() === 'PATCH') {
      patches.push({ status: res.status(), req: JSON.parse(res.request().postData() || '{}'), body: (await res.text()).slice(0, 400) });
    }
  });

  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-sardinero"]').click();
  await page.waitForSelector('[data-admin-action="edit-time"]', { timeout: 60000 });
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('#admin-time-capacity');

  const form = {
    start: await page.inputValue('#admin-time-start'),
    end: await page.inputValue('#admin-time-end'),
    capacity: await page.inputValue('#admin-time-capacity'),
  };

  // Save without changing capacity
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(3000);

  console.log(JSON.stringify({ lesson: cfg.lesson_times && cfg.lesson_times[0], form, patches, msg: (await page.locator('#admin-save-msg').textContent())?.trim() }, null, 2));
  await browser.close();
})();
