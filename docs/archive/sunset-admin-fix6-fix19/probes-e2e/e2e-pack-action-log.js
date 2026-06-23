'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const actions = [];
  await page.exposeFunction('logAction', (a) => actions.push(a));

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.waitForSelector('[data-admin-action="add-pack"]');

  await page.evaluate(() => {
    document.getElementById('tab-admin').addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;
      if (btn) window.logAction(btn.getAttribute('data-admin-action'));
    }, true);
  });

  await page.locator('[data-admin-action="add-pack"]').click();
  await page.fill('#admin-new-pack-label', 'Action Log Pack');
  await page.locator('[data-admin-action="save-new-pack"]').click();
  await page.waitForTimeout(1000);

  console.log(JSON.stringify({
    actions,
    msg: (await page.locator('#admin-save-msg').textContent())?.trim(),
    saveNewTimeCount: await page.locator('[data-admin-action="save-new-time"]').count(),
    saveNewPackCount: await page.locator('[data-admin-action="save-new-pack"]').count(),
  }, null, 2));
  await browser.close();
})();
