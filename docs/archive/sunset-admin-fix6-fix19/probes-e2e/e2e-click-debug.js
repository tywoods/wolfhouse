'use strict';
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
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

  const btnInfo = await page.evaluate(() => {
    const btn = document.querySelector('[data-admin-action="save-new-time"]');
    const closest = btn?.closest('[data-admin-action]');
    return {
      btnAction: btn?.getAttribute('data-admin-action'),
      closestAction: closest?.getAttribute('data-admin-action'),
      outer: btn?.outerHTML?.slice(0, 200),
      timeStartExists: !!document.getElementById('admin-time-start'),
      newTimeStartExists: !!document.getElementById('admin-new-time-start'),
    };
  });
  console.log('btnInfo', btnInfo);

  await page.evaluate(() => {
    const root = document.getElementById('tab-admin');
    root.addEventListener('click', function(ev) {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-admin-action]') : null;
      if (!btn) return;
      const action = btn.getAttribute('data-admin-action');
      if (action !== 'save-new-time' && action !== 'save-time') return;
      const startNew = document.getElementById('admin-new-time-start');
      const startEdit = document.getElementById('admin-time-start');
      window.__clickDebug = {
        action,
        startNew: startNew?.value,
        startEdit: startEdit?.value,
      };
    }, true);
  });

  await page.locator('[data-admin-action="save-new-time"]').click();
  await page.waitForTimeout(500);
  const debug = await page.evaluate(() => window.__clickDebug);
  const msg = await page.locator('#admin-save-msg').textContent().catch(() => '');
  console.log('clickDebug', debug);
  console.log('msg', msg?.trim());
  await browser.close();
})();
