'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

async function saveLesson(page, label) {
  const patches = [];
  page.on('response', async (res) => {
    if (res.url().includes('/staff/admin/config/lesson-times/') && res.request().method() === 'PATCH') {
      patches.push({ status: res.status(), req: JSON.parse(res.request().postData() || '{}'), body: (await res.text()).slice(0, 300) });
    }
  });
  await page.locator('[data-admin-action="save-time"]').click();
  await page.waitForTimeout(3000);
  const msg = (await page.locator('#admin-save-msg').textContent())?.trim();
  return { label, msg, patches };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
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

  const form = {
    label: await page.inputValue('#admin-time-label'),
    start: await page.inputValue('#admin-time-start'),
    end: await page.inputValue('#admin-time-end'),
    capacity: await page.inputValue('#admin-time-capacity'),
    cost: await page.inputValue('#admin-time-cost'),
  };

  const r1 = await saveLesson(page, 'unchanged');
  await page.locator('[data-admin-action="edit-time"]').first().click();
  await page.waitForSelector('#admin-time-capacity');
  await page.fill('#admin-time-capacity', String(Number(form.capacity || 8) + 1));
  const r2 = await saveLesson(page, 'capacity+1');

  console.log(JSON.stringify({ form, r1, r2 }, null, 2));
  await browser.close();
})();
