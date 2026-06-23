'use strict';
const { chromium } = require('playwright');
const BASE = 'https://sunset-staging.lunafrontdesk.com';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const out = { errors: [] };

  await page.goto(`${BASE}/staff/login?client=sunset`);
  await page.fill('#email', 'tywoods@gmail.com');
  await page.fill('#password', 'SunsetStaging2026!');
  await page.click('#btn-signin');
  await page.waitForURL(/\/staff\/ui/);
  await page.locator('button.tab-btn[data-tab="admin"]').click();
  await page.locator('.staff-school-btn[data-school="sunset-somo"]').click();
  await page.waitForSelector('[data-admin-action="edit-pack"]', { timeout: 60000 });

  await page.locator('[data-admin-action="edit-pack"]').first().click();
  await page.waitForSelector('[data-admin-action="save-pack"]');
  const labelInput = page.locator('[id^="admin-pack-"][id$="-label"]').first();
  const newLabel = `Patched pack ${Date.now()}`;
  await labelInput.fill(newLabel);

  const patchPromise = page.waitForResponse((r) =>
    r.url().includes('/staff/admin/config/surf-packs/') && r.request().method() === 'PATCH',
  );
  await page.locator('[data-admin-action="save-pack"]').click();
  const patchResp = await patchPromise;
  out.patchStatus = patchResp.status();
  out.patchBody = await patchResp.json().catch(() => ({}));

  await page.waitForTimeout(2000);
  out.visibleLabel = (await page.locator('.portal-admin-pack-title').first().textContent())?.trim();

  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(out.patchStatus === 200 && out.patchBody.success ? 0 : 1);
})();
