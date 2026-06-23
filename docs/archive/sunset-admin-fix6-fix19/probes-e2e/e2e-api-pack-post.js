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
  await page.waitForSelector('#admin-times-body');

  const result = await page.evaluate(async () => {
    const q = '?client=sunset&location=' + encodeURIComponent(typeof getSunsetLocation === 'function' ? getSunsetLocation() : 'sunset-somo');
    const payload = {
      label: 'API Direct Pack ' + Date.now(),
      age_band: '12_and_up',
      group_size: 16,
      beaches: ['el_sardinero'],
      weekly: 'mon_fri',
      schedules: ['0930_1130'],
      price_tiers: [
        { key: 'half_day', label: 'Half day', hours: 2, amount_cents: 4500 },
        { key: 'full_day', label: 'Full day', hours: 4, amount_cents: 8000 },
      ],
    };
    const r = await fetch('/staff/admin/config/surf-packs' + q, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  });
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
})();
