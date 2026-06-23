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
    const r = await fetch('/staff/admin/config?client=sunset', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    return r.json();
  });
  console.log(JSON.stringify({ writes_enabled: cfg.writes_enabled, lesson_count: (cfg.lesson_times || []).length, pack_count: (cfg.surf_packs || []).length }, null, 2));
  await browser.close();
})();
