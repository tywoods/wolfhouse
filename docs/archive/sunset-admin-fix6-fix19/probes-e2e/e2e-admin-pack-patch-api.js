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
  await page.locator('.staff-school-btn[data-school="sunset-somo"]').click();
  await page.waitForTimeout(5000);

  const cfg = await page.evaluate(async () => {
    const res = await fetch('/staff/admin/config?client=sunset&location=sunset-somo', { credentials: 'same-origin' });
    return res.json();
  });
  const pack = (cfg.surf_packs || [])[0];
  if (!pack) throw new Error('no pack');

  const patchRes = await page.evaluate(async ({ packId, label, packData }) => {
    const res = await fetch('/staff/admin/config/surf-packs/' + encodeURIComponent(packId) + '?client=sunset&location=sunset-somo', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        label,
        age_band: packData.age_band || '12_and_up',
        group_size: packData.group_size || 16,
        beaches: packData.beaches || ['somo'],
        weekly: packData.weekly || 'mon_fri',
        schedules: packData.schedules || ['0930_1130'],
        price_tiers: packData.price_tiers,
      }),
    });
    return { status: res.status, body: await res.json() };
  }, { packId: pack.pack_id, label: 'API patched ' + Date.now(), packData: pack });

  console.log(JSON.stringify({ packId: pack.pack_id, patchRes }, null, 2));
  await browser.close();
  process.exit(patchRes.status === 200 && patchRes.body.success ? 0 : 1);
})();
