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
  await page.waitForSelector('[data-admin-action="save-new-pack"]');

  await page.evaluate(() => {
    const btn = document.querySelector('[data-admin-action="save-new-pack"]');
    btn.addEventListener('click', () => {
      const prefix = 'admin-new-pack';
      const startInput = document.getElementById(prefix + '-schedule-start');
      const endInput = document.getElementById(prefix + '-schedule-end');
      const re = new RegExp('^([01]\\d|2[0-3]):[0-5]\\d$');
      const sv = startInput && startInput.value;
      const ev = endInput && endInput.value;
      window.__packDiag = {
        startExists: !!startInput,
        sv, ev,
        st: re.test(String(sv || '').trim()),
        et: re.test(String(ev || '').trim()),
        msgEl: document.getElementById('admin-save-msg')?.textContent,
      };
    }, true);
  });

  await page.fill('#admin-new-pack-label', 'Diag Pack');
  await page.locator('[data-admin-action="save-new-pack"]').click();
  await page.waitForTimeout(500);
  const diag = await page.evaluate(() => ({
    clickDiag: window.__packDiag,
    msg: document.getElementById('admin-save-msg')?.textContent?.trim(),
    formGone: !document.getElementById('admin-new-pack-schedule-start'),
  }));
  console.log(JSON.stringify(diag, null, 2));
  await browser.close();
})();
